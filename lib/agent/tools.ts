import { tool } from 'ai';
import { z } from 'zod';
import { fillFormRegions } from '@/lib/api/client';
import type { FormFieldValue } from '@/lib/api/types';
import { buildFieldLocators, buildPageContext, formGraphToFactPayload, type FieldLocator } from '@/lib/fill/map-fields';
import { MessageType } from '@/lib/messaging/types';
import { sendToFrame, ensureContentScripts } from '@/lib/messaging/send';
import type {
  ActivateAction,
  ActivateResponse,
  DescribeRegionResponse,
  OpenOptionsResponse,
  ReadElementDetailResponse,
  SnapshotFormResponse,
  VerifyAppliedResponse,
  RevealAllResponse,
  WaitStableResponse,
} from '@/lib/messaging/types';
import { emptyFormGraph, diffFragments, mergeFragmentIntoGraph, tagGatedRegions } from '@/lib/formgraph/merge';
import { makeControlKey } from '@/lib/formgraph/trace';
import type {
  FormGraph,
  FormGraphFragment,
  FrameNode,
  InteractiveNode,
  PanelNode,
} from '@/lib/formgraph/types';
import { slog, swarn } from '@/lib/log';

export type FrameProbe = {
  frameId: number;
  url: string;
  title: string;
  total: number;
  visibleHint: number;
};

/** 危险操作黑名单：即使 Agent 想点，activate 也硬拒绝（不依赖 prompt 自律） */
const DANGEROUS_LABEL_RE = /提交|删除|清空|重置|退出登录|logout|delete|remove\b|submit\b|reset\b/i;
const MAX_ACTIVATE_BUDGET = 20;

export type AgentToolContext = {
  tabId: number;
  /** 累积式 FormGraph：每次 snapshotForm 只覆盖对应 (frame, panel)，其余分片保留 */
  formGraph: FormGraph;
  /** 上一次快照，按 `frameId::panelKey` 分片存，diff 才是"同一面板内的变化" */
  lastFragmentByScope: Map<string, FormGraphFragment>;
  /** 最近一次 activate 的取值型目标（radio/checkbox/select），供下次 snapshotForm 后打 gatedBy */
  lastActivated: { fieldId: string; label: string; value?: string } | null;
  /** 代码侧记录的已激活目标 id；快照会重建 interactives，激活状态只能靠它回填 */
  activatedIds: Set<string>;
  /** 最近一次 activate 的目标 id：DOM 认不出激活面板时用它兜底归属 */
  lastActivatedId: string | null;
  activateBudgetUsed: number;
  /** 由 FormGraph 确定性派生的回填定位表 */
  locators: FieldLocator[];
  /** 后端返回、等待写回的值；不经过 LLM 转手 */
  pendingValues: Record<string, FormFieldValue>;
  lastPageContext: string;
  lastApply?: {
    filled: string[];
    skipped: Array<{ id: string; reason: string }>;
    lowConfidence: string[];
    verified: number;
    reverted: number;
  };
  lastFrames?: FrameProbe[];
  preferredKnowledgeIds?: string[];
};

export function createAgentToolContext(tabId: number): AgentToolContext {
  return {
    tabId,
    formGraph: emptyFormGraph({ kind: 'web', capturedAt: new Date().toISOString() }),
    lastFragmentByScope: new Map(),
    lastActivated: null,
    activatedIds: new Set(),
    lastActivatedId: null,
    activateBudgetUsed: 0,
    locators: [],
    pendingValues: {},
    lastPageContext: '',
  };
}

async function probeAllFrames(tabId: number): Promise<FrameProbe[]> {
  await ensureContentScripts(tabId);
  const injected = await browser.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: () => {
      const all = document.querySelectorAll('input,select,textarea');
      let visibleHint = 0;
      for (const el of all) {
        if (el instanceof HTMLInputElement) {
          const t = el.type;
          if (t === 'hidden' || t === 'submit' || t === 'button' || t === 'reset') continue;
        }
        const r = el.getBoundingClientRect();
        if (r.width > 2 && r.height > 2) visibleHint += 1;
      }
      return { url: location.href, title: document.title, total: all.length, visibleHint };
    },
  });

  return injected
    .filter((r) => r.result != null)
    .map((r) => ({
      frameId: r.frameId,
      url: r.result!.url,
      title: r.result!.title,
      total: r.result!.total,
      visibleHint: r.result!.visibleHint,
    }))
    .sort((a, b) => b.visibleHint - a.visibleHint || b.total - a.total);
}

