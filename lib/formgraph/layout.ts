/**
 * 确定性布局分析：重复单元、几何列头、布局容器单元格。
 * 章节语义分节不在前端做——完整 texts 上传后由后端处理。
 */

import { norm, rectOf, type TextNode } from '@/lib/formgraph/dom-utils';
import { clusterVisualRows } from '@/lib/formgraph/reading-order';
import type { Rect } from '@/lib/formgraph/types';

/** 结构签名最多参考多少个控件，防止超大容器把签名撑成天书 */
const SIGNATURE_CONTROL_LIMIT = 32;
/** 往上找重复单元的最大层数：栅格嵌套通常 3～6 层，给足余量即可 */
const MAX_UNIT_DEPTH = 12;
/** 一个重复单元至少要有这么多控件；只有一个控件的兄弟行与普通 KV 行无法区分 */
const MIN_CONTROLS_PER_UNIT = 2;
/** 列头至少要匹配上这么多个不同列，否则不算列结构 */
const MIN_MATCHED_COLUMNS = 2;
/** 列头行往上最多回看几行（中间可能夹着说明文字行） */
const MAX_HEADER_LOOKBACK_ROWS = 6;
/** 列头与控件的横向重叠下限（占较窄一方的比例） */
const MIN_COLUMN_OVERLAP_RATIO = 0.3;

type Box = { rect: Rect };

function boxOf(r: DOMRect): Rect {
  return { x: r.x, y: r.y, w: r.width, h: r.height };
}

function centerY(r: Rect): number {
  return r.y + r.h / 2;
}

/** 两个横向区间的重叠占较窄一方的比例 */
function overlapRatioX(a: Rect, b: Rect): number {
  const overlap = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  if (overlap <= 0) return 0;
  return overlap / Math.max(1, Math.min(a.w, b.w));
}

/* ------------------------------------------------------------------ *
 * 结构签名与祖先索引
 * ------------------------------------------------------------------ */

function controlSignature(el: Element): string {
  const tag = el.tagName.toLowerCase();
  if (el instanceof HTMLInputElement) return `${tag}:${el.type}`;
  const role = el.getAttribute('role');
  return role ? `${tag}:${role}` : tag;
}

/**
 * 祖先 → 其内部控件（保持文档顺序）。
 * 每个控件只向上走有限层，整体是 O(控件数 × 层数)，比逐层 contains() 便宜一个量级。
 */
function buildAncestorIndex(controls: Element[]): Map<Element, Element[]> {
  const index = new Map<Element, Element[]>();
  for (const el of controls) {
    let cur: Element | null = el.parentElement;
    for (let depth = 0; cur && depth < MAX_UNIT_DEPTH + 2; depth += 1) {
      const list = index.get(cur);
      if (list) list.push(el);
      else index.set(cur, [el]);
      cur = cur.parentElement;
    }
  }
  return index;
}

function signatureOf(container: Element, index: Map<Element, Element[]>): string {
  const list = index.get(container);
  if (!list || list.length < MIN_CONTROLS_PER_UNIT) return '';
  const head = list.slice(0, SIGNATURE_CONTROL_LIMIT).map(controlSignature).join('|');
  return list.length > SIGNATURE_CONTROL_LIMIT ? `${head}|+${list.length}` : head;
}

/* ------------------------------------------------------------------ *
 * 重复单元
 * ------------------------------------------------------------------ */

type RawGroup = { unitEls: Element[]; signature: string };

/**
 * 重复单元 = 同一父节点下、结构签名相同的兄弟元素。
 * `<tr>` 数据行、`<div class="row">` 栅格行、`<li>` 条目三种写法都落在这一条规则上。
 *
 * 从控件往上找**最内层**满足条件的祖先：再往外一层往往会把整个区块（含标题行、
 * 说明文字）当成"单元"，列头就对不上了。
 */
