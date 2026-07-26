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

/** 行索引的合理上界：表单里的重复行是人手一行一行加出来的，不会是时间戳或字典码 */
const MAX_PLAUSIBLE_ROW_INDEX = 200;

export type ArrayRepeatEvidence = {
  /** 去重后的行索引，升序 */
  rowIndices: number[];
  /** 至少在两行里出现过的列名（真正构成重复列结构的那些） */
  sharedColumnKeys: string[];
};

/**
 * `parseArrayName` 只是纯正则，任何 `前缀_数字_后缀` 都会命中——政务系统里
 * `field_1006_1421303632714` 这种「字典码 + 时间戳」的生成名会被解析成
 * 「第 1006 行的 1421303632714 列」，于是整张布局大表被误判成重复块。
 *
 * 真重复块的判据不在单个名字上，而在名字的集合关系上：
 * 1. 同一个规范化基名（去掉行索引后）必须在 **两个以上不同行索引** 上出现
 *    —— 这才是"同一列在多行里重复"的证据；
 * 2. 行索引必须是小整数且近连续（允许删行留下的空洞，不允许 1002/1006 这种跳跃量级）。
 *
 * 任一条不满足就返回 null，交由 thead / 模板行 / 添加按钮等其它证据判定。
 */
export function detectArrayRepeat(names: readonly string[]): ArrayRepeatEvidence | null {
  const rowsByBase = new Map<string, Set<number>>();
  const rowsByColumn = new Map<string, Set<number>>();

  for (const raw of names) {
    const parsed = parseArrayName(raw);
    if (!parsed) continue;
    if (!Number.isInteger(parsed.rowIndex) || parsed.rowIndex < 0) continue;
    if (parsed.rowIndex > MAX_PLAUSIBLE_ROW_INDEX) continue;
    if (!rowsByBase.has(parsed.base)) rowsByBase.set(parsed.base, new Set());
    rowsByBase.get(parsed.base)!.add(parsed.rowIndex);
    if (!rowsByColumn.has(parsed.columnKey)) rowsByColumn.set(parsed.columnKey, new Set());
    rowsByColumn.get(parsed.columnKey)!.add(parsed.rowIndex);
  }

  const repeatedBases = [...rowsByBase.entries()].filter(([, rows]) => rows.size >= 2);
  if (!repeatedBases.length) return null;

  const rowIndices = [...new Set(repeatedBases.flatMap(([, rows]) => [...rows]))].sort((a, b) => a - b);
  // 近连续：容忍删行留下的空洞，拒绝量级跳跃
  const span = rowIndices[rowIndices.length - 1] - rowIndices[0] + 1;
  if (span > rowIndices.length * 2) return null;

  return {
    rowIndices,
    sharedColumnKeys: [...rowsByColumn.entries()]
      .filter(([, rows]) => rows.size >= 2)
      .map(([key]) => key),
  };
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
