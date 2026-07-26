/**
 * Region 容器划分：只认 DOM 结构容器（table / fieldset / dialog / .datatable）。
 * 章节语义分节与命名留给后端在完整 texts 层处理。
 */

import { norm, rectOf } from '@/lib/formgraph/dom-utils';
import type { WorkingRegion } from '@/lib/formgraph/internal-types';
import { cssPath } from '@/lib/formgraph/dom-utils';
import { findEmptyDataTables, emptyTableDisplayName } from '@/lib/formgraph/repeat';

/**
 * 曾经这里有个"向上向前搜索最近 heading"的链（collectHeadingChain）。它已删除：
 * "最近的前置标题元素"本质是顺序猜测，政务页面把页面大标题、字数上限提示（`200`）、
 * 已上传附件名都写成了标题类元素，猜出来的链会一路进 chain → 进 query 前缀，
 * 一处猜错污染整块检索。章节归属改由后端用 texts 层的排版规格 + y 坐标判定，
 * 那里有全页文本可比，比前端局部搜索准。
 */

export type SectionBuildResult = {
  regions: WorkingRegion[];
  elementToRegion: Map<Element, WorkingRegion>;
};

const GEOMETRY_GAP_PX = 56;

/**
 * regionId 必须带 (frame, 面板) 作用域，与 controlNo 的 `f{frame}-p{面板}-` 前缀同源。
 * tab 表单里同一张 DOM 表会在每个面板各抽一次，若 id 不带作用域，三个面板产出同一个
 * regionId，下游按 id 分桶就会把不同面板的字段塌进一桶、区域名被后写入者覆盖。
 */
function makeRegionIdFactory(scope: string) {
  const used = new Set<string>();
  return (containerEl: Element, evidence: string): string => {
    const base = `region_${scope}_${evidence}_${cssPath(containerEl)}`.replace(/[^a-zA-Z0-9_]/g, '_');
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

/**
 * 区域名只取 HTML 明确声明"这个容器叫什么"的槽位：fieldset 的 legend、显式
 * data-section、组件库的对话框标题。取不到就留空——空名是"前端没有命名事实"
 * 这一事实本身，后端会用 texts 层的排版规格按 y 区间归属章节。
 *
 * 不用泛化的 `querySelector('h1..h6')`：容器内任意深度的第一个标题元素可能是
 * 页面大标题恰好嵌在这张表里，那不是这个区域的名字。
 */
function containerName(containerEl: Element): string {
  const legend = containerEl.querySelector(':scope > legend');
  const dialogTitle = containerEl.querySelector(
    ':scope > .ant-modal-title, :scope > .el-dialog__title, :scope > header > .ant-modal-title, :scope > .ant-modal-header > .ant-modal-title, :scope > .el-dialog__header > .el-dialog__title',
  );
  return (
    norm(legend?.textContent) ||
    norm(containerEl.getAttribute('data-section')) ||
    norm(dialogTitle?.textContent) ||
    ''
  );
}

function containerOf(el: Element): { containerEl: Element; evidence: WorkingRegion['evidence'][number] } | null {
  const datatable = el.closest('.datatable, [class*="datatable"]');
  if (datatable) return { containerEl: datatable, evidence: 'table' };
  const table = el.closest('table');
  if (table) return { containerEl: table, evidence: 'table' };
  const fieldset = el.closest('fieldset');
  if (fieldset) return { containerEl: fieldset, evidence: 'fieldset' };
  const dialog = el.closest('dialog,[role="dialog"]');
  if (dialog) return { containerEl: dialog, evidence: 'dialog' };
  return null;
}

export function buildRegions(
  controlEls: Element[],
  frameId: number,
  panelKey = '',
): SectionBuildResult {
  const regions: WorkingRegion[] = [];
  const elementToRegion = new Map<Element, WorkingRegion>();
  const regionByContainer = new Map<Element, WorkingRegion>();
  const nextRegionId = makeRegionIdFactory(`f${frameId}${panelKey ? `_p_${panelKey}` : ''}`);
  const remaining: Element[] = [];

  for (const el of controlEls) {
    const found = containerOf(el);
    if (!found) {
      remaining.push(el);
      continue;
    }
    let region = regionByContainer.get(found.containerEl);
    if (!region) {
      const name = containerName(found.containerEl);
      region = {
        regionId: nextRegionId(found.containerEl, found.evidence),
        kind: 'kv',
        name,
        chain: name ? [name] : [],
        frameId,
        fieldEls: [],
        containerEl: found.containerEl,
        split: false,
        confidence: 'high',
        evidence: [found.evidence],
      };
      regions.push(region);
      regionByContainer.set(found.containerEl, region);
    }
    region.fieldEls.push(el);
    elementToRegion.set(el, region);
  }

  // 空重复表：有列头无数据行，即使 0 控件也建 region，供 Agent 看见并激活增行
  for (const empty of findEmptyDataTables(document)) {
    if (regionByContainer.has(empty.containerEl)) {
      const existing = regionByContainer.get(empty.containerEl)!;
      existing.kind = 'repeat_group';
      existing.table = { rowRange: [0, -1], columns: empty.columns };
      existing.repeat = { templateFieldIds: [], rowCount: 0 };
      if (!existing.evidence.includes('repeat-pattern')) existing.evidence.push('repeat-pattern');
      if (!existing.name) {
        const named = emptyTableDisplayName(empty.columns);
        existing.name = named;
        if (!existing.chain.includes(named)) existing.chain = [...existing.chain, named];
      }
      continue;
    }
    const name = emptyTableDisplayName(empty.columns);
    const region: WorkingRegion = {
      regionId: nextRegionId(empty.containerEl, 'empty_table'),
      kind: 'repeat_group',
      name,
      chain: [name],
      frameId,
      fieldEls: [],
      containerEl: empty.containerEl,
      split: false,
      confidence: 'high',
      evidence: ['table', 'repeat-pattern'],
      table: { rowRange: [0, -1], columns: empty.columns },
      repeat: { templateFieldIds: [], rowCount: 0 },
    };
    regions.push(region);
    regionByContainer.set(empty.containerEl, region);
  }

  if (remaining.length) {
    const withRect = remaining
      .map((el) => ({ el, r: rectOf(el) }))
      .sort((a, b) => a.r.y - b.r.y || a.r.x - b.r.x);

    let current: WorkingRegion | null = null;
    let lastBottom = -Infinity;

    for (const { el, r } of withRect) {
      const gap = r.y - lastBottom;

      // 没有结构容器可依，只能按纵向空隙断段；命名与章节归属交给后端
      if (!current || gap > GEOMETRY_GAP_PX) {
        const containerEl = el.parentElement || el;
        current = {
          regionId: nextRegionId(containerEl, 'geometry-gap'),
          kind: 'kv',
          name: '',
          chain: [],
          frameId,
          fieldEls: [],
          containerEl,
          split: false,
          confidence: 'medium',
          evidence: ['geometry-gap'],
        };
        regions.push(current);
      }

      current.fieldEls.push(el);
      elementToRegion.set(el, current);
      lastBottom = Math.max(lastBottom, r.y + r.h);
    }
  }

  return { regions, elementToRegion };
}

export { cssPath };
