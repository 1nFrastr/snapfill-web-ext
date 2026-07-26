/**
 * FormGraph → 后端事实层 payload + 本地回填定位表。
 * 上传 controls/texts/structure 原样；不做 queryHint 降维、不做语义拍平。
 */

import type {
  FormFactControl,
  FormFactPayload,
  FormFactStructure,
  FormFactText,
  FormFieldType,
  FormFieldsFillData,
} from '@/lib/api/types';
import type { FieldNode, FormGraph, RegionNode, TextFact } from '@/lib/formgraph/types';

export type FieldLocator = {
  id: string;
  selector: string;
  type: FormFieldType;
  options?: FieldNode['options'];
  name?: string;
  inputType?: string;
  frameId?: number;
  backingSelector?: string;
  widget?: FieldNode['control']['widget'];
  component?: FieldNode['control']['component'];
};

function toApiType(node: FieldNode): FormFieldType {
  const t = node.control.type.toLowerCase();
  if (t === 'email') return 'email';
  if (t === 'tel') return 'tel';
  if (['text', 'textarea', 'number', 'date', 'select', 'radio', 'checkbox'].includes(t)) {
    return t as FormFieldType;
  }
  if (node.control.tag === 'select') return 'select';
  if (node.control.tag === 'textarea' || node.control.widget === 'contenteditable') return 'textarea';
  return 'other';
}

function controlState(f: FieldNode): FormFactControl['state'] {
  return {
    required: f.required,
    readonly: f.readonly,
    disabled: f.disabled,
    existing_value: f.existingValue,
  };
}

function toFactControl(f: FieldNode): FormFactControl {
  const type = toApiType(f);
  const item: FormFactControl = {
    id: f.fieldId,
    control_no: f.controlNo,
    type,
    tag: f.control.tag,
    widget: f.control.widget,
    frame_id: f.frameId,
    panel_key: f.panelKey,
    region_id: f.regionId,
    rect: f.rect,
    dom_path: f.locator.selector,
    html_label: f.label || undefined,
    label_source: f.labelSource !== 'empty' ? f.labelSource : undefined,
    in_pager: f.inPager,
    in_table_footer: f.inTableFooter,
    state: controlState(f),
  };
  if (f.options?.length) {
    item.options = f.options.map((o) => o.label || o.value).filter(Boolean);
  }
  if (f.table) {
    item.table_pos = {
      table_index: f.table.tableIndex,
      row: f.table.row,
      col: f.table.col,
      colspan: f.table.colspan,
      rowspan: f.table.rowspan,
    };
  }
  if (f.rowIndex != null) item.row_index = f.rowIndex;
  if (f.columnKey) item.column_key = f.columnKey;
  if (f.siblingSlot) {
    item.sibling_slot = {
      index: f.siblingSlot.index,
      count: f.siblingSlot.count,
      shared_label: f.siblingSlot.sharedLabel || undefined,
    };
  }
  return item;
}

function toFactText(t: TextFact): FormFactText {
  return {
    text: t.text,
    rect: t.rect,
    frame_id: t.frameId,
    panel_key: t.panelKey,
    dom_path: t.domPath,
    font_size: t.fontSize,
    font_weight: t.fontWeight,
    leaf: t.leaf,
    table_pos: t.tablePos
      ? { table_index: t.tablePos.tableIndex, row: t.tablePos.row, col: t.tablePos.col }
      : undefined,
  };
}

function toStructure(regions: RegionNode[], graph: FormGraph): FormFactStructure {
  return {
    regions: regions.map((r) => ({
      region_id: r.regionId,
      kind: r.kind,
      name: r.name,
      chain: r.chain,
      frame_id: r.frameId,
      panel_key: r.panelKey,
      rect: r.rect,
      field_ids: r.fieldIds,
      columns: r.table?.columns,
      row_count: r.repeat?.rowCount,
      gated_by: r.gatedBy
        ? { field_id: r.gatedBy.fieldId, when_value: r.gatedBy.whenValue, label: r.gatedBy.label }
        : undefined,
    })),
    panels: graph.panels.map((p) => ({
      key: p.key,
      label: p.label,
      frame_id: p.frameId,
      captured: p.captured,
    })),
    interactives: graph.interactives.map((i) => ({
      interactive_id: i.interactiveId,
      kind: i.kind,
      label: i.label,
      frame_id: i.frameId,
      related_region_id: i.relatedRegionId,
      status: i.status,
    })),
  };
}

export type FactPayloadResult = {
  payload: FormFactPayload;
  locators: FieldLocator[];
  excluded: FieldNode[];
};

/**
 * 完整 FormGraph → 事实层上传契约。
 * routeHint 为 skip/file/sign 的控件不参与填值，但仍可出现在 structure 里。
 */
export function formGraphToFactPayload(
  graph: FormGraph,
  opts?: { regionIds?: string[]; pageContext?: string },
): FactPayloadResult {
  const regionFilter = opts?.regionIds?.length ? new Set(opts.regionIds) : null;
  const regions = regionFilter
    ? graph.regions.filter((r) => regionFilter.has(r.regionId))
    : graph.regions;
  const regionIdSet = new Set(regions.map((r) => r.regionId));

  const locators: FieldLocator[] = [];
  const excluded: FieldNode[] = [];
  const controls: FormFactControl[] = [];

  for (const f of graph.fields) {
    if (regionFilter && !regionIdSet.has(f.regionId) && f.regionId !== 'ungrouped') continue;
    if (f.routeHint === 'skip' || f.routeHint === 'file' || f.routeHint === 'sign') {
      excluded.push(f);
      continue;
    }
    const type = toApiType(f);
    controls.push(toFactControl(f));
    locators.push({
      id: f.fieldId,
      selector: f.locator.selector,
      type,
      options: f.options ?? undefined,
      name: f.locator.namePattern,
      inputType: f.control.type,
      frameId: f.frameId,
      backingSelector: f.locator.backingSelector,
      widget: f.control.widget,
      component: f.control.component,
    });
  }

  // texts 是页面级事实，不随 region 过滤（后端语义关联需要完整文本层）
  const texts = graph.texts.map(toFactText);

  const payload: FormFactPayload = {
    controls,
    texts,
    structure: toStructure(regions, graph),
    page_context: opts?.pageContext || undefined,
  };

  return { payload, locators, excluded };
}

/** 本地回填定位表（snapshot / commit 阶段共用） */
export function buildFieldLocators(fields: FieldNode[]): {
  locators: FieldLocator[];
  excluded: FieldNode[];
} {
  const locators: FieldLocator[] = [];
  const excluded: FieldNode[] = [];
  for (const f of fields) {
    if (f.routeHint === 'skip' || f.routeHint === 'file' || f.routeHint === 'sign') {
      excluded.push(f);
      continue;
    }
    const type = toApiType(f);
    locators.push({
      id: f.fieldId,
      selector: f.locator.selector,
      type,
      options: f.options ?? undefined,
      name: f.locator.namePattern,
      inputType: f.control.type,
      frameId: f.frameId,
      backingSelector: f.locator.backingSelector,
      widget: f.control.widget,
      component: f.control.component,
    });
  }
  return { locators, excluded };
}

export function buildPageContext(meta: { title?: string; url?: string }): string {
  const title = meta.title?.trim() || '未命名页面';
  try {
    const host = meta.url ? new URL(meta.url).host : '';
    return host ? `${title}（${host}）` : title;
  } catch {
    return title;
  }
}
