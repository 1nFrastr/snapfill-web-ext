/** 标签级联解析 + 四向近邻文本 + 表格网格元信息。 */

import { cssEscape } from '@/lib/formgraph/css-escape';
import { looksLikeHash, norm, type TextNode } from '@/lib/formgraph/dom-utils';
import type { LabelSource, TableMeta } from '@/lib/formgraph/types';

function labelFor(el: Element): string | null {
  if (!el.id) return null;
  const lab = document.querySelector(`label[for="${cssEscape(el.id)}"]`);
  return norm(lab?.textContent) || null;
}

function wrappingLabel(el: Element): string | null {
  const lab = el.closest('label');
  if (!lab) return null;
  const clone = lab.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('input,select,textarea').forEach((n) => n.remove());
  return norm(clone.textContent) || null;
}

function ariaLabel(el: Element): string | null {
  const a = norm(el.getAttribute('aria-label'));
  if (a) return a;
  const ids = (el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean);
  if (!ids.length) return null;
  return (
    norm(ids.map((id) => document.getElementById(id)?.textContent).filter(Boolean).join(' ')) ||
    null
  );
}

function tableLeftOrHeader(el: Element): { text: string | null; source: LabelSource | null } {
  const td = el.closest('td,th');
  if (!td || !(td instanceof HTMLTableCellElement)) return { text: null, source: null };
  const tr = td.parentElement;
  if (!(tr instanceof HTMLTableRowElement)) return { text: null, source: null };
  const cells = [...tr.children].filter((c): c is HTMLTableCellElement => c instanceof HTMLTableCellElement);
  const idx = cells.indexOf(td);
  if (idx > 0) {
    const prevCell = cells[idx - 1];
    // 左邻格里如果本身就有控件，它是数据格而不是标签格（其文本多半是 option 文案），
    // 这种情况要落到表头去取列名
    const prevIsDataCell = Boolean(prevCell.querySelector('input,select,textarea,[contenteditable="true"]'));
    const prev = norm(prevCell.textContent);
    if (!prevIsDataCell && prev && prev.length < 80 && !looksLikeHash(prev)) {
      return { text: prev, source: 'table-left-cell' };
    }
  }
  const table = td.closest('table');
  const headRow = table?.querySelector('thead tr');
  if (headRow) {
    const head = headRow.children[idx];
    const t = norm(head?.textContent);
    if (t && !looksLikeHash(t)) return { text: t, source: 'table-header' };
  }
  return { text: null, source: null };
}

/**
 * radio 组会被去重成一个字段，此时 label 应该是"组问题"（如"本项目组是否含境外人员"），
 * 而不是某个选项的文案（如"是"）——选项文案已经进 options 了。
 * 拿不到组问题时返回 null，让原有级联继续兜底。
 */
function radioGroupQuestion(el: Element): { text: string; source: LabelSource } | null {
  if (!(el instanceof HTMLInputElement) || el.type !== 'radio' || !el.name) return null;
  const group = [...document.querySelectorAll<HTMLInputElement>(`input[type="radio"][name="${CSS.escape(el.name)}"]`)];
  if (group.length < 2) return null;

  const tbl = tableLeftOrHeader(el);
  if (tbl.text && tbl.source) return { text: tbl.text, source: tbl.source };

  const radiogroup = el.closest('[role="radiogroup"]');
  if (radiogroup) {
    const aria = ariaLabel(radiogroup);
    if (aria) return { text: aria, source: 'aria' };
  }

  // 组容器内、第一个选项之前的说明文字（<span>问题</span><label>是</label><label>否</label>）
  // 比 fieldset legend 更贴近该组，优先采用
  const container = group.reduce<Element | null>((acc, r) => {
    if (!acc) return r.parentElement;
    let a: Element | null = acc;
    while (a && !a.contains(r)) a = a.parentElement;
    return a;
  }, null);
  if (container) {
    let question = '';
    for (const child of container.children) {
      if (group.some((r) => child.contains(r))) break;
      const t = norm(child.textContent);
      if (t && t.length < 80 && !looksLikeHash(t)) question = t;
    }
    if (question) return { text: question, source: 'group-question' };
  }

  // 整组独占一个 fieldset 时，legend 兜底作组问题
  const fs = el.closest('fieldset');
  if (fs && fs.querySelectorAll('input[type="radio"]').length === group.length) {
    const legend = norm(fs.querySelector(':scope > legend')?.textContent);
    if (legend && legend.length < 80) return { text: legend, source: 'group-question' };
  }

  return null;
}

