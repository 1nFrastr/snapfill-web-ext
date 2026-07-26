/**
 * FormGraph 主抽取入口：单个 frame/document 内产出 FormGraphFragment。
 * 跨 frame 汇总、跨轮次 diff/merge 见 lib/formgraph/merge.ts；
 * 由 content script 在各自 frame 上下文调用，registry 留在 content script 侧供后续
 * describeRegion / readElementDetail / activate / openOptions 工具按 id 查回元素。
 */

import {
  cssPath,
  deepQueryAll,
  noiseReason,
  norm,
  rectOf,
  shadowHostChain,
  computePageOffset,
  collectTextNodes,
} from '@/lib/formgraph/dom-utils';
import { detectControl, findHiddenBackingInput, isSignatureCanvas } from '@/lib/formgraph/component-detect';
import { resolveLabel, tableMeta } from '@/lib/formgraph/label-resolve';
import { stableFieldId } from '@/lib/formgraph/identity';
import { buildRegions } from '@/lib/formgraph/sections';
import {
  classifyTable,
  detectDialogTriggers,
  detectGateCandidates,
  detectPanels,
  detectTabsAndAccordions,
  findAddButtonNear,
  makeInteractiveIdFactory,
} from '@/lib/formgraph/repeat';
import { computeMetrics } from '@/lib/formgraph/metrics';
import { sortByReadingOrder } from '@/lib/formgraph/reading-order';
import type { WorkingField, WorkingInteractive } from '@/lib/formgraph/internal-types';
import type {
  FieldNode,
  FormGraphFragment,
  InteractiveNode,
  NeighborsInfo,
  RegionNode,
  RouteHint,
  UnresolvedItem,
} from '@/lib/formgraph/types';

const CONTROL_SELECTOR =
  'input,select,textarea,[role="combobox"],[role="listbox"],[role="textbox"][contenteditable="true"],[contenteditable="true"],canvas';

function readOptions(el: Element): FieldNode['options'] {
  if (el instanceof HTMLSelectElement) {
    return [...el.options].map((o) => ({ label: norm(o.textContent) || o.value, value: o.value }));
  }
  if (el instanceof HTMLInputElement && el.type === 'radio' && el.name) {
    const group = document.querySelectorAll<HTMLInputElement>(`input[type="radio"][name="${el.name}"]`);
    return [...group].map((r) => ({ label: norm(r.value), value: r.value }));
  }
  return null;
}

function readValue(el: Element): FieldNode['existingValue'] {
  if (el instanceof HTMLSelectElement) return el.multiple ? [...el.selectedOptions].map((o) => o.value) : el.value || null;
  if (el instanceof HTMLInputElement) {
    if (el.type === 'checkbox') return el.checked;
    if (el.type === 'radio') return el.checked ? el.value : null;
    if (el.type === 'file') return null;
    return el.value || null;
  }
  if (el instanceof HTMLTextAreaElement) return el.value || null;
  if (el.getAttribute('contenteditable') === 'true') return norm(el.textContent) || null;
  return null;
}

function routeHintFor(field: Pick<FieldNode, 'control' | 'readonly' | 'disabled'>): RouteHint {
  if (field.readonly || field.disabled) return 'skip';
  if (field.control.type === 'file' || field.control.component === 'upload') return 'file';
  if (field.control.component === 'signature') return 'sign';
  if (['radio', 'checkbox', 'select'].includes(field.control.type) || field.control.tag === 'select') return 'choice';
  if (field.control.tag === 'textarea' || field.control.component === 'richtext' || field.control.widget === 'contenteditable') {
    return 'verbose';
  }
  return 'normal';
}