function detectRawGroups(controls: Element[], index: Map<Element, Element[]>): RawGroup[] {
  const groups: RawGroup[] = [];
  const seenUnit = new Set<Element>();

  for (const el of controls) {
    let cur: Element | null = el.parentElement;
    for (let depth = 0; cur && depth < MAX_UNIT_DEPTH; depth += 1) {
      const parent: Element | null = cur.parentElement;
      if (!parent) break;
      if (seenUnit.has(cur)) break;

      const signature = signatureOf(cur, index);
      if (signature) {
        const peers = [...parent.children].filter((c) => signatureOf(c, index) === signature);
        if (peers.length >= 2) {
          for (const p of peers) seenUnit.add(p);
          groups.push({ unitEls: peers, signature });
          break;
        }
      }
      cur = parent;
    }
  }

  return groups;
}

/* ------------------------------------------------------------------ *
 * 几何列头
 * ------------------------------------------------------------------ */

type HeaderCell = { rect: Rect; text: string; el: Element };

/**
 * 列头行：重复组第一个单元之上、最近一条「多列且没有控件」的视觉行。
 *
 * 只看叶子文本节点——栅格里外层容器会把整行文本合并成一个宽块，
 * 拿它当列头会把所有列压成一列。
 */
function findHeaderRow(
  firstUnitRect: Rect,
  unitControls: Element[],
  textNodes: TextNode[],
  controls: Element[],
): HeaderCell[] | null {
  const above: (Box & { text: string; el: Element })[] = [];
  for (const node of textNodes) {
    if (!node.leaf) continue;
    const rect = boxOf(node.r);
    if (rect.y + rect.h > firstUnitRect.y + 4) continue;
    if (overlapRatioX(rect, firstUnitRect) <= 0) continue;
    above.push({ rect, text: node.t, el: node.el });
  }
  if (above.length < MIN_MATCHED_COLUMNS) return null;

  const controlBoxes = controls.map((c) => boxOf(c.getBoundingClientRect()));
  const rows = clusterVisualRows(above);

  // 由近及远回看，取第一条「列数够、且没有控件混在同一行」的行
  const lookback = rows.slice(-MAX_HEADER_LOOKBACK_ROWS).reverse();
  for (const row of lookback) {
    if (row.items.length < MIN_MATCHED_COLUMNS) continue;
    const polluted = controlBoxes.some((b) => {
      const cy = centerY(b);
      return cy >= row.y0 && cy <= row.y1;
    });
    if (polluted) continue;

    const cells = row.items.map((item) => ({ rect: item.rect, text: item.text, el: item.el }));
    const matched = new Set<number>();
    for (const control of unitControls) {
      const cRect = boxOf(control.getBoundingClientRect());
      let bestIdx = -1;
      let bestRatio = 0;
      cells.forEach((cell, i) => {
        const ratio = overlapRatioX(cell.rect, cRect);
        if (ratio > bestRatio) {
          bestRatio = ratio;
          bestIdx = i;
        }
      });
      if (bestIdx >= 0 && bestRatio >= MIN_COLUMN_OVERLAP_RATIO) matched.add(bestIdx);
    }
    if (matched.size >= MIN_MATCHED_COLUMNS) return cells;
  }

  return null;
}

/* ------------------------------------------------------------------ *
 * 对外结果
 * ------------------------------------------------------------------ */

export type GridSlot = {
  /** 所属重复组（跨快照稳定：由列头文本 + 单元数派生） */
  groupKey: string;
  /** 该控件所在重复单元的序号，0-based */
  rowIndex: number;
  rowCount: number;
  columnKey: string;
  columnLabel: string;
  /** 同一单元同一列里的第几个控件（起止时间那种「一格两空」） */
  slotIndex: number;
  slotCount: number;
};

export type GridRepeatGroup = {
  groupKey: string;
  unitEls: Element[];
  fieldEls: Element[];
  columns: { key: string; label: string }[];
  rowCount: number;
};

