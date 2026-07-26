import { ToolLoopAgent, isStepCount } from 'ai';
import { createDeepSeek } from '@ai-sdk/deepseek';
import {
  deepSeekProviderBaseUrl,
  getDeepSeekRuntime,
  isDeepSeekConfigured,
} from '@/lib/ai/deepseek';
import {
  createAgentToolContext,
  createSnapfillTools,
  type AgentToolContext,
} from '@/lib/agent/tools';
import type { AgentStreamEvent } from '@/lib/messaging/types';
import { captureTrace } from '@/lib/trace/runtime';
import { ensureSettingsLoaded } from '@/lib/settings/store';
import { elapsed, slog, swarn } from '@/lib/log';

const INSTRUCTIONS = `你是 Snapfill 网页表单抽取 Agent。你的职责只有一件事：把当前页面的表单结构探索完整、抽取干净。
检索、问答、值的生成全部在后端完成——你不负责判断该填什么，也不经手具体的值。

你要像工程师排查现场一样迭代，不要只跑一条固定路径，尤其要主动发现"点了才出现"的联动字段（新增人员行、单选展开的受控区块、tab/accordion 隐藏面板）。

可用工具（感知 → 行动 → 观察 → 提交 → 回填）：
感知：
- probeFrames — 列出所有 frame/iframe 及可见控件数（怀疑表单在 iframe / snapshotForm 抽到 0 时必用）
- snapshotForm — 核心抽取：结构化 FormGraph（regions/fields/interactives/unresolved/metrics），自动与上次快照 diff
- revealAll — 滚过整页与内部滚动容器触发懒渲染，再恢复原位；返回滚动前后控件数
- describeRegion — 深挖某个 region 的字段明细（题干来源 labelSource、重复块的行列坐标 rowIndex/columnKey、隐藏模板列结构）
- readElementDetail — 读取某个字段的底层 DOM 细节（value/pattern/computed style），排查填不进去的原因
行动：
- activate — 点击"添加"按钮 / 切 tab / 勾选候选门控开关，内建等待 DOM 稳定；执行后必须重新 snapshotForm 看 diff
- openOptions — 展开下拉/组件库控件，采集可见选项
观察：
- getExtractionReport — 抽取质量指标 + 低置信度控件清单（按 control_no 列出"控件与题干可能没配对"的嫌疑项）
提交与回填：
- commitFormGraph — 把累积 FormGraph 交给后端检索填值；字段清单由系统确定性生成
- applyValues — 把后端返回的值写回 DOM，内建回读校验（verified/reverted/mismatch）

标准流程：
1. snapshotForm（可带 note 说明当前步骤/页签）
2. 若 ok=false 或 fieldCount=0 → probeFrames → 对 visibleHint 最大的 frameId 再 snapshotForm
3. 字段数明显少于页面观感、或长表单只抽到开头一段 → revealAll 一次；控件数有增长就重新 snapshotForm。控件数没变就别再调
4. 看 interactives：status=pending 的 add-button/dialog-trigger/tab/gate-candidate 都值得 activate 一次再 snapshotForm 复核 diff——这是发现联动字段的关键手段
   尤其注意：kind=repeat_group 且 fieldCount=0（或 row_count=0）的区域，必须先激活其关联 add-button/dialog-trigger 再重抽，否则成员/合作单位一类子表永远抽不到
5. 每次 activate 后必须对同一 frameId 重新 snapshotForm；连续两次没有新增字段/区域，或 pending 交互已探索完，视为收敛
   panelsPending 非空时一律不算收敛——那是整块整块的字段还没抽。切面板不会覆盖已抽的，逐个抽即可；
   判断某个面板不该进（页面级导航、只读记录、附件预览）可以跳过，但要在汇报里说明跳过了哪个、为什么
6. 收敛前用 getExtractionReport 自检：html_label 为空的控件并不等于抽错——题干关联在后端完成；你关注的是控件是否漏抽、空重复表是否已探索
   describeRegion 里这几种情形值得复核：
   - kind=repeat_group 但 0 行且未激活过 add-button → 探索未完成
   - 同一 region 内控件明显偏少 → 可能还有弹层/增行未点
   发现问题用 control_no 指代写进汇报，不要自己改题干——抽取逻辑的修正不在你的职责内
7. 仍然 0 字段 → 用中文说明：哪个 frame、total/visible、可能原因（未进表单页 / 非原生控件 / 跨域 / closed shadow DOM）并停止
8. 收敛后 commitFormGraph → applyValues
9. 中文短汇报：frame、区域与字段数、发现的重复块/联动区域、覆盖率、写入数与回读校验、未填控件（用 control_no 指代）

约束：
- 不要臆造字段值，也不要复述或改写后端返回的值；值由系统在 commitFormGraph 与 applyValues 之间直接传递
- 不要试图自己拼字段数组、自己挑知识库文件——这两件事都不在你的职责内，工具也不接受
- 不要把「0 字段」解释成用户没打开页面，除非 probeFrames 也全 0
- activate 有预算上限且危险操作（提交/删除/重置）会被硬拒绝，不需要自我克制，放心尝试有价值的交互
- page_context 保留步骤/页签语义`;

