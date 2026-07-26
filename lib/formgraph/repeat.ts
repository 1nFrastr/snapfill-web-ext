/**
 * 重复块 / 列表区 / 门控候选侦测。
 *
 * 关键设计（对齐改造计划）：
 * - 模板行优先：能从隐藏模板行/首行样例读出列结构的，不依赖点击。
 * - gatedBy 的最终写入不在这里做静态匹配，而是在 Agent 激活候选后由
 *   diff/merge 阶段动态打标（见 lib/formgraph/merge.ts + agent 工具 activate）。
 *   本模块只负责把"值得一试的开关"识别出来，交给 Agent 决策是否激活。
 */

import { norm, isAncestorHidden, isVisible, cssPath, rectOf } from '@/lib/formgraph/dom-utils';
import type { WorkingField, WorkingInteractive } from '@/lib/formgraph/internal-types';
import type { PanelRef, RepeatInfo } from '@/lib/formgraph/types';
import { parseArrayName } from '@/lib/formgraph/identity';

const ADD_BUTTON_RE = /添加|新增|增加一?[行项]|add\s*(row|item|person|entry)?|^\+$|^\+\s*add/i;
const TEMPLATE_CLASS_RE = /template|tpl|placeholder-row/i;
const BINARY_YES_RE = /^(是|有|yes|y)$/i;
const BINARY_NO_RE = /^(否|无|no|n)$/i;

/** 表格内隐藏的模板行（display:none / [hidden] / class 含 template）。 */
export function findTemplateRow(table: HTMLTableElement): HTMLTableRowElement | null {
  const rows = [...table.querySelectorAll('tr')];
  for (const tr of rows) {
    if (!(tr instanceof HTMLTableRowElement)) continue;
    const hiddenByAttr = tr.hidden || tr.style.display === 'none';
    const hiddenByClass = TEMPLATE_CLASS_RE.test(tr.className || '');
    if (hiddenByAttr || hiddenByClass) return tr;
  }
  const tpl = table.querySelector('template');
  if (tpl?.content) {
    const tr = tpl.content.querySelector('tr');
    if (tr instanceof HTMLTableRowElement) return tr;
  }
  return null;
}

/** 从 thead / 隐藏模板行 / 首个数据行 推断列定义，不依赖点击。 */
export function inferTableColumns(
  table: HTMLTableElement,
  dataRows: HTMLTableRowElement[],
): { key: string; label: string }[] {
  const headRow = table.querySelector('thead tr');
  if (headRow) {
    return [...headRow.children].map((c, i) => ({
      key: `col_${i}`,
      label: norm(c.textContent) || `列${i + 1}`,
    }));
  }

  const templateRow = findTemplateRow(table);
  const sourceRow = templateRow || dataRows[0];
  if (!sourceRow) return [];

  return [...sourceRow.children].map((cell, i) => {
    const control = cell.querySelector('input,select,textarea');
    const name = control?.getAttribute('name') || '';
    const parsed = parseArrayName(name);
    const label =
      norm(cell.getAttribute('data-label')) ||
      norm(control?.getAttribute('placeholder')) ||
      norm(cell.textContent) ||
      parsed?.columnKey ||
      `列${i + 1}`;
    return { key: parsed?.columnKey || `col_${i}`, label };
  });
}

export type TableClassification = {
  kind: 'kv' | 'multiline' | 'repeat_group';
  columns: { key: string; label: string }[];
  repeat?: RepeatInfo;
};

/**
 * 判定一个 <table> 区域是 KV（表单栅格）、multiline（固定枚举列表，如附件清单）
 * 还是 repeat_group（可增删的重复块，如人员信息）。
 */
