import { cssEscape } from '@/lib/parser/css-escape';

function normalizeText(text: string | null | undefined): string {
  return (text ?? '').replace(/\s+/g, ' ').trim();
}

function labelFromFor(el: Element): string | null {
  const id = el.getAttribute('id');
  if (!id) return null;
  const escaped = cssEscape(id);
  const lab = document.querySelector(`label[for="${escaped}"]`);
  return lab ? normalizeText(lab.textContent) : null;
}

function wrappingLabel(el: Element): string | null {
  const lab = el.closest('label');
  if (!lab) return null;
  const clone = lab.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('input, select, textarea').forEach((n) => n.remove());
  return normalizeText(clone.textContent);
}

function ariaOrPlaceholder(el: Element): string | null {
  const aria = normalizeText(el.getAttribute('aria-label'));
  if (aria) return aria;
  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    const parts = labelledBy
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent)
      .map(normalizeText)
      .filter(Boolean);
    if (parts.length) return parts.join(' ');
  }
  const ph = normalizeText(el.getAttribute('placeholder'));
  if (ph) return ph;
  const title = normalizeText(el.getAttribute('title'));
  if (title) return title;
  return null;
}

/** 表格布局：取同行左侧 th/td 文本，或同列 thead */
function tableLabel(el: Element): string | null {
  const td = el.closest('td, th');
  if (!td || !(td instanceof HTMLTableCellElement)) return null;
  const tr = td.parentElement;
  if (!(tr instanceof HTMLTableRowElement)) return null;

  const cells = [...tr.children].filter(
    (c): c is HTMLTableCellElement => c instanceof HTMLTableCellElement,
  );
  const idx = cells.indexOf(td);
  if (idx > 0) {
    const prev = normalizeText(cells[idx - 1].textContent);
    if (prev && prev.length < 80) return prev;
  }

  const table = td.closest('table');
  const headRow = table?.querySelector('thead tr');
  if (headRow) {
    const headCells = [...headRow.children];
    const head = headCells[idx];
    if (head) {
      const t = normalizeText(head.textContent);
      if (t) return t;
    }
  }
  return null;
}

function antOrBootstrapLabel(el: Element): string | null {
  const item = el.closest(
    '.ant-form-item, .form-group, .mb-3, .field, .form-field, .el-form-item',
  );
  if (!item) return null;
  const lab = item.querySelector(
    'label, .ant-form-item-label, .el-form-item__label, .form-label, .control-label',
  );
  return lab ? normalizeText(lab.textContent) : null;
}

export function resolveLabel(el: Element): string {
  return (
    labelFromFor(el) ||
    wrappingLabel(el) ||
    antOrBootstrapLabel(el) ||
    tableLabel(el) ||
    ariaOrPlaceholder(el) ||
    normalizeText(el.getAttribute('name')) ||
    normalizeText(el.getAttribute('id')) ||
    '未命名字段'
  );
}

export function nearbyContext(el: Element, maxLen = 120): string {
  const section =
    el.closest('fieldset, section, .card, .panel, .ant-card, [data-section]') ??
    el.closest('form') ??
    el.parentElement;
  if (!section) return '';
  const legend = section.querySelector('legend, h1, h2, h3, h4, .card-title, .section-title');
  const title = normalizeText(legend?.textContent);
  const name = el.getAttribute('name') ?? '';
  const blob = [title, name].filter(Boolean).join(' · ');
  return blob.slice(0, maxLen);
}

export function sectionHintFromDom(el: Element): string | undefined {
  const fs = el.closest('fieldset, [data-section], section');
  if (!fs) return undefined;
  const data = fs.getAttribute('data-section');
  if (data) return data;
  const legend = fs.querySelector('legend, h2, h3, .section-title');
  const t = normalizeText(legend?.textContent);
  return t || undefined;
}
