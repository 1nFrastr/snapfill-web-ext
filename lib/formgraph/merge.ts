/**
 * 跨 frame / 跨面板汇总 + 跨轮次 diff/merge。
 *
 * 关键行为（对齐改造计划）：
 * - 覆盖粒度是 (frameId, panelKey) 而不是 frameId。tab 切换会把上一个面板的 DOM 移除，
 *   若按整个 frame 覆盖，先前面板抽到的字段会在下一次快照时被静默抹掉。
 *   同一面板内重新快照仍然整体覆盖——门控揭示新字段时旧字段还在 DOM 里，新片段本就包含新旧全部。
 * - interactives 按 id 并集累积（后到覆盖先到）：切走后按钮不在 DOM 里，但它仍然是已知交互。
 * - gatedBy 不做静态匹配：Agent 激活某个候选开关后再次快照，新增的 region 由
 *   `tagGatedRegions` 动态打上 gatedBy，引用刚才激活的字段。
 */

import type {
  FormGraph,
  FormGraphDiff,
  FormGraphFragment,
  FormGraphSource,
  FrameNode,
  InteractiveNode,
  PanelNode,
  RegionNode,
  UnresolvedItem,
} from '@/lib/formgraph/types';
import { computeMetrics } from '@/lib/formgraph/metrics';

export function emptyFormGraph(source: FormGraphSource): FormGraph {
  return {
    schemaVersion: 'form_graph.v1',
    source,
    frames: [],
    panels: [],
    regions: [],
    fields: [],
    texts: [],
    interactives: [],
    unresolved: [],
    metrics: computeMetrics(0, [], [], [], []),
  };
}

/**
 * coverage 的分母是各面板抽取时扫到的原始控件数之和。
 * 用 fields.length 当分母会让 coverage 恒等于 1，等于没有这个指标。
 */
function recomputeMetrics(graph: FormGraph): void {
  const captured = graph.panels.filter((p) => p.captured);
  const controlsSeen = captured.reduce((sum, p) => sum + p.controlsSeen, 0);
  const dropped: Record<string, number> = {};
  for (const p of captured) {
    for (const [reason, n] of Object.entries(p.dropped)) dropped[reason] = (dropped[reason] ?? 0) + n;
  }
  graph.metrics = computeMetrics(
    controlsSeen,
    graph.fields,
    graph.regions,
    graph.interactives,
    graph.unresolved,
    dropped,
  );
}

/** 已抽过的面板 → 对应 tab 的 interactive 标成 activated（快照会重建 interactives，状态得靠这里回填） */
function applyInteractiveStatus(
  interactives: InteractiveNode[],
  panels: PanelNode[],
  activatedIds: ReadonlySet<string>,
): InteractiveNode[] {
  const capturedKeys = new Set(panels.filter((p) => p.captured).map((p) => p.key));
  return interactives.map((i) =>
    i.status === 'skipped' || (!capturedKeys.has(i.interactiveId) && !activatedIds.has(i.interactiveId))
      ? i
      : { ...i, status: 'activated' as const },
  );
}

export type MergeOptions = {
  frameMeta?: FrameNode;
  /** 代码侧记录的已激活目标 id（由 activate 工具维护，不采信 LLM 自述） */
  activatedIds?: ReadonlySet<string>;
};

/** 用最新片段覆盖它所属的 (frame, panel) 分片，其余 frame / 其余面板原样保留。 */
export function mergeFragmentIntoGraph(
  graph: FormGraph,
  fragment: FormGraphFragment,
  options: MergeOptions = {},
): FormGraph {
  const { frameMeta, activatedIds = new Set<string>() } = options;
  const panelKey = fragment.panel?.key ?? '';
  const keepOtherScope = <T extends { frameId: number; panelKey: string }>(arr: T[]) =>
    arr.filter((x) => x.frameId !== fragment.frameId || x.panelKey !== panelKey);

  const panels = mergePanels(graph.panels, fragment, panelKey);
  const interactives = new Map(graph.interactives.map((i) => [i.interactiveId, i]));
  for (const i of fragment.interactives) interactives.set(i.interactiveId, i);

  // unresolved 没有面板维度，按"同一处未解析项"去重并集，避免切面板时互相覆盖
  const unresolvedKey = (u: UnresolvedItem) => `${u.frameId}::${u.reason}::${u.selector ?? ''}`;
  const unresolved = new Map(graph.unresolved.map((u) => [unresolvedKey(u), u]));
  for (const u of fragment.unresolved) unresolved.set(unresolvedKey(u), u);

  const next: FormGraph = {
    ...graph,
    panels,
    regions: [...keepOtherScope(graph.regions), ...fragment.regions],
    fields: [...keepOtherScope(graph.fields), ...fragment.fields],
    texts: [
      ...graph.texts.filter((t) => t.frameId !== fragment.frameId || t.panelKey !== panelKey),
      ...fragment.texts,
    ],
    interactives: applyInteractiveStatus([...interactives.values()], panels, activatedIds),
    unresolved: [...unresolved.values()],
  };

  if (frameMeta) {
    next.frames = [...graph.frames.filter((f) => f.frameId !== frameMeta.frameId), frameMeta];
  }

  recomputeMetrics(next);
  return next;
}