function collectFieldNeighbors(fields: WorkingField[]): void {
  for (const f of fields) {
    const r = f.rect;
    let bestLeft: { id: string; score: number } | null = null;
    let bestRight: { id: string; score: number } | null = null;
    let bestAbove: { id: string; score: number } | null = null;
    let bestBelow: { id: string; score: number } | null = null;

    for (const g of fields) {
      if (g === f) continue;
      const gr = g.rect;
      const dy = Math.abs(gr.y + gr.h / 2 - (r.y + r.h / 2));
      const dxCenter = Math.abs(gr.x + gr.w / 2 - (r.x + r.w / 2));

      if (gr.x + gr.w <= r.x && dy < Math.max(r.h, 24)) {
        const score = (r.x - (gr.x + gr.w)) + dy * 2;
        if (!bestLeft || score < bestLeft.score) bestLeft = { id: g.fieldId, score };
      }
      if (gr.x >= r.x + r.w && dy < Math.max(r.h, 24)) {
        const score = (gr.x - (r.x + r.w)) + dy * 2;
        if (!bestRight || score < bestRight.score) bestRight = { id: g.fieldId, score };
      }
      if (gr.y + gr.h <= r.y && dxCenter < 240) {
        const score = (r.y - (gr.y + gr.h)) + dxCenter * 0.5;
        if (!bestAbove || score < bestAbove.score) bestAbove = { id: g.fieldId, score };
      }
      if (gr.y >= r.y + r.h && dxCenter < 240) {
        const score = (gr.y - (r.y + r.h)) + dxCenter * 0.5;
        if (!bestBelow || score < bestBelow.score) bestBelow = { id: g.fieldId, score };
      }
    }

    f.neighbors.fieldLeftId = bestLeft?.id ?? null;
    f.neighbors.fieldRightId = bestRight?.id ?? null;
    f.neighbors.fieldAboveId = bestAbove?.id ?? null;
    f.neighbors.fieldBelowId = bestBelow?.id ?? null;
  }
}

function buildSiblingSlots(fields: WorkingField[]): void {
  const groupMap = new Map<string, WorkingField[]>();
  for (const f of fields) {
    const key =
      f.table && f.table.controlsInCell > 1
        ? `t${f.table.tableIndex}-r${f.table.row}-c${f.table.col}`
        : f.nearLabel
          ? `y${Math.round(f.rect.y / 20)}_lab_${f.nearLabel}`
          : '';
    if (!key) continue;
    if (!groupMap.has(key)) groupMap.set(key, []);
    groupMap.get(key)!.push(f);
  }
  for (const group of groupMap.values()) {
    if (group.length < 2) continue;
    group.sort((a, b) => a.rect.x - b.rect.x || a.rect.y - b.rect.y);
    const sharedLabel = group[0].nearLabel || group[0].label;
    group.forEach((f, index) => {
      f.siblingSlot = { index, count: group.length, sharedLabel };
    });
  }
}

export type ExtractOptions = {
  frameId: number;
  includeInteractives?: boolean;
  maxFields?: number;
};

export type ExtractResult = {
  fragment: FormGraphFragment;
  registry: Map<string, Element>;
};

