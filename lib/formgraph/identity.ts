/** 字段稳定身份：多信号组合，抵抗随机 hash id/name 与刷新后重排。 */

import { looksLikeHash, norm, rectOf } from '@/lib/formgraph/dom-utils';

export type ArrayNamePattern = {
  /** 去掉行索引后的规范化基名，例如 person[0].name → person.name */
  base: string;
  rowIndex: number;
  columnKey: string;
};

const ARRAY_PATTERNS: RegExp[] = [
  /^(.+?)\[(\d+)\]\.(.+)$/, // person[0].name
  /^(.+?)\[(\d+)\]\[(.+?)\]$/, // items[2][price]
  /^(.+?)_(\d+)_(.+)$/, // rows_0_name
  /^(.+?)\.(\d+)\.(.+)$/, // rows.0.name
];

export function parseArrayName(raw: string): ArrayNamePattern | null {
  const name = (raw || '').trim();
  if (!name) return null;
  for (const re of ARRAY_PATTERNS) {
    const m = name.match(re);
    if (m) {
      const idx = Number(m[2]);
      if (!Number.isFinite(idx)) continue;
      return { base: `${m[1]}.${m[3]}`, rowIndex: idx, columnKey: m[3] };
    }
  }
  return null;
}

/** 多信号稳定 id：frame + 规范化 selector + name 去索引 + rect 粗粒度桶 + label */
export function stableFieldId(
  el: Element,
  opts: {
    frameId: number;
    selector: string;
    used: Set<string>;
    label?: string;
  },
): string {
  const name = el.getAttribute('name') || '';
  const arrayPattern = parseArrayName(name);
  const namePart = arrayPattern ? arrayPattern.base : name;
  const idPart = looksLikeHash(el.id || '') ? '' : el.id || '';
  const r = rectOf(el);
  // rect 分桶到 20px 网格，容忍页面轻微重排/滚动带来的坐标漂移
  const bucket = `${Math.round(r.x / 20)}_${Math.round(r.y / 20)}`;
  const labelPart = norm(opts.label || '').slice(0, 24);

  const base =
    [namePart, idPart].filter(Boolean).join('|') ||
    `${el.tagName.toLowerCase()}_${bucket}_${labelPart}`;

  let candidate = `f${opts.frameId}_${base}`.slice(0, 200);
  if (!opts.used.has(candidate)) {
    opts.used.add(candidate);
    return candidate;
  }
  let n = 2;
  while (opts.used.has(`${candidate}__${n}`)) n += 1;
  const next = `${candidate}__${n}`;
  opts.used.add(next);
  return next;
}