function pickBestFrame(frames: FrameProbe[]): FrameProbe | undefined {
  return frames.find((f) => f.visibleHint > 0) || frames[0];
}

/** 探索提示：面板优先——面板没抽完，字段就不完整，其它自检都没意义 */
function buildSnapshotTip(pendingPanels: PanelNode[], interactives: InteractiveNode[]): string {
  if (pendingPanels.length) {
    const names = pendingPanels.map((p) => p.label).join('、');
    return `还有 ${pendingPanels.length} 个面板没抽过：${names}。逐个 activate 对应的 tab 再 snapshotForm，字段会累加进图（切面板不会覆盖已抽的）。判断某个面板不该进（页面级导航、只读记录）时可以跳过，但要说明理由。`;
  }
  const pending = interactives.filter((i) => i.status === 'pending');
  if (pending.length) {
    return `面板已抽完。还剩 ${pending.length} 个待探索交互（add-button/gate-candidate/accordion），值得 activate 后再 snapshotForm 看是否揭示新字段。`;
  }
  return '面板与交互都已探索完。若字段数仍明显偏少，可用 describeRegion 检查具体区域，或 probeFrames 换 frame。';
}

/** 在已知 FormGraph 里按 id 反查所属 frame（field/region/interactive 通用） */
function findFrameIdForTarget(ctx: AgentToolContext, targetId: string): number | undefined {
  const field = ctx.formGraph.fields.find((f) => f.fieldId === targetId);
  if (field) return field.frameId;
  const region = ctx.formGraph.regions.find((r) => r.regionId === targetId);
  if (region) return region.frameId;
  const interactive = ctx.formGraph.interactives.find((i) => i.interactiveId === targetId);
  if (interactive) return interactive.frameId;
  return undefined;
}