export type LayoutAnalysis = {
  /** 控件 → 重复行/列位置；只有列头解析成功的组才会出现在这里 */
  slotOf: Map<Element, GridSlot>;
  /** 已确认的重复组，按 groupKey 索引 */
  groups: Map<string, GridRepeatGroup>;
  /**
   * 单元格 → 格内控件跨了几个视觉行。
   * >1 说明这个 td 是布局容器而不是数据格：它的左邻格/表头都不是这些控件的题干，
   * 格内多控件也不该被编成「一格多空」的槽位。
   */
  rowsInCell: Map<Element, number>;
};

export function analyzeLayout(controls: Element[], textNodes: TextNode[]): LayoutAnalysis {
  const slotOf = new Map<Element, GridSlot>();
  const groups = new Map<string, GridRepeatGroup>();
  const index = buildAncestorIndex(controls);

  for (const raw of detectRawGroups(controls, index)) {
    const unitControls = raw.unitEls.map((u) => index.get(u) ?? []);
    const firstUnitRect = boxOf(raw.unitEls[0].getBoundingClientRect());
    const header = findHeaderRow(firstUnitRect, unitControls[0], textNodes, controls);
    if (!header) continue;

    const columns = header.map((cell, i) => ({ key: `col_${i}`, label: cell.text }));
    // groupKey 取列头文本 + 单元数，跨快照稳定，且能在产物里自解释
    const groupKey = `grid_${columns.map((c) => c.label).join('|')}_${raw.unitEls.length}`
      .replace(/\s+/g, '')
      .slice(0, 150);

    const fieldEls: Element[] = [];
    raw.unitEls.forEach((_unit, rowIndex) => {
      // 先按列归拢，才能给同列多控件编出槽位序号
      const byColumn = new Map<number, Element[]>();
      for (const control of unitControls[rowIndex]) {
        const cRect = boxOf(control.getBoundingClientRect());
        let bestIdx = -1;
        let bestRatio = 0;
        header.forEach((cell, i) => {
          const ratio = overlapRatioX(cell.rect, cRect);
          if (ratio > bestRatio) {
            bestRatio = ratio;
            bestIdx = i;
          }
        });
        if (bestIdx < 0 || bestRatio < MIN_COLUMN_OVERLAP_RATIO) continue;
        const list = byColumn.get(bestIdx);
        if (list) list.push(control);
        else byColumn.set(bestIdx, [control]);
      }

      for (const [columnIndex, members] of byColumn) {
        members.sort((a, b) => {
          const ra = a.getBoundingClientRect();
          const rb = b.getBoundingClientRect();
          return ra.y - rb.y || ra.x - rb.x;
        });
        members.forEach((control, slotIndex) => {
          slotOf.set(control, {
            groupKey,
            rowIndex,
            rowCount: raw.unitEls.length,
            columnKey: columns[columnIndex].key,
            columnLabel: columns[columnIndex].label,
            slotIndex,
            slotCount: members.length,
          });
          fieldEls.push(control);
        });
      }
    });

    if (!fieldEls.length) continue;
    groups.set(groupKey, {
      groupKey,
      unitEls: raw.unitEls,
      fieldEls,
      columns,
      rowCount: raw.unitEls.length,
    });
  }

  return { slotOf, groups, rowsInCell: buildRowsInCell(controls) };
}

function buildRowsInCell(controls: Element[]): Map<Element, number> {
  const byCell = new Map<Element, Element[]>();
  for (const el of controls) {
    const td = el.closest('td,th');
    if (!td) continue;
    const list = byCell.get(td);
    if (list) list.push(el);
    else byCell.set(td, [el]);
  }
  const out = new Map<Element, number>();
  for (const [cell, members] of byCell) {
    out.set(cell, clusterVisualRows(members.map((el) => ({ rect: rectOf(el) }))).length);
  }
  return out;
}

