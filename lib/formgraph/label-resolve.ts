/**
 * 标签解析：只保留 HTML/DOM 规范级事实关联。
 * 几何猜题干、内容噪声过滤留给后端在完整 texts 层上处理。
 */

import { cssEscape } from '@/lib/formgraph/css-escape';
import { hasDataControl, looksLikeHash, norm, type TextNode } from '@/lib/formgraph/dom-utils';
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

/** thead 同列文本：表格结构事实（列索引对齐），非几何猜测。 */
function tableHeader(el: Element, layoutCell = false): string | null {
  if (layoutCell) return null;
  const td = el.closest('td,th');
  if (!td || !(td instanceof HTMLTableCellElement)) return null;
  const table = td.closest('table');
  const headRow = table?.querySelector('thead tr');
  if (!headRow) return null;
  const t = norm(headRow.children[td.cellIndex]?.textContent);
  return t && !looksLikeHash(t) ? t : null;
}

/**
 * radio 组问题：DOM 结构事实（radiogroup aria / fieldset legend / 组容器内选项前文本）。
 */
function radioGroupQuestion(el: Element): { text: string; source: LabelSource } | null {
  if (!(el instanceof HTMLInputElement) || el.type !== 'radio' || !el.name) return null;
  const group = [
    ...document.querySelectorAll<HTMLInputElement>(`input[type="radio"][name="${CSS.escape(el.name)}"]`),
  ];
  if (group.length < 2) return null;

  const radiogroup = el.closest('[role="radiogroup"]');
  if (radiogroup) {
    const aria = ariaLabel(radiogroup);
    if (aria) return { text: aria, source: 'aria' };
  }

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
      if (hasDataControl(child)) continue;
      const t = norm(child.textContent);
      if (t && !looksLikeHash(t)) question = t;
    }
    if (question) return { text: question, source: 'group-question' };
  }

  const fs = el.closest('fieldset');
  if (fs && fs.querySelectorAll('input[type="radio"]').length === group.length) {
    const legend = norm(fs.querySelector(':scope > legend')?.textContent);
    if (legend) return { text: legend, source: 'group-question' };
  }

  return null;
}

/** 四向最近文本：作为空间邻居事实留给本地 Agent / texts 对照，不进 label。 */
function nearestText(
  elRect: DOMRect,
  textNodes: TextNode[],
  mode: 'left' | 'right' | 'above' | 'below',
): string {
  let best = '';
  let bestScore = 1e18;
  for (const { t, r } of textNodes) {
    const dy = Math.abs((r.top + r.bottom) / 2 - (elRect.top + elRect.bottom) / 2);
    const dxLeft = elRect.left - r.right;
    const dxRight = r.left - elRect.right;
    const dxCenter = Math.abs((r.left + r.right) / 2 - (elRect.left + elRect.right) / 2);
    const dyAbove = elRect.top - r.bottom;
    const dyBelow = r.top - elRect.bottom;
    let score = 1e18;
    if (mode === 'left') {
      if (dxLeft < -20 || dxLeft > 2000 || dy > 80) continue;
      score = dy * 3 + Math.abs(dxLeft);
    } else if (mode === 'right') {
      if (dxRight < -20 || dxRight > 2000 || dy > 80) continue;
      score = dy * 3 + Math.abs(dxRight);
    } else if (mode === 'above') {
      if (dyAbove < -10 || dyAbove > 2000 || dxCenter > Math.max(elRect.width, 800)) continue;
      score = dyAbove * 2 + dxCenter;
    } else {
      if (dyBelow < -10 || dyBelow > 2000 || dxCenter > Math.max(elRect.width, 800)) continue;
      score = dyBelow * 2 + dxCenter;
    }
    if (score < bestScore) {
      bestScore = score;
      best = t;
    }
  }
  return best;
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

/** 仅 HTML 事实源写入 label；近邻文本只填 neighbors，供本地核对。 */
export function resolveLabel(
  el: Element,
  elRect: DOMRect,
  textNodes: TextNode[],
  opts?: { layoutCell?: boolean },
): ResolvedLabel {
  type Cand = { text: string; source: LabelSource; conf: 'high' | 'medium' | 'low' };
  const candidates: Cand[] = [];

  const group = radioGroupQuestion(el);
  if (group) candidates.push({ text: group.text, source: group.source, conf: 'high' });

  const a = labelFor(el);
  if (a) candidates.push({ text: a, source: 'label-for', conf: 'high' });
  const b = wrappingLabel(el);
  if (b) candidates.push({ text: b, source: 'wrapping-label', conf: 'high' });
  const c = ariaLabel(el);
  if (c) candidates.push({ text: c, source: 'aria', conf: 'high' });

  const head = tableHeader(el, opts?.layoutCell);
  if (head) candidates.push({ text: head, source: 'table-header', conf: 'high' });

  const ph = norm(el.getAttribute('placeholder'));
  if (ph) candidates.push({ text: ph, source: 'placeholder', conf: 'low' });

  const picked =
    candidates.find((x) => !looksLikeHash(x.text)) ||
    candidates[0] || { text: '', source: 'empty' as const, conf: 'low' as const };

  const left = nearestText(elRect, textNodes, 'left');
  const right = nearestText(elRect, textNodes, 'right');
  const above = nearestText(elRect, textNodes, 'above');
  const below = nearestText(elRect, textNodes, 'below');

  return {
    label: picked.text,
    labelSource: picked.source,
    labelConfidence: picked.conf,
    nearLabel: left || right || above || '',
    textLeft: left,
    textRight: right,
    textAbove: above,
    textBelow: below,
  };
}

export function tableMeta(
  el: Element,
  visible: Element[],
  rowsInCell: ReadonlyMap<Element, number>,
): TableMeta | null {
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
    rowsInCell: rowsInCell.get(td) ?? 1,
  };
}
