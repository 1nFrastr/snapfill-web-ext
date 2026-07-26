/**
 * 抽取产物（trace）：control_no 当桥梁的人工核对件。
 *
 * 三件套始终成对产出，缺一不可核对：
 * - form_graph.json — 完整 FormGraph（含 controlNo），机器可回归断言
 * - controls.md     — 以 control_no 为主键的映射表，人工逐行读"编号 ↔ 题干 ↔ 控件"
 * - overlay.png     — 同一批 control_no 画在页面截图上（见 overlay.ts）
 *
 * 本文件是纯函数、无 DOM 依赖：扩展运行时与 playwright harness 共用同一套组装逻辑，
 * 避免两边各写一份导致产物口径不一致。
 */

import type { FieldNode, FormGraph, RegionNode } from '@/lib/formgraph/types';

type KeyedField = Pick<FieldNode, 'frameId' | 'controlNo' | 'panelKey'>;

/**
 * 编号显示值的生成器。`controlNo` 只在「一个 frame 的一个面板」内 1-based，
 * 多 frame / 多面板时必须加前缀，否则三个页签各自从 1 编起，映射表主键直接撞车，
 * 编号也就不再能当"截图 ↔ 表格"的桥梁。
 *
 * 单 frame 单面板（绝大多数页面）退化成纯数字，保持编号最短好念。
 */
export function makeControlKey(graph: FormGraph): (field: KeyedField) => string {
  const panelOrdinal = new Map(graph.panels.map((p, i) => [`${p.frameId}::${p.key}`, i + 1]));
  const multiFrame = new Set(graph.fields.map((f) => f.frameId)).size > 1;
  const multiPanel = new Set(graph.fields.map((f) => `${f.frameId}::${f.panelKey}`)).size > 1;

  return (field) => {
    const parts: string[] = [];
    if (multiFrame || field.frameId !== 0) parts.push(`f${field.frameId}`);
    if (multiPanel) parts.push(`p${panelOrdinal.get(`${field.frameId}::${field.panelKey}`) ?? '?'}`);
    parts.push(String(field.controlNo));
    return parts.join('-');
  };
}

/** 面板序号：控件表按 frame → 面板 → 阅读顺序排，而不是三个面板的编号交叉在一起 */
function panelRank(graph: FormGraph): (field: KeyedField) => number {
  const rank = new Map(graph.panels.map((p, i) => [`${p.frameId}::${p.key}`, i]));
  return (field) => rank.get(`${field.frameId}::${field.panelKey}`) ?? 0;
}

export type ControlRow = {
  control_key: string;
  control_no: number;
  frame_id: number;
  panel: string;
  field_id: string;
  label: string;
  label_source: string;
  label_confidence: string;
  near_hint: string;
  region: string;
  control: string;
  route: string;
  flags: string;
  options: number;
  existing_value: string;
  selector: string;
};

function describeControl(f: FieldNode): string {
  const base = f.control.type ? `${f.control.tag}:${f.control.type}` : f.control.tag;
  const widget = f.control.component ? `${f.control.widget}/${f.control.component}` : f.control.widget;
  return `${base}(${widget})`;
}

function describeFlags(f: FieldNode, region: RegionNode | undefined): string {
  const flags: string[] = [];
  if (f.required) flags.push('required');
  if (f.readonly) flags.push('readonly');
  if (f.disabled) flags.push('disabled');
  if (f.siblingSlot && f.siblingSlot.count > 1) flags.push(`slot ${f.siblingSlot.index + 1}/${f.siblingSlot.count}`);
  if (f.table) flags.push(`td r${f.table.row}c${f.table.col}`);
  if (f.rowIndex != null) flags.push(`row ${f.rowIndex}`);
  if (region?.gatedBy) flags.push(`gated:${region.gatedBy.label}=${region.gatedBy.whenValue}`);
  return flags.join(' ');
}

function describeValue(v: FieldNode['existingValue']): string {
  if (v == null) return '';
  if (Array.isArray(v)) return v.join('|');
  return String(v);
}

export function buildControlRows(graph: FormGraph): ControlRow[] {
  const regionById = new Map(graph.regions.map((r) => [r.regionId, r]));
  const panelById = new Map(graph.panels.map((p) => [`${p.frameId}::${p.key}`, p]));
  const keyOf = makeControlKey(graph);
  const rankOf = panelRank(graph);

  return [...graph.fields]
    .sort((a, b) => a.frameId - b.frameId || rankOf(a) - rankOf(b) || a.controlNo - b.controlNo)
    .map((f) => {
      const region = regionById.get(f.regionId);
      return {
        control_key: keyOf(f),
        control_no: f.controlNo,
        frame_id: f.frameId,
        panel: panelById.get(`${f.frameId}::${f.panelKey}`)?.label ?? '',
        field_id: f.fieldId,
        label: f.label || f.nearLabel,
        label_source: f.labelSource,
        label_confidence: f.labelConfidence,
        near_hint: [f.neighbors.textLeft, f.neighbors.textAbove].filter(Boolean).join(' / '),
        region: region ? `${region.name || region.regionId}[${region.kind}]` : f.regionId,
        control: describeControl(f),
        route: f.routeHint,
        flags: describeFlags(f, region),
        options: f.options?.length ?? 0,
        existing_value: describeValue(f.existingValue),
        selector: f.locator.selector,
      };
    });
}