export function extractFormGraph(opts: ExtractOptions): ExtractResult {
  const frameId = opts.frameId;
  const maxFields = opts.maxFields ?? 200;
  const unresolved: UnresolvedItem[] = [];

  const rawControls = deepQueryAll(CONTROL_SELECTOR, document, unresolved, frameId).filter(
    (el, idx, arr) => arr.indexOf(el) === idx,
  );

  const consumedBacking = new Set<Element>();
  const backingOf = new Map<Element, Element>();
  for (const el of rawControls) {
    if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement) continue;
    const backing = findHiddenBackingInput(el);
    if (backing) {
      consumedBacking.add(backing);
      backingOf.set(el, backing);
    }
  }

  const seenRadio = new Set<string>();
  const visibleControls: Element[] = [];
  const dropped: Record<string, number> = {};
  const bump = (reason: string) => {
    dropped[reason] = (dropped[reason] ?? 0) + 1;
  };

  /**
   * coverage 的分母：本面板里真正渲染出来的候选控件数。
   *
   * 刻意排除三类，否则分母失真：隐藏面板的控件（属于别的面板，跨面板求和会重复计数）、
   * type=hidden/button/submit（根本不是可填控件）、并入组件字段的 backing input 与
   * 同组重复 radio（本就该合并成一个字段）。剩下被丢弃的都会进 dropped 直方图，
   * 于是"少抽了字段"和"正确忽略了噪声"能被分辨出来。
   */
  let controlsSeen = 0;

  for (const el of rawControls) {
    if (consumedBacking.has(el)) {
      bump('backing-input');
      continue;
    }

    const reason = noiseReason(el);
    if (reason === 'hidden-type' || reason === 'not-visible' || reason === 'zero-size') {
      bump(reason);
      continue;
    }

    if (el instanceof HTMLInputElement && el.type === 'radio') {
      const key = el.name || cssPath(el);
      if (seenRadio.has(key)) {
        bump('radio-duplicate');
        continue;
      }
      seenRadio.add(key);
    }

    controlsSeen += 1;

    if (reason) {
      bump(reason);
      continue;
    }
    if (el.tagName.toLowerCase() === 'canvas' && !isSignatureCanvas(detectControl(el))) {
      bump('canvas-form');
      unresolved.push({ reason: 'canvas-form', frameId, selector: cssPath(el), note: '非签名 canvas，暂无法结构化抽取' });
      continue;
    }
    visibleControls.push(el);
  }

  if (visibleControls.length > maxFields) {
    dropped['max-fields'] = visibleControls.length - maxFields;
  }

  const { panels, active: activePanel } = detectPanels(document);
  const panelKey = activePanel?.key ?? '';

  const { regions: workingRegions, elementToRegion } = buildRegions(visibleControls, frameId);
  // 面板名进 chain：queryHint 由 chain 拼出，后端因此能知道字段属于哪个页签
  if (activePanel?.label) {
    for (const r of workingRegions) {
      if (r.chain[0] !== activePanel.label) r.chain = [activePanel.label, ...r.chain];
    }
  }
  const textNodes = collectTextNodes(document);
  const usedIds = new Set<string>();
  const collected: WorkingField[] = [];

  for (const el of visibleControls.slice(0, maxFields)) {
    const r = el.getBoundingClientRect();
    const preferRight = el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio');
    const resolved = resolveLabel(el, r, textNodes, { preferRight });
    const control = detectControl(el);
    const table = tableMeta(el, visibleControls);
    const region = elementToRegion.get(el);
    const rect = rectOf(el);
    const pageOffset = computePageOffset();
    const backing = backingOf.get(el);

    const field: WorkingField = {
      el,
      fieldId: stableFieldId(el, { frameId, selector: cssPath(el), used: usedIds, label: resolved.label }),
      controlNo: 0, // 全部字段收齐后按阅读顺序统一编号
      regionId: region?.regionId ?? 'ungrouped',
      panelKey,
      control,
      label: resolved.label,
      labelSource: resolved.labelSource,
      labelConfidence: resolved.labelConfidence,
      nearLabel: resolved.nearLabel,
      queryHint: '',
      rect,
      pageRect: pageOffset ? { x: rect.x + pageOffset.dx, y: rect.y + pageOffset.dy, w: rect.w, h: rect.h } : rect,
      frameId,
      table,
      siblingSlot: null,
      neighbors: {
        textLeft: resolved.textLeft,
        textRight: resolved.textRight,
        textAbove: resolved.textAbove,
        textBelow: resolved.textBelow,
        fieldLeftId: null,
        fieldRightId: null,
        fieldAboveId: null,
        fieldBelowId: null,
      } satisfies NeighborsInfo,
      options: readOptions(backing || el),
      optionsSource: 'dom',
      required: el.hasAttribute('required') || el.getAttribute('aria-required') === 'true',
      readonly: (el as HTMLInputElement).readOnly === true || el.getAttribute('aria-readonly') === 'true',
      disabled: (el as HTMLInputElement).disabled === true || el.getAttribute('aria-disabled') === 'true',
      existingValue: readValue(backing || el),
      routeHint: 'normal',
      locator: {
        selector: cssPath(el),
        backingSelector: backing ? cssPath(backing) : undefined,
        shadowPath: shadowHostChain(el),
        frameId,
        namePattern: el.getAttribute('name') || undefined,
      },
    };
    field.routeHint = routeHintFor(field);
    collected.push(field);
  }

  // 之后的一切（fields[] 顺序、region.fieldIds、标注截图徽标）都跟随阅读顺序
  const workingFields = sortByReadingOrder(collected);
  workingFields.forEach((f, i) => {
    f.controlNo = i + 1;
  });

  buildSiblingSlots(workingFields);
  collectFieldNeighbors(workingFields);

  for (const f of workingFields) {
    const region = workingRegions.find((r) => r.regionId === f.regionId);
    const slot = f.siblingSlot && f.siblingSlot.count > 1 ? `[${f.siblingSlot.index + 1}/${f.siblingSlot.count}]` : '';
    const lab = f.label || f.nearLabel || f.fieldId;
    f.queryHint = [...(region?.chain ?? []), `${lab}${slot}`].filter(Boolean).join(' / ');
  }

  const interactives: WorkingInteractive[] = [];
  const fieldsByRegion = new Map<string, WorkingField[]>();
  for (const f of workingFields) {
    if (!fieldsByRegion.has(f.regionId)) fieldsByRegion.set(f.regionId, []);
    fieldsByRegion.get(f.regionId)!.push(f);
  }

  const nextInteractiveId = makeInteractiveIdFactory();

  for (const region of workingRegions) {
    if (!(region.containerEl instanceof HTMLTableElement)) continue;
    const fieldsInTable = fieldsByRegion.get(region.regionId) ?? [];
    const classification = classifyTable(region.containerEl, fieldsInTable);
    region.kind = classification.kind;
    const maxRow = fieldsInTable.reduce((m, f) => Math.max(m, f.table?.row ?? 0), 0);
    region.table = { rowRange: [0, maxRow], columns: classification.columns };
    if (classification.repeat) {
      region.repeat = classification.repeat;
      region.evidence.push('repeat-pattern');
      if (classification.repeat.addTargetSelector) {
        const btnEl = findAddButtonNear(region.containerEl);
        interactives.push({
          interactiveId: nextInteractiveId('addbtn', btnEl || region.containerEl),
          kind: 'add-button',
          label: classification.repeat.addTargetLabel || '添加',
          frameId,
          rect: btnEl ? rectOf(btnEl) : { x: 0, y: 0, w: 0, h: 0 },
          selector: classification.repeat.addTargetSelector,
          relatedRegionId: region.regionId,
          status: 'pending',
          el: btnEl || region.containerEl,
        });
      }
    }
  }

  interactives.push(...detectGateCandidates(workingFields, frameId, nextInteractiveId));
  interactives.push(...detectTabsAndAccordions(document, frameId, nextInteractiveId));
  const claimed = new Set(interactives.map((i) => i.el));
  interactives.push(...detectDialogTriggers(document, frameId, nextInteractiveId, claimed));

  const fields: FieldNode[] = workingFields.map(({ el: _el, ...rest }) => rest);
  const regions: RegionNode[] = workingRegions
    .filter((r) => (fieldsByRegion.get(r.regionId) ?? []).length > 0)
    .map((r) => {
      const { containerEl, fieldEls: _fieldEls, ...rest } = r;
      return {
        ...rest,
        rect: rectOf(containerEl),
        panelKey,
        fieldIds: (fieldsByRegion.get(r.regionId) ?? []).map((f) => f.fieldId),
      };
    });
  const interactiveNodes: InteractiveNode[] = interactives.map(({ el: _el, ...rest }) => rest);

  const registry = new Map<string, Element>();
  for (const f of workingFields) registry.set(f.fieldId, f.el);
  for (const r of workingRegions) registry.set(r.regionId, r.containerEl);
  for (const i of interactives) registry.set(i.interactiveId, i.el);

  const metrics = computeMetrics(controlsSeen, fields, regions, interactiveNodes, unresolved, dropped);

  const fragment: FormGraphFragment = {
    schemaVersion: 'form_graph.v1',
    frameId,
    panel: activePanel,
    panels,
    regions,
    fields,
    interactives: interactiveNodes,
    unresolved,
    metrics,
  };

  return { fragment, registry };
}