export function classifyTable(
  table: HTMLTableElement,
  fieldsInTable: WorkingField[],
): TableClassification {
  const rows = [...table.querySelectorAll('tbody tr, tr')].filter(
    (r): r is HTMLTableRowElement =>
      r instanceof HTMLTableRowElement && !r.closest('thead') && isVisible(r),
  );

  // 数组 name 模式（person[0].name）是重复块最强信号
  const arrayFields = fieldsInTable
    .map((f) => ({ f, parsed: parseArrayName(f.el.getAttribute('name') || '') }))
    .filter((x): x is { f: WorkingField; parsed: NonNullable<ReturnType<typeof parseArrayName>> } => Boolean(x.parsed));

  const templateRow = findTemplateRow(table);
  const addButton = findAddButtonNear(table);

  if (arrayFields.length > 0) {
    const rowIndices = new Set(arrayFields.map((x) => x.parsed.rowIndex));
    const minRow = Math.min(...rowIndices);
    const templateIds = arrayFields
      .filter((x) => x.parsed.rowIndex === minRow)
      .map((x) => x.f.fieldId);
    return {
      kind: 'repeat_group',
      columns: inferTableColumns(table, rows),
      repeat: {
        templateFieldIds: templateIds,
        rowCount: rowIndices.size,
        addTargetSelector: addButton ? cssPath(addButton) : undefined,
        addTargetLabel: addButton ? norm(addButton.textContent) : undefined,
      },
    };
  }

  const hasHeader = Boolean(table.querySelector('thead'));
  if (hasHeader && (rows.length > 1 || addButton || templateRow)) {
    const firstRowFieldIds = fieldsInTable
      .filter((f) => f.el.closest('tr') === (rows[0] || templateRow))
      .map((f) => f.fieldId);
    if (addButton || templateRow) {
      return {
        kind: 'repeat_group',
        columns: inferTableColumns(table, rows),
        repeat: {
          templateFieldIds: firstRowFieldIds,
          rowCount: rows.length,
          addTargetSelector: addButton ? cssPath(addButton) : undefined,
          addTargetLabel: addButton ? norm(addButton.textContent) : undefined,
        },
      };
    }
    return { kind: 'multiline', columns: inferTableColumns(table, rows) };
  }

  return { kind: 'kv', columns: [] };
}

/** 在容器前后邻近范围内找"添加"类按钮（不跨太远，避免误配到页面其他按钮）。 */
export function findAddButtonNear(container: Element): Element | null {
  const candidates = new Set<Element>();
  let sib: Element | null = container.nextElementSibling;
  for (let i = 0; i < 3 && sib; i += 1) {
    candidates.add(sib);
    sib = sib.nextElementSibling;
  }
  const parent = container.parentElement;
  if (parent) {
    for (const btn of parent.querySelectorAll('button,a,[role="button"]')) {
      candidates.add(btn);
    }
  }
  for (const el of candidates) {
    if (!(el instanceof HTMLElement)) continue;
    const text = norm(el.textContent);
    const matches =
      ADD_BUTTON_RE.test(text) ||
      (el instanceof HTMLElement && ADD_BUTTON_RE.test(el.className || ''));
    if (matches && isVisible(el)) return el;
    const inner = el.querySelector('button,a,[role="button"]');
    if (inner && ADD_BUTTON_RE.test(norm(inner.textContent)) && isVisible(inner)) return inner;
  }
  return null;
}

/**
 * interactiveId 同样要求跨快照稳定（同一个按钮/tab 再抽一次要拿到同一个 id），
 * 否则 activate 后无法在下一次 snapshotForm 里认出"这是刚才点过的那个"。
 * 用元素的 cssPath 派生；调用方需在单次 extractFormGraph 内共享同一个 used 集合去重。
 */
export function interactiveKeyOf(prefix: string, el: Element): string {
  return `${prefix}_${cssPath(el)}`.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 150);
}

export function makeInteractiveIdFactory() {
  const used = new Set<string>();
  return (prefix: string, el: Element): string => {
    const base = interactiveKeyOf(prefix, el);
    let id = base;
    let n = 2;
    while (used.has(id)) {
      id = `${base}__${n}`;
      n += 1;
    }
    used.add(id);
    return id;
  };
}

const TAB_GROUP_SELECTOR =
  '.tabs, .nav-tabs, [role="tablist"], .el-tabs__nav, .ant-tabs-nav, .steps, .wizard-steps, .step-nav';
const TAB_ITEM_SELECTOR = '[role="tab"], .el-tabs__item, .ant-tabs-tab';
const ACTIVE_CLASS_RE = /\bactive\b|\bis-active\b|\bselected\b|\bcurrent\b/i;
const WIZARD_CONTAINER_RE = /steps|wizard/i;