function mdCell(s: string | number): string {
  return String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

/** 人工核对用的映射表：一行一个控件，主键与截图徽标上的编号一致 */
export function renderControlTable(rows: ControlRow[]): string {
  const multiPanel = new Set(rows.map((r) => r.panel)).size > 1;
  const head =
    `| # |${multiPanel ? ' 面板 |' : ''} 题干（HTML事实） | 来源/置信 | 近邻文本（核对提示） | 区域 | 控件 | 路由 | 标记 | 现值 | selector |`;
  const sep = `|---|${multiPanel ? '---|' : ''}---|---|---|---|---|---|---|---|---|`;
  const body = rows.map((r) =>
    [
      r.control_key,
      ...(multiPanel ? [mdCell(r.panel)] : []),
      mdCell(r.label),
      `${r.label_source}/${r.label_confidence}`,
      mdCell(r.near_hint),
      mdCell(r.region),
      r.control + (r.options ? ` ${r.options}项` : ''),
      r.route,
      mdCell(r.flags),
      mdCell(r.existing_value),
      mdCell(r.selector),
    ].join(' | '),
  );
  return [head, sep, ...body.map((line) => `| ${line} |`)].join('\n');
}

export type TraceSummaryLine = string;

export function renderSummary(graph: FormGraph, pageContext?: string): TraceSummaryLine[] {
  const m = graph.metrics;
  const lines = [
    `page: ${pageContext || graph.source.title || graph.source.url || '(未知)'}`,
    `capturedAt: ${graph.source.capturedAt}`,
    `metrics: controlsSeen=${m.controlsSeen} fieldsResolved=${m.fieldsResolved} coverage=${m.coverage.toFixed(2)} ` +
      `labeledRate=${m.labeledRate.toFixed(2)} regions=${m.regionsClassified}(ambiguous=${m.regionsAmbiguous}) ` +
      `interactives=${m.interactivesActivated}/${m.interactivesActivated + m.interactivesPending} unresolved=${m.unresolvedCount}`,
  ];

  const droppedEntries = Object.entries(m.dropped).sort((a, b) => b[1] - a[1]);
  if (droppedEntries.length) {
    lines.push(`dropped: ${droppedEntries.map(([reason, n]) => `${reason}=${n}`).join(' ')}`);
  }
  if (graph.panels.length) {
    lines.push(
      `panels: ${graph.panels
        .map((p) => `${p.label || '(默认)'}${p.captured ? `=${graph.fields.filter((f) => f.panelKey === p.key).length}` : ':未抽取'}`)
        .join(' | ')}`,
    );
  }

  for (const r of graph.regions) {
    const extra: string[] = [];
    if (r.repeat) extra.push(`repeat rowCount=${r.repeat.rowCount} add=${r.repeat.addTargetLabel || '-'}`);
    if (r.gatedBy) extra.push(`gatedBy=${r.gatedBy.label}=${r.gatedBy.whenValue}`);
    if (r.table?.columns.length) extra.push(`cols=[${r.table.columns.map((c) => c.label).join(',')}]`);
    lines.push(
      `region [${r.kind}] ${r.name || r.regionId} fields=${r.fieldIds.length} ` +
        `evidence=${r.evidence.join(',') || '-'} ${extra.join(' ')}`.trimEnd(),
    );
  }
  for (const u of graph.unresolved) lines.push(`unresolved [${u.reason}] ${u.note} ${u.selector ?? ''}`.trimEnd());
  return lines;
}

export type FormGraphTrace = {
  /** form_graph.json 的内容 */
  formGraph: FormGraph;
  /** controls.md 的行数据（也内嵌进 JSON，便于机器断言） */
  controls: ControlRow[];
  /** controls.md 的文本 */
  markdown: string;
  summary: TraceSummaryLine[];
  pageContext?: string;
};

export function buildTrace(graph: FormGraph, pageContext?: string): FormGraphTrace {
  const controls = buildControlRows(graph);
  return {
    formGraph: graph,
    controls,
    markdown: [
      `# 控件映射表（control_no 为主键，与 overlay.png 上的徽标一一对应）`,
      '',
      ...renderSummary(graph, pageContext).map((l) => `- ${l}`),
      '',
      renderControlTable(controls),
      '',
    ].join('\n'),
    summary: renderSummary(graph, pageContext),
    pageContext,
  };
}
