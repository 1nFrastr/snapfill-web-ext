/**
 * 阅读顺序编号。
 *
 * DOM 顺序在 Grid/Flex/绝对定位布局下与人眼阅读顺序不一致，而 control_no 是"编号当桥梁"的
 * 核对手段——截图上画的编号跳来跳去，人工核对就失效了。算法沿用 PDF 实验
 * `som_pipeline.reading_order_sort` 的几何行聚类（先按 y 重叠分行，行内左到右），
 * 它只依赖 rect，与信息源无关，是 PDF 与 Web 共享的抽象。
 */

import type { Rect } from '@/lib/formgraph/types';

/** 同一行的判定：两个 rect 的纵向重叠超过较矮者的 40% */
const ROW_OVERLAP_RATIO = 0.4;

type Row<T> = { y0: number; y1: number; items: T[] };

export function sortByReadingOrder<T extends { rect: Rect }>(items: T[]): T[] {
  const sorted = [...items].sort((a, b) => a.rect.y - b.rect.y);
  const rows: Row<T>[] = [];

  for (const item of sorted) {
    const y0 = item.rect.y;
    const y1 = item.rect.y + item.rect.h;
    const row = rows.find((r) => {
      const overlap = Math.min(y1, r.y1) - Math.max(y0, r.y0);
      const minHeight = Math.min(y1 - y0, r.y1 - r.y0);
      return minHeight > 0 && overlap > ROW_OVERLAP_RATIO * minHeight;
    });
    if (row) {
      row.items.push(item);
      row.y0 = Math.min(row.y0, y0);
      row.y1 = Math.max(row.y1, y1);
    } else {
      rows.push({ y0, y1, items: [item] });
    }
  }

  rows.sort((a, b) => a.y0 - b.y0);
  return rows.flatMap((row) => row.items.sort((a, b) => a.rect.x - b.rect.x));
}