export function createSnapfillTools(ctx: AgentToolContext) {
  return {
    probeFrames: tool({
      description:
        '【感知】探测当前标签页所有 frame/iframe 的 URL 与控件数量。当顶层 snapshotForm 抽到 0 字段、或怀疑表单在 iframe 内时必须先调用。返回按可见控件数排序的 frames[]（含 frameId）。',
      inputSchema: z.object({
        reason: z.string().optional().describe('为何探测，便于自检'),
      }),
      execute: async ({ reason }) => {
        const frames = await probeAllFrames(ctx.tabId);
        ctx.lastFrames = frames;
        const best = pickBestFrame(frames);
        slog('agent', `probeFrames n=${frames.length} best=${best?.frameId} visible=${best?.visibleHint} reason=${reason || ''}`);
        return {
          ok: true as const,
          frameCount: frames.length,
          frames,
          tip: best
            ? `建议优先对 frameId=${best.frameId}（visibleHint=${best.visibleHint}）调用 snapshotForm`
            : '未发现可用 frame，请确认页面已加载且非 chrome://',
        };
      },
    }),

    snapshotForm: tool({
      description:
        '【感知】核心工具：对指定 frame 做结构化空间抽取，产出 FormGraph 片段（regions/fields/interactives/unresolved/metrics）并累加进全局 FormGraph。' +
        '累加按 (frame, 面板) 分片：切到别的 tab 再抽不会覆盖先前面板抽到的字段，放心逐个面板抽。' +
        '省略 frameId 时自动选可见控件最多的 frame。会自动与同一面板的上一次快照做 diff：刚 activate 过开关/添加按钮时，这里能看到新增的 regions/fields。' +
        '返回的 panelsPending 是这个 frame 里还没抽过的面板清单。',
      inputSchema: z.object({
        frameId: z.number().int().optional().describe('目标 frame；省略则自动选可见控件最多的'),
        note: z.string().optional().describe('步骤/页签备注，写入 page_context'),
        maxFields: z.number().int().min(1).max(1000).optional(),
      }),
      execute: async ({ frameId, note, maxFields }) => {
        let targetId = frameId;
        if (targetId == null) {
          const frames = await probeAllFrames(ctx.tabId);
          ctx.lastFrames = frames;
          const best = pickBestFrame(frames);
          if (!best) {
            return { ok: false as const, message: '无法探测到任何 frame', fieldCount: 0 };
          }
          targetId = best.frameId;
        }

        const res = await sendToFrame<SnapshotFormResponse>(ctx.tabId, targetId, {
          type: MessageType.SNAPSHOT_FORM,
          maxFields: maxFields ?? 500,
        });

        if (!res?.ok) {
          return {
            ok: false as const,
            message: (res as { error?: string })?.error || `frameId=${targetId} snapshotForm 失败`,
            frameId: targetId,
            tip: '可 probeFrames 后换 frameId 重试',
          };
        }

        const fragment = res.fragment;
        // content script 不知道自己的 frameId，这里由 background 统一回填
        fragment.frameId = targetId;
        for (const f of fragment.fields) {
          f.frameId = targetId;
          f.locator.frameId = targetId;
        }
        for (const r of fragment.regions) r.frameId = targetId;
        for (const it of fragment.interactives) it.frameId = targetId;
        for (const t of fragment.texts ?? []) t.frameId = targetId;

        // DOM 认不出激活态（自定义 tab 组件）时，用代码记录的上一次激活目标兜底归属，
        // 否则所有面板会挤进同一个 panelKey='' 分片，互相覆盖。
        if (!fragment.panel && ctx.lastActivatedId) {
          const hit = fragment.panels.find((p) => p.key === ctx.lastActivatedId);
          if (hit) {
            fragment.panel = hit;
            for (const f of fragment.fields) f.panelKey = hit.key;
            for (const r of fragment.regions) r.panelKey = hit.key;
            for (const t of fragment.texts ?? []) t.panelKey = hit.key;
          }
        }

        const scope = `${targetId}::${fragment.panel?.key ?? ''}`;
        const prevFragment = ctx.lastFragmentByScope.get(scope);
        const diff = diffFragments(prevFragment, fragment);
        const tagged = tagGatedRegions(fragment, diff, ctx.lastActivated);
        ctx.lastFragmentByScope.set(scope, tagged);
        ctx.lastActivated = null;

        const frameProbe = ctx.lastFrames?.find((f) => f.frameId === targetId);
        const frameMeta: FrameNode = {
          frameId: targetId,
          parentFrameId: null,
          url: frameProbe?.url ?? '',
          title: frameProbe?.title ?? '',
          crossOrigin: false,
          pageOffset: null,
          totalControls: frameProbe?.total ?? tagged.metrics.controlsSeen,
          visibleControls: frameProbe?.visibleHint ?? tagged.fields.length,
        };
        ctx.formGraph = mergeFragmentIntoGraph(ctx.formGraph, tagged, {
          frameMeta,
          activatedIds: ctx.activatedIds,
        });
        ctx.locators = buildFieldLocators(ctx.formGraph.fields).locators;
        const panelLabel = tagged.panel?.label ?? '';
        ctx.lastPageContext =
          (note?.trim() ? `${note.trim()} · ` : '') +
          (panelLabel ? `${panelLabel} · ` : '') +
          buildPageContext({ title: frameMeta.title, url: frameMeta.url }) +
          ` · frame=${targetId}`;

        const pendingPanels = ctx.formGraph.panels.filter((p) => p.frameId === targetId && !p.captured);
        slog(
          'agent',
          `snapshotForm frame=${targetId} panel="${panelLabel}" fields=${tagged.fields.length} 累积=${ctx.formGraph.fields.length} 待抽面板=${pendingPanels.length} added=${diff.addedFieldIds.length}`,
        );

        return {
          ok: true as const,
          frameId: targetId,
          fieldCount: tagged.fields.length,
          regionCount: tagged.regions.length,
          page_context: ctx.lastPageContext,
          metrics: tagged.metrics,
          diffSinceLastSnapshot: prevFragment
            ? { addedFields: diff.addedFieldIds.length, removedFields: diff.removedFieldIds.length, addedRegions: diff.addedRegionIds }
            : null,
          regions: tagged.regions.map((r) => ({
            regionId: r.regionId,
            kind: r.kind,
            name: r.name,
            chain: r.chain,
            fieldCount: r.fieldIds.length,
            repeat: r.repeat ? { rowCount: r.repeat.rowCount, addTargetLabel: r.repeat.addTargetLabel } : undefined,
            gatedBy: r.gatedBy,
          })),
          // 用累积图里的交互（状态已按"抽过的面板 + 激活记录"确定性回填），
          // 片段里的 status 每次快照都会重建成 pending，据此判断会重复点击
          interactives: ctx.formGraph.interactives
            .filter((i) => i.frameId === targetId)
            .map((i) => ({
              interactiveId: i.interactiveId,
              kind: i.kind,
              label: i.label,
              status: i.status,
              relatedRegionId: i.relatedRegionId,
            })),
          unresolved: tagged.unresolved,
          panel: tagged.panel,
          panelsPending: pendingPanels.map((p) => ({ key: p.key, label: p.label })),
          totalFieldsAcrossFrames: ctx.formGraph.fields.length,
          tip: buildSnapshotTip(pendingPanels, ctx.formGraph.interactives.filter((i) => i.frameId === targetId)),
        };
      },
    }),

    revealAll: tool({
      description:
        '【感知】滚过整页与页面内部的滚动容器，触发懒加载/虚拟滚动的延迟渲染，然后恢复原来的滚动位置。' +
        '返回滚动前后的可填控件数。controlsAfter > controlsBefore 说明这一页是懒渲染的，必须再 snapshotForm 一次才算抽全。' +
        '适用场景：长表单只抽到开头一部分、字段数明显少于页面观感、或列表类区域只有一两行。',
      inputSchema: z.object({
        frameId: z.number().optional().describe('省略则用上次 snapshotForm 的 frame'),
      }),
      execute: async ({ frameId }) => {
        let target = frameId;
        if (target == null) {
          const frames = ctx.lastFrames ?? (await probeAllFrames(ctx.tabId));
          ctx.lastFrames = frames;
          target = pickBestFrame(frames)?.frameId;
          if (target == null) return { ok: false as const, error: '无法探测到任何 frame' };
        }
        const res = await sendToFrame<RevealAllResponse>(ctx.tabId, target, {
          type: MessageType.REVEAL_ALL,
        });
        if (!res.ok) return res;
        const grew = res.controlsAfter > res.controlsBefore;
        slog('agent', `revealAll frame=${target} ${res.controlsBefore}→${res.controlsAfter}`);
        return {
          ...res,
          tip: grew
            ? `滚动后多出 ${res.controlsAfter - res.controlsBefore} 个控件，请对 frameId=${target} 重新 snapshotForm`
            : '控件数没变化，页面不是懒渲染的，不必重复调用',
        };
      },
    }),

    describeRegion: tool({
      description: '【感知】查看某个 region 的详细字段列表（含隐藏模板列结构、重复块行数、门控信息）。用于在 snapshotForm 给出的摘要不够时深挖细节。',
      inputSchema: z.object({ regionId: z.string() }),
      execute: async ({ regionId }) => {
        const frameId = findFrameIdForTarget(ctx, regionId);
        if (frameId == null) return { ok: false as const, error: `未知 regionId=${regionId}，请先 snapshotForm` };
        const res = await sendToFrame<DescribeRegionResponse>(ctx.tabId, frameId, {
          type: MessageType.DESCRIBE_REGION,
          regionId,
        });
        return res;
      },
    }),

    readElementDetail: tool({
      description: '【感知】读取某个字段/交互元素的底层 DOM 细节（computed style、value、pattern/min/max、aria-describedby 说明文字）。用于排查"为什么这个字段填不进去"或判断控件真实语义。',
      inputSchema: z.object({ targetId: z.string().describe('fieldId 或 interactiveId') }),
      execute: async ({ targetId }) => {
        const frameId = findFrameIdForTarget(ctx, targetId);
        if (frameId == null) return { ok: false as const, error: `未知 targetId=${targetId}，请先 snapshotForm` };
        const res = await sendToFrame<ReadElementDetailResponse>(ctx.tabId, frameId, {
          type: MessageType.READ_ELEMENT_DETAIL,
          targetId,
        });
        return res;
      },
    }),

    activate: tool({
      description:
        '【行动】激活一个交互目标：点击"添加"按钮揭示重复行、切换 tab/accordion 查看隐藏面板、勾选可能的门控 radio/checkbox 查看联动区域。' +
        '内建等待：执行后会自动等 DOM 稳定再返回。执行后必须重新调用 snapshotForm（同一 frameId）才能看到新增字段——diffSinceLastSnapshot 会自动标出新增内容。' +
        `每个会话最多 activate ${MAX_ACTIVATE_BUDGET} 次，避免无限点击；提交/删除/重置类按钮会被硬拒绝，不需要你自我克制。`,
      inputSchema: z.object({
        targetId: z.string().describe('fieldId 或 interactiveId'),
        action: z.enum(['click', 'focus', 'hover', 'scrollIntoView', 'check', 'uncheck']).default('click'),
      }),
      execute: async ({ targetId, action }) => {
        if (ctx.activateBudgetUsed >= MAX_ACTIVATE_BUDGET) {
          return { ok: false as const, error: `已达 activate 预算上限（${MAX_ACTIVATE_BUDGET}），请基于已有信息汇报` };
        }
        const field = ctx.formGraph.fields.find((f) => f.fieldId === targetId);
        const interactive = ctx.formGraph.interactives.find((i) => i.interactiveId === targetId);
        const label = field?.label || interactive?.label || '';
        if (DANGEROUS_LABEL_RE.test(label)) {
          return { ok: false as const, error: `目标"${label}"命中危险操作黑名单（提交/删除/重置类），已拒绝执行` };
        }

        const frameId = findFrameIdForTarget(ctx, targetId);
        if (frameId == null) return { ok: false as const, error: `未知 targetId=${targetId}，请先 snapshotForm` };

        ctx.activateBudgetUsed += 1;
        const res = await sendToFrame<ActivateResponse>(ctx.tabId, frameId, {
          type: MessageType.ACTIVATE,
          targetId,
          action: action as ActivateAction,
        });
        if (!res?.ok) return res;

        await sendToFrame<WaitStableResponse>(ctx.tabId, frameId, {
          type: MessageType.WAIT_STABLE,
          maxMs: 2500,
          quietMs: 350,
        }).catch(() => undefined);

        ctx.activatedIds.add(targetId);
        ctx.lastActivatedId = targetId;
        if (interactive?.kind === 'gate-candidate' && interactive.suggestedValue) {
          ctx.lastActivated = { fieldId: targetId, label, value: interactive.suggestedValue };
        } else if (field && ['radio', 'checkbox', 'select'].includes(field.control.type)) {
          ctx.lastActivated = { fieldId: targetId, label, value: (field.existingValue as string) || 'checked' };
        }

        slog('agent', `activate ${action} target=${targetId} frame=${frameId} budget=${ctx.activateBudgetUsed}/${MAX_ACTIVATE_BUDGET}`);
        return {
          ...res,
          budgetRemaining: MAX_ACTIVATE_BUDGET - ctx.activateBudgetUsed,
          tip: `已等待 DOM 稳定，请对 frameId=${frameId} 重新调用 snapshotForm 查看 diffSinceLastSnapshot`,
        };
      },
    }),

    openOptions: tool({
      description: '【行动】展开一个下拉/组合框控件并采集其可见选项（原生 select 直接读 options；组件库下拉会短暂点击展开后采集再收起）。用于 select/组件库控件的 options 为空时补全。',
      inputSchema: z.object({ targetId: z.string() }),
      execute: async ({ targetId }) => {
        const frameId = findFrameIdForTarget(ctx, targetId);
        if (frameId == null) return { ok: false as const, error: `未知 targetId=${targetId}，请先 snapshotForm` };
        const res = await sendToFrame<OpenOptionsResponse>(ctx.tabId, frameId, {
          type: MessageType.OPEN_OPTIONS,
          targetId,
        });
        return res;
      },
    }),

    getExtractionReport: tool({
      description:
        '【观察】汇总当前全局 FormGraph 的抽取质量指标（覆盖率/标签置信率/区域数/待激活交互数/无法解析项）、面板抽取进度，并按 control_no 列出低置信度的控件清单——这些就是"控件和题干可能没配对"的嫌疑项。不产生任何 DOM 操作。用于决定是否已探索充分、可以进入提交阶段。',
      inputSchema: z.object({}),
      execute: async () => {
        const g = ctx.formGraph;
        const keyOf = makeControlKey(g);
        const suspicious = g.fields
          .filter((f) => f.labelConfidence !== 'high' || !f.label)
          .slice(0, 30)
          .map((f) => ({
            control: keyOf(f),
            label: f.label || f.nearLabel || '(空)',
            labelSource: f.labelSource,
            regionId: f.regionId,
          }));
        return {
          metrics: g.metrics,
          frames: g.frames.map((f) => ({ frameId: f.frameId, url: f.url, visibleControls: f.visibleControls })),
          panels: g.panels.map((p) => ({ label: p.label, frameId: p.frameId, captured: p.captured })),
          regions: g.regions.map((r) => ({ regionId: r.regionId, kind: r.kind, name: r.name, fieldCount: r.fieldIds.length })),
          lowConfidenceControls: suspicious,
          pendingInteractives: g.interactives
            .filter((i) => i.status === 'pending')
            .map((i) => ({ interactiveId: i.interactiveId, kind: i.kind, label: i.label })),
          unresolved: g.unresolved.slice(0, 10),
        };
      },
    }),

    commitFormGraph: tool({
      description:
        '【提交】把当前累积 FormGraph 的事实层（controls + texts + structure）交给后端做题干关联、检索与填值。' +
        '字段清单由系统确定性生成，你不需要也不能自己重建；知识库由侧栏勾选注入。返回填值摘要，具体值由 applyValues 写回。',
      inputSchema: z.object({
        regionIds: z.array(z.string()).optional().describe('只提交指定区域；省略则提交全部'),
        profile_id: z.string().nullable().optional(),
      }),
      execute: async ({ regionIds, profile_id }) => {
        const { payload, locators, excluded } = formGraphToFactPayload(ctx.formGraph, {
          regionIds,
          pageContext: ctx.lastPageContext || undefined,
        });
        if (!payload.controls.length && !payload.structure.regions.some((r) => r.kind === 'repeat_group')) {
          throw new Error('没有可提交的字段，请先 snapshotForm');
        }
        ctx.locators = buildFieldLocators(ctx.formGraph.fields).locators;

        const data = await fillFormRegions({
          ...payload,
          knowledge_file_ids: ctx.preferredKnowledgeIds,
          page_context: ctx.lastPageContext || payload.page_context || null,
          profile_id: profile_id ?? null,
        });

        ctx.pendingValues = data.values;
        const controlKey = makeControlKey(ctx.formGraph);
        const labelOf = new Map(ctx.formGraph.fields.map((f) => [f.fieldId, controlKey(f)]));
        const filled = Object.entries(data.values).filter(([, v]) => Boolean(v.value?.trim()));
        slog(
          'agent',
          `commitFormGraph task=${data.task_id} controls=${payload.controls.length} texts=${payload.texts.length} filled=${filled.length}`,
        );

        return {
          ok: true as const,
          task_id: data.task_id,
          submittedCount: payload.controls.length,
          textCount: payload.texts.length,
          regionCount: payload.structure.regions.length,
          filledCount: filled.length,
          unfilledCount: data.unfilled.length,
          skippedByRoute: excluded.map((f) => ({ control: controlKey(f), label: f.label, route: f.routeHint })),
          lowConfidence: filled
            .filter(([, v]) => v.confidence === 'low')
            .map(([id]) => labelOf.get(id) ?? id),
          locatorsReady: locators.length,
          tip: '调用 applyValues 写回（值已在系统侧暂存，无需你传参）',
        };
      },
    }),

    applyValues: tool({
      description:
        '【回填】把 commitFormGraph 暂存的后端值写回 DOM。按 locator.frameId 定向到对应 iframe；仅写入非空值；写入后自动回读校验（verified/reverted/mismatch），暴露真实成功率而非"写了就算成功"。',
      inputSchema: z.object({
        fieldIds: z.array(z.string()).optional().describe('只写回指定字段；省略则写回全部暂存值'),
      }),
      execute: async ({ fieldIds }) => {
        if (!ctx.locators.length) throw new Error('缺少字段定位表，请先 snapshotForm');
        const pending = Object.entries(ctx.pendingValues).filter(
          ([id, v]) => Boolean(v.value?.trim()) && (!fieldIds?.length || fieldIds.includes(id)),
        );
        if (!pending.length) throw new Error('没有待写回的值，请先 commitFormGraph');
        const values = Object.fromEntries(pending);

        const byFrame = new Map<number | 'top', FieldLocator[]>();
        for (const loc of ctx.locators) {
          const key = loc.frameId ?? 'top';
          if (!byFrame.has(key)) byFrame.set(key, []);
          byFrame.get(key)!.push(loc);
        }

        const filled: string[] = [];
        const skipped: Array<{ id: string; reason: string }> = [];
        const lowConfidence: string[] = [];
        const verifyResults: Record<string, string> = {};

        for (const [key, locs] of byFrame) {
          const ids = new Set(locs.map((l) => l.id));
          const frameValues: Record<string, FormFieldValue> = {};
          for (const [id, v] of Object.entries(values)) {
            if (ids.has(id)) frameValues[id] = v;
          }
          if (!Object.keys(frameValues).length) continue;

          const frameId = key === 'top' ? undefined : key;
          const res = await sendToFrame<{
            ok: boolean;
            result?: { filled: string[]; skipped: Array<{ id: string; reason: string }>; lowConfidence: string[] };
            error?: string;
          }>(ctx.tabId, frameId, {
            type: MessageType.FILL_DOM,
            locators: locs,
            values: frameValues,
          });
          if (!res?.ok || !res.result) {
            for (const id of Object.keys(frameValues)) {
              skipped.push({ id, reason: res?.error || `frame ${String(key)} 回填失败` });
            }
            continue;
          }
          filled.push(...res.result.filled);
          skipped.push(...res.result.skipped);
          lowConfidence.push(...res.result.lowConfidence);

          if (res.result.filled.length) {
            const expected: Record<string, string> = {};
            for (const id of res.result.filled) expected[id] = frameValues[id]?.value ?? '';
            const verifyRes = await sendToFrame<VerifyAppliedResponse>(ctx.tabId, frameId, {
              type: MessageType.VERIFY_APPLIED,
              locators: locs,
              expected,
            }).catch(() => null);
            if (verifyRes?.ok) Object.assign(verifyResults, verifyRes.result);
          }
        }

        const verifiedCount = Object.values(verifyResults).filter((v) => v === 'verified').length;
        const revertedCount = Object.values(verifyResults).filter((v) => v === 'reverted').length;
        ctx.lastApply = { filled, skipped, lowConfidence, verified: verifiedCount, reverted: revertedCount };
        slog(
          'agent',
          `applyValues filled=${filled.length} skipped=${skipped.length} verified=${verifiedCount} reverted=${revertedCount} frames=${byFrame.size}`,
        );
        if (revertedCount > 0) {
          swarn('agent', `${revertedCount} 个字段写入后被页面回滚（可能是受控组件/组件库拦截了 setNativeValue）`);
        }

        const controlKey = makeControlKey(ctx.formGraph);
        const keyOf = new Map(ctx.formGraph.fields.map((f) => [f.fieldId, controlKey(f)]));
        return {
          ok: true as const,
          filledCount: filled.length,
          verifiedCount,
          revertedCount,
          skipped: skipped.map((s) => ({ control: keyOf.get(s.id) ?? s.id, reason: s.reason })),
          lowConfidence: lowConfidence.map((id) => keyOf.get(id) ?? id),
        };
      },
    }),
  };
}