/**
 * 激活标记可能打在按钮本身，也可能打在外层列表项（政务系统常见 `<li class="active"><a>页签</a></li>`）。
 * 只看按钮会把当前面板误判成"还没去过的 tab"，进而既认不出自己在哪个面板，也会重复点击。
 */
function isActiveTab(btn: Element): boolean {
  const marked = (n: Element | null) =>
    n instanceof HTMLElement &&
    (n.getAttribute('aria-selected') === 'true' || ACTIVE_CLASS_RE.test(n.className || ''));
  return marked(btn) || marked(btn.closest('li, [role="tab"], .el-tabs__item, .ant-tabs-tab'));
}

/** 页面上的 tab 按钮（含激活的那个），按 DOM 顺序去重 */
function collectTabButtons(root: ParentNode): { el: HTMLElement; isWizard: boolean }[] {
  const out: { el: HTMLElement; isWizard: boolean }[] = [];
  const seen = new Set<Element>();

  for (const group of root.querySelectorAll(TAB_GROUP_SELECTOR)) {
    if (!(group instanceof HTMLElement) || !isVisible(group)) continue;
    const buttons = [...group.querySelectorAll('button, a, [role="tab"]')].filter(
      (b): b is HTMLElement => b instanceof HTMLElement && isVisible(b),
    );
    if (buttons.length < 2) continue;
    const isWizard = WIZARD_CONTAINER_RE.test(group.className || '');
    for (const el of buttons.slice(0, 8)) {
      if (seen.has(el) || !norm(el.textContent)) continue;
      seen.add(el);
      out.push({ el, isWizard });
    }
  }

  // role=tab / el-tabs 等语义化控件作为补充覆盖
  for (const el of root.querySelectorAll(TAB_ITEM_SELECTOR)) {
    if (!(el instanceof HTMLElement) || !isVisible(el) || seen.has(el)) continue;
    if (!norm(el.textContent)) continue;
    seen.add(el);
    out.push({ el, isWizard: false });
  }

  return out;
}

/**
 * 面板清单与当前激活面板。key 与 tab 的 interactiveId 同源，
 * 所以"Agent 刚激活的那个 tab"和"下一次快照所在的面板"能对上号。
 */
export function detectPanels(root: ParentNode): { panels: PanelRef[]; active: PanelRef | null } {
  const buttons = collectTabButtons(root);
  if (buttons.length < 2) return { panels: [], active: null };

  const panels: PanelRef[] = [];
  let active: PanelRef | null = null;
  for (const { el } of buttons) {
    const ref: PanelRef = { key: interactiveKeyOf('tab', el), label: norm(el.textContent) };
    panels.push(ref);
    if (!active && isActiveTab(el)) active = ref;
  }
  return { panels, active };
}

/** Tabs / 步骤条 / Accordion：已渲染但当前隐藏的面板，值得 Agent 尝试切换查看。 */
export function detectTabsAndAccordions(
  root: ParentNode,
  frameId: number,
  nextInteractiveId: ReturnType<typeof makeInteractiveIdFactory>,
): WorkingInteractive[] {
  const out: WorkingInteractive[] = [];
  const seen = new Set<Element>();

  for (const { el: btn, isWizard } of collectTabButtons(root)) {
    seen.add(btn);
    if (isActiveTab(btn)) continue; // 当前面板正在抽，不必再点
    out.push({
      interactiveId: nextInteractiveId(isWizard ? 'wizard' : 'tab', btn),
      kind: isWizard ? 'wizard-next' : 'tab',
      label: norm(btn.textContent),
      frameId,
      rect: rectOf(btn),
      selector: cssPath(btn),
      status: 'pending',
      el: btn,
    });
  }

  const accordionHeaders = root.querySelectorAll(
    '[aria-expanded="false"], .collapse-title, .el-collapse-item__header:not(.is-active)',
  );
  for (const header of accordionHeaders) {
    if (!(header instanceof HTMLElement) || !isVisible(header) || seen.has(header)) continue;
    // combobox/select 触发器只是"展开下拉选项"，不是揭示新表单区块的手风琴，交给 openOptions 工具处理
    const role = header.getAttribute('role');
    if (role === 'combobox' || role === 'listbox' || header.closest('[role="combobox"]')) continue;
    const label = norm(header.textContent);
    if (!label) continue;
    seen.add(header);
    out.push({
      interactiveId: nextInteractiveId('accordion', header),
      kind: 'accordion',
      label,
      frameId,
      rect: rectOf(header),
      selector: cssPath(header),
      status: 'pending',
      el: header,
    });
  }

  return out;
}