export type RunSnapfillAgentInput = {
  tabId: number;
  prompt?: string;
  knowledgeFileIds?: string[];
  abortSignal?: AbortSignal;
  onEvent?: (event: AgentStreamEvent) => void;
};

export type RunSnapfillAgentResult = {
  text: string;
  filledCount: number;
  unfilledCount: number;
  steps: number;
};

function summarizeToolResult(toolName: string, output: unknown): unknown {
  if (output == null || typeof output !== 'object') return output;
  const o = output as Record<string, unknown>;

  switch (toolName) {
    case 'probeFrames': {
      const frames = Array.isArray(o.frames) ? o.frames : [];
      return {
        ok: o.ok,
        frameCount: frames.length,
        frames: frames.slice(0, 8),
        tip: o.tip,
      };
    }
    case 'snapshotForm': {
      return {
        ok: o.ok,
        frameId: o.frameId,
        fieldCount: o.fieldCount,
        regionCount: o.regionCount,
        page_context: o.page_context,
        metrics: o.metrics,
        diffSinceLastSnapshot: o.diffSinceLastSnapshot,
        regions: Array.isArray(o.regions) ? o.regions.slice(0, 15) : o.regions,
        interactives: o.interactives,
        unresolved: Array.isArray(o.unresolved) ? o.unresolved.slice(0, 8) : o.unresolved,
        message: o.message,
        tip: o.tip,
      };
    }
    case 'describeRegion':
    case 'readElementDetail':
    case 'openOptions':
    case 'revealAll':
      return o;
    case 'activate': {
      return {
        ok: o.ok,
        performed: o.performed,
        urlChanged: o.urlChanged,
        budgetRemaining: o.budgetRemaining,
        tip: o.tip,
        error: o.error,
      };
    }
    case 'getExtractionReport':
      return o;
    case 'commitFormGraph': {
      return {
        ok: o.ok,
        task_id: o.task_id,
        submittedCount: o.submittedCount,
        filledCount: o.filledCount,
        unfilledCount: o.unfilledCount,
        lowConfidence: o.lowConfidence,
        tip: o.tip,
      };
    }
    case 'applyValues': {
      return {
        ok: o.ok,
        filledCount: o.filledCount,
        verifiedCount: o.verifiedCount,
        revertedCount: o.revertedCount,
        skipped: Array.isArray(o.skipped) ? o.skipped.length : 0,
      };
    }
    default:
      return o;
  }
}

function createAgent(ctx: AgentToolContext) {
  const ds = getDeepSeekRuntime();
  const deepseek = createDeepSeek({
    apiKey: ds.apiKey,
    baseURL: deepSeekProviderBaseUrl(ds.baseUrl),
  });

  return new ToolLoopAgent({
    model: deepseek(ds.model),
    instructions: INSTRUCTIONS,
    tools: createSnapfillTools(ctx),
    // 探索 iframe / activate-snapshot 循环 / 分批填值需要更多步
    stopWhen: isStepCount(32),
    temperature: 0.1,
    providerOptions: {
      deepseek: {
        thinking: { type: 'enabled' },
        reasoningEffort: 'high',
      },
    },
  });
}