/** 已知面板并集：本次激活的那个标 captured，其余保留原状态 */
function mergePanels(known: PanelNode[], fragment: FormGraphFragment, panelKey: string): PanelNode[] {
  const byKey = new Map(known.map((p) => [`${p.frameId}::${p.key}`, p]));
  const scoped = (key: string) => `${fragment.frameId}::${key}`;

  for (const ref of fragment.panels) {
    if (byKey.has(scoped(ref.key))) continue;
    byKey.set(scoped(ref.key), {
      ...ref,
      frameId: fragment.frameId,
      captured: false,
      controlsSeen: 0,
      dropped: {},
    });
  }

  byKey.set(scoped(panelKey), {
    key: panelKey,
    label: fragment.panel?.label ?? '',
    frameId: fragment.frameId,
    captured: true,
    controlsSeen: fragment.metrics.controlsSeen,
    dropped: fragment.metrics.dropped,
  });

  return [...byKey.values()];
}

/** 同一 frame 前后两次快照的差分：新增/消失/发生变化的字段与区域。 */
export function diffFragments(prev: FormGraphFragment | undefined, next: FormGraphFragment): FormGraphDiff {
  const prevFieldIds = new Set((prev?.fields ?? []).map((f) => f.fieldId));
  const nextFieldIds = new Set(next.fields.map((f) => f.fieldId));
  const prevRegionIds = new Set((prev?.regions ?? []).map((r) => r.regionId));
  const nextRegionIds = new Set(next.regions.map((r) => r.regionId));

  const prevFieldMap = new Map((prev?.fields ?? []).map((f) => [f.fieldId, f]));
  const changedFieldIds: string[] = [];
  for (const f of next.fields) {
    const before = prevFieldMap.get(f.fieldId);
    if (before && (before.label !== f.label || before.rect.y !== f.rect.y || before.rect.x !== f.rect.x)) {
      changedFieldIds.push(f.fieldId);
    }
  }

  return {
    addedFieldIds: [...nextFieldIds].filter((id) => !prevFieldIds.has(id)),
    removedFieldIds: [...prevFieldIds].filter((id) => !nextFieldIds.has(id)),
    changedFieldIds,
    addedRegionIds: [...nextRegionIds].filter((id) => !prevRegionIds.has(id)),
    removedRegionIds: [...prevRegionIds].filter((id) => !nextRegionIds.has(id)),
  };
}

/**
 * 激活某个门控/交互候选后，把新出现的 region 打上 gatedBy（引用刚激活的字段）。
 * 仅当激活目标是"取值型"控件（radio/checkbox/select，即 activatedValue 非空）时才打标；
 * 纯按钮类激活（add-button/tab）不产生 gatedBy，靠 repeat/关联关系表达。
 */
export function tagGatedRegions(
  fragment: FormGraphFragment,
  diff: FormGraphDiff,
  activated: { fieldId: string; label: string; value?: string } | null,
): FormGraphFragment {
  if (!activated?.value || diff.addedRegionIds.length === 0) return fragment;

  const regions: RegionNode[] = fragment.regions.map((r) => {
    if (!diff.addedRegionIds.includes(r.regionId) || r.gatedBy) return r;
    return {
      ...r,
      gatedBy: { fieldId: activated.fieldId, whenValue: activated.value!, label: activated.label },
    };
  });

  return { ...fragment, regions };
}