/**
 * 二元语义的 radio 门控候选：选"是"后可能揭示新的受控区域。
 *
 * 注意 radio 组在抽取阶段已按 name 去重成单个字段，所以这里要从字段的 options
 * 判断是否二元，再回到 DOM 找"是"那一个 radio 作为激活目标。
 */
export function detectGateCandidates(
  fields: WorkingField[],
  frameId: number,
  nextInteractiveId: ReturnType<typeof makeInteractiveIdFactory>,
): WorkingInteractive[] {
  const out: WorkingInteractive[] = [];

  for (const f of fields) {
    if (f.control.tag !== 'input' || f.control.type !== 'radio') continue;
    const options = f.options ?? [];
    if (options.length !== 2) continue;
    const yesOption = options.find((o) => BINARY_YES_RE.test(norm(o.label)) || BINARY_YES_RE.test(norm(o.value)));
    const hasNo = options.some((o) => BINARY_NO_RE.test(norm(o.label)) || BINARY_NO_RE.test(norm(o.value)));
    if (!yesOption || !hasNo) continue;

    const name = f.el.getAttribute('name');
    if (!name) continue;
    const yesEl = [...document.querySelectorAll<HTMLInputElement>(`input[type="radio"][name="${CSS.escape(name)}"]`)].find(
      (r) => r.value === yesOption.value,
    );
    if (!yesEl || yesEl.checked) continue; // 已选中说明受控区大概率已展示

    out.push({
      interactiveId: nextInteractiveId('gate', yesEl),
      kind: 'gate-candidate',
      label: f.label || f.nearLabel || '未命名开关',
      frameId,
      rect: f.rect,
      selector: cssPath(yesEl),
      status: 'pending',
      suggestedValue: yesOption.value,
      el: yesEl,
    });
  }

  return out;
}

const DIALOG_TRIGGER_RE = /新增|添加|录入|填写|编辑|维护|选择|上传|add|new|edit|select/i;

/**
 * 弹窗触发器：点击后在 <dialog>/modal 里展开一整个子表单（典型如"新增紧急联系人"）。
 * 页面上已经存在但尚未打开的 dialog/modal 容器是最强信号——它内部的字段现在抽不到，
 * 必须靠 Agent 点开再快照。
 */
export function detectDialogTriggers(
  root: ParentNode,
  frameId: number,
  nextInteractiveId: ReturnType<typeof makeInteractiveIdFactory>,
  skip: Set<Element>,
): WorkingInteractive[] {
  const closedDialogs = [...root.querySelectorAll('dialog, [role="dialog"], .modal, .el-dialog, .ant-modal')].filter(
    (d) => !isVisible(d) && d.querySelector('input,select,textarea,[contenteditable="true"]'),
  );
  if (!closedDialogs.length) return [];

  const out: WorkingInteractive[] = [];
  for (const btn of root.querySelectorAll('button,a,[role="button"]')) {
    if (!(btn instanceof HTMLElement) || !isVisible(btn) || skip.has(btn)) continue;
    if (btn.closest('dialog, [role="dialog"], .modal')) continue; // 弹窗内部的按钮不是触发器
    const label = norm(btn.textContent);
    if (!label || label.length > 30 || !DIALOG_TRIGGER_RE.test(label)) continue;
    out.push({
      interactiveId: nextInteractiveId('dialog', btn),
      kind: 'dialog-trigger',
      label,
      frameId,
      rect: { x: 0, y: 0, w: 0, h: 0 },
      selector: cssPath(btn),
      status: 'pending',
      el: btn,
    });
  }
  return out;
}

export { isAncestorHidden };
