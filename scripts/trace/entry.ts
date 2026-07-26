/**
 * 离线 trace harness 注入页面的入口：把抽取/标注/组装三个纯前端能力挂到 window。
 * 与扩展运行时共用同一批模块，保证两条路径产出的 form_graph.json 口径一致。
 */

import { extractFormGraph } from '@/lib/formgraph/extract';
import { clearOverlay, renderOverlay } from '@/lib/formgraph/overlay';
import { buildTrace, makeControlKey } from '@/lib/formgraph/trace';
import { emptyFormGraph, mergeFragmentIntoGraph } from '@/lib/formgraph/merge';
import type { FormGraph } from '@/lib/formgraph/types';

let registry = new Map<string, Element>();

/** 抽取当前文档并合成单 frame 的完整 FormGraph（含 metrics） */
function snapshot(maxFields = 300): FormGraph {
  const { fragment, registry: reg } = extractFormGraph({ frameId: 0, maxFields });
  registry = reg;
  return mergeFragmentIntoGraph(
    emptyFormGraph({
      kind: 'web',
      url: location.href,
      title: document.title,
      capturedAt: new Date().toISOString(),
    }),
    fragment,
    {
      frameMeta: {
        frameId: 0,
        parentFrameId: null,
        url: location.href,
        title: document.title,
        crossOrigin: false,
        pageOffset: { dx: 0, dy: 0 },
        totalControls: fragment.metrics.controlsSeen,
        visibleControls: fragment.fields.length,
      },
    },
  );
}

/** 把一次新的抽取累加进已有图，供 harness 复刻 Agent 的探索循环 */
function accumulate(graph: FormGraph, activatedIds: string[] = [], maxFields = 300): FormGraph {
  const { fragment, registry: reg } = extractFormGraph({ frameId: 0, maxFields });
  registry = reg;
  return mergeFragmentIntoGraph(graph, fragment, { activatedIds: new Set(activatedIds) });
}

function annotate(graph: FormGraph): number {
  const keyOf = makeControlKey(graph);
  const fields = graph.fields.flatMap((f) => {
    const el = registry.get(f.fieldId);
    return el ? [{ key: keyOf(f), el }] : [];
  });
  const regions = graph.regions.flatMap((r) => {
    const el = registry.get(r.regionId);
    return el ? [{ key: r.name || r.regionId, el }] : [];
  });
  return renderOverlay(fields, regions);
}

Object.assign(window, {
  __snapfillTrace: { snapshot, accumulate, annotate, clearOverlay, buildTrace },
});