function nearestText(
  elRect: DOMRect,
  textNodes: TextNode[],
  mode: 'left' | 'right' | 'above' | 'below',
): { text: string; el: Element | null } {
  let best = '';
  let bestEl: Element | null = null;
  let bestScore = 1e18;
  for (const { t, r, el } of textNodes) {
    const dy = Math.abs((r.top + r.bottom) / 2 - (elRect.top + elRect.bottom) / 2);
    const dxLeft = elRect.left - r.right;
    const dxRight = r.left - elRect.right;
    const dxCenter = Math.abs((r.left + r.right) / 2 - (elRect.left + elRect.right) / 2);
    const dyAbove = elRect.top - r.bottom;
    const dyBelow = r.top - elRect.bottom;
    let score = 1e18;
    if (mode === 'left') {
      if (dxLeft < -20 || dxLeft > 320 || dy > 36) continue;
      score = dy * 3 + Math.abs(dxLeft);
    } else if (mode === 'right') {
      // 右侧文本常见于 checkbox/radio 的标签
      if (dxRight < -20 || dxRight > 240 || dy > 24) continue;
      score = dy * 3 + Math.abs(dxRight);
    } else if (mode === 'above') {
      if (dyAbove < -10 || dyAbove > 120 || dxCenter > Math.max(elRect.width, 240)) continue;
      score = dyAbove * 2 + dxCenter;
    } else {
      if (dyBelow < -10 || dyBelow > 120 || dxCenter > Math.max(elRect.width, 240)) continue;
      score = dyBelow * 2 + dxCenter;
    }
    if (score < bestScore) {
      bestScore = score;
      best = t;
      bestEl = el;
    }
  }
  return { text: best, el: bestEl };
}

export type ResolvedLabel = {
  label: string;
  labelSource: LabelSource;
  labelConfidence: 'high' | 'medium' | 'low';
  nearLabel: string;
  textLeft: string;
  textRight: string;
  textAbove: string;
  textBelow: string;
};

export function resolveLabel(
  el: Element,
  elRect: DOMRect,
  textNodes: TextNode[],
  opts?: { preferRight?: boolean },
): ResolvedLabel {
  type Cand = { text: string; source: LabelSource; conf: 'high' | 'medium' | 'low' };
  const candidates: Cand[] = [];

  // radio 组的"组问题"必须压过 wrapping-label（后者只是某个选项的文案）
  const group = radioGroupQuestion(el);
  if (group) candidates.push({ text: group.text, source: group.source, conf: 'high' });

  const a = labelFor(el);
  if (a) candidates.push({ text: a, source: 'label-for', conf: 'high' });
  const b = wrappingLabel(el);
  if (b) candidates.push({ text: b, source: 'wrapping-label', conf: 'high' });
  const c = ariaLabel(el);
  if (c) candidates.push({ text: c, source: 'aria', conf: 'high' });

  // 表格左格/表头是结构性信号（与后端 PRM 对"空白格 vs 标签格"的判定一致），
  // 优先于纯几何近邻猜测
  const tbl = tableLeftOrHeader(el);
  if (tbl.text && tbl.source) {
    candidates.push({ text: tbl.text, source: tbl.source, conf: 'high' });
  }

  const left = nearestText(elRect, textNodes, 'left');
  const right = nearestText(elRect, textNodes, 'right');
  const above = nearestText(elRect, textNodes, 'above');
  const below = nearestText(elRect, textNodes, 'below');

  // checkbox/radio 常见标签在右侧；其余控件左/上优先
  if (opts?.preferRight && right.text) {
    candidates.push({ text: right.text, source: 'near-right', conf: 'medium' });
  }
  if (left.text) candidates.push({ text: left.text, source: 'near-left', conf: 'medium' });
  if (above.text) candidates.push({ text: above.text, source: 'near-above', conf: 'medium' });
  if (!opts?.preferRight && right.text) {
    candidates.push({ text: right.text, source: 'near-right', conf: 'medium' });
  }

  const ph = norm(el.getAttribute('placeholder'));
  if (ph) candidates.push({ text: ph, source: 'placeholder', conf: 'low' });
  const name = norm(el.getAttribute('name'));
  if (name && !looksLikeHash(name)) candidates.push({ text: name, source: 'name', conf: 'low' });
  const id = norm(el.id);
  if (id && !looksLikeHash(id)) candidates.push({ text: id, source: 'id', conf: 'low' });

  const picked =
    candidates.find((x) => !looksLikeHash(x.text)) ||
    candidates[0] || { text: '', source: 'empty' as const, conf: 'low' as const };

  return {
    label: picked.text,
    labelSource: picked.source,
    labelConfidence: picked.conf,
    nearLabel: left.text || right.text || above.text || '',
    textLeft: left.text,
    textRight: right.text,
    textAbove: above.text,
    textBelow: below.text,
  };
}

export function tableMeta(el: Element, visible: Element[]): TableMeta | null {
  const td = el.closest('td,th');
  if (!td || !(td instanceof HTMLTableCellElement)) return null;
  const table = td.closest('table');
  if (!table) return null;
  const tables = [...document.querySelectorAll('table')];
  const tr = td.parentElement;
  return {
    tableIndex: tables.indexOf(table),
    row: tr instanceof HTMLTableRowElement ? tr.rowIndex : -1,
    col: td.cellIndex,
    colspan: td.colSpan || 1,
    rowspan: td.rowSpan || 1,
    controlsInCell: visible.filter((c) => td.contains(c)).length,
  };
}