/** 流式运行 Agent，通过 onEvent 推送文本增量与工具调用 */
export async function streamSnapfillAgent(
  input: RunSnapfillAgentInput,
): Promise<RunSnapfillAgentResult> {
  await ensureSettingsLoaded();
  if (!isDeepSeekConfigured()) {
    throw new Error('未配置 DeepSeek API Key（侧栏设置或 .env.local）');
  }

  const ds = getDeepSeekRuntime();
  const started = Date.now();
  const emit = (event: AgentStreamEvent) => input.onEvent?.(event);
  const ctx: AgentToolContext = createAgentToolContext(input.tabId);
  ctx.preferredKnowledgeIds = input.knowledgeFileIds;

  const agent = createAgent(ctx);
  const userPrompt =
    input.prompt?.trim() ||
    '请填写当前页可见表单。先 snapshotForm 做结构化抽取；若在 iframe 或抽到 0 字段，先 probeFrames 再换 frame 重试；' +
      '字段数明显偏少时用 revealAll 触发懒渲染后重抽；' +
      '注意探索"添加"按钮/tab/门控开关等联动交互，activate 后重新 snapshotForm 确认是否有新字段；最后填值并写回 DOM。';

  slog(
    'agent',
    `ToolLoopAgent.stream 开始 tab=${input.tabId} model=${ds.model} thinking=on`,
  );
  emit({ type: 'started', model: `${ds.model} · thinking` });

  const result = await agent.stream({
    prompt: userPrompt,
    abortSignal: input.abortSignal,
    timeout: {
      totalMs: Math.max(ds.timeoutMs ?? 180_000, 300_000),
    },
  });

  let stepNumber = 0;
  for await (const part of result.fullStream) {
    switch (part.type) {
      case 'text-delta':
        emit({ type: 'text-delta', delta: part.text });
        break;
      case 'reasoning-delta':
        emit({
          type: 'reasoning-delta',
          delta: 'text' in part ? String((part as { text?: string }).text ?? '') : '',
        });
        break;
      case 'tool-call':
        emit({
          type: 'tool-call',
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          args: part.input,
        });
        break;
      case 'tool-result':
        emit({
          type: 'tool-result',
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          result: summarizeToolResult(part.toolName, part.output),
        });
        break;
      case 'tool-error':
        emit({
          type: 'tool-error',
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          error:
            part.error instanceof Error
              ? part.error.message
              : String(part.error),
        });
        break;
      case 'finish-step':
        stepNumber += 1;
        emit({ type: 'step-finish', stepNumber });
        break;
      case 'error':
        throw part.error instanceof Error
          ? part.error
          : new Error(String(part.error));
      default:
        // 兼容不同 SDK 版本的 reasoning 事件名
        if (
          typeof part.type === 'string' &&
          part.type.includes('reasoning') &&
          'text' in part
        ) {
          emit({
            type: 'reasoning-delta',
            delta: String((part as { text?: string }).text ?? ''),
          });
        }
        break;
    }
  }

  const text = (await result.text)?.trim() ?? '';
  const steps = (await result.steps).length;
  const filledCount = ctx.lastApply?.filled.length ?? 0;
  const extractedCount = ctx.formGraph.fields.length;

  // 可观测性产物：每轮结束固定落一份（control_no 标注截图 + 映射表 + form_graph.json），
  // 不依赖 Agent 自觉调用，也不进 LLM 上下文
  if (extractedCount > 0) {
    await captureTrace(ctx.tabId, ctx.formGraph, ctx.lastPageContext).catch((e) =>
      swarn('agent', `抽取产物落盘失败: ${e instanceof Error ? e.message : String(e)}`),
    );
  }

  const finalText =
    text ||
    (filledCount > 0
      ? `已写入 ${filledCount} 个字段。`
      : 'Agent 已结束，但未产生可展示摘要。');

  slog(
    'agent',
    `ToolLoopAgent.stream 完成 steps=${steps} filled=${filledCount} ${elapsed(started)}`,
  );

  if (!ctx.lastApply && extractedCount > 0) {
    swarn('agent', '有抽取字段但未执行 applyValues');
  }

  const out: RunSnapfillAgentResult = {
    text: finalText,
    filledCount,
    unfilledCount: Math.max(0, extractedCount - filledCount),
    steps,
  };

  emit({
    type: 'done',
    text: out.text,
    filledCount: out.filledCount,
    unfilledCount: out.unfilledCount,
    steps: out.steps,
  });

  return out;
}
