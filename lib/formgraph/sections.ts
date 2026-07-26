/**
 * Region 容器划分：fieldset/legend → table → heading 层级 → 几何间距兜底。
 * 结构优先：只在没有任何语义容器时才退化到几何聚类。
 *
 * 本模块只产出「容器级」WorkingRegion（kind 先给占位值，table 的精确分类
 * 需要等字段解析完成后由 repeat.ts 的 classifyTable 二次修正，见 extract.ts）。
 */

import { norm, rectOf } from '@/lib/formgraph/dom-utils';
import type { WorkingRegion } from '@/lib/formgraph/internal-types';
import { cssPath } from '@/lib/formgraph/dom-utils';

// 真正意义上的"标题文本"元素：只匹配真实标题节点，不匹配整段容器
// （[data-section] 容器可能内含表格/大段文本，绝不能当作标题整体取 textContent）
const HEADING_SELECTOR = 'h1,h2,h3,h4,h5,h6,legend,.section-title,.card-title,.ant-card-head-title';

type HeadingCandidate = { el: Element; text: string };

function isHeadingLike(el: Element): boolean {
  return el.matches(HEADING_SELECTOR);
}

/**
 * 只认"直接就是标题元素"的前置兄弟，不深入兄弟容器内部找标题——
 * 否则一串平级 fieldset（申报头信息/货物明细/税费信息…）会被误判成互相嵌套，
 * 把前一个平级 section 的标题也塞进后一个 section 的 chain 里。
 */
function nearestPrecedingHeading(el: Element): HeadingCandidate | null {
  let cur: Element | null = el;
  while (cur) {
    let sib: Element | null = cur.previousElementSibling;
    while (sib) {
      if (isHeadingLike(sib)) return { el: sib, text: norm(sib.textContent) };
      sib = sib.previousElementSibling;
    }
    cur = cur.parentElement;
  }
  return null;
}

function collectHeadingChain(container: Element, maxLevels = 3): string[] {
  const chain: string[] = [];
  const seen = new Set<string>();
  let cur: Element | null = container;
  let guard = 0;
  while (cur && chain.length < maxLevels && guard < 20) {
    guard += 1;
    const heading = nearestPrecedingHeading(cur);
    if (!heading) break;
    const text = heading.text.length > 60 ? heading.text.slice(0, 60) : heading.text;
    if (text && !seen.has(text)) {
      chain.unshift(text);
      seen.add(text);
    }
    cur = heading.el.parentElement;
  }
  return chain;
}

export type SectionBuildResult = {
  regions: WorkingRegion[];
  elementToRegion: Map<Element, WorkingRegion>;
};

const GEOMETRY_GAP_PX = 56;

/**
 * regionId 必须跨快照稳定（同一容器再抽一次要拿到同一个 id），否则 diff/gatedBy
 * 打标会把"没变化的旧区域"也误判成"新增"。用容器的 cssPath 派生，而非自增计数器。
 */
function makeRegionIdFactory() {
  const used = new Set<string>();
  return (containerEl: Element, evidence: string): string => {
    const base = `region_${evidence}_${cssPath(containerEl)}`.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 150);
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

export function buildRegions(controlEls: Element[], frameId: number): SectionBuildResult {
  const regions: WorkingRegion[] = [];
  const elementToRegion = new Map<Element, WorkingRegion>();
  const regionByContainer = new Map<Element, WorkingRegion>();
  const nextRegionId = makeRegionIdFactory();

  const remaining: Element[] = [];

  for (const el of controlEls) {
    const table = el.closest('table');
    const fieldset = el.closest('fieldset');

    let containerEl: Element | null = null;
    let evidence: WorkingRegion['evidence'][number] = 'geometry-gap';

    if (table) {
      containerEl = table;
      evidence = 'table';
    } else if (fieldset) {
      containerEl = fieldset;
      evidence = 'fieldset';
    } else {
      const dialog = el.closest('dialog,[role="dialog"]');
      if (dialog) {
        containerEl = dialog;
        evidence = 'dialog';
      }
    }

    if (containerEl) {
      let region = regionByContainer.get(containerEl);
      if (!region) {
        const chain = collectHeadingChain(containerEl);
        const legend = containerEl.querySelector(':scope > legend');
        // dialog/section 这类容器的标题通常是内部第一个 heading（弹窗子表单尤其常见）
        const innerHeading = containerEl.querySelector('h1,h2,h3,h4,h5,h6,.section-title,.ant-modal-title,.el-dialog__title');
        const name =
          norm(legend?.textContent) ||
          norm(containerEl.getAttribute('data-section')) ||
          norm(innerHeading?.textContent) ||
          chain[chain.length - 1] ||
          (evidence === 'table' ? '表格区域' : '未命名区域');
        region = {
          regionId: nextRegionId(containerEl, evidence),
          kind: 'kv',
          name,
          chain: chain.length ? chain : [name],
          frameId,
          fieldEls: [],
          containerEl,
          confidence: 'high',
          evidence: [evidence],
        };
        regions.push(region);
        regionByContainer.set(containerEl, region);
      }
      region.fieldEls.push(el);
      elementToRegion.set(el, region);
    } else {
      remaining.push(el);
    }
  }

  // 几何兜底：无语义容器时按阅读顺序 + 纵向间距切分
  if (remaining.length) {
    const withRect = remaining
      .map((el) => ({ el, r: rectOf(el) }))
      .sort((a, b) => a.r.y - b.r.y || a.r.x - b.r.x);

    let current: WorkingRegion | null = null;
    let lastBottom = -Infinity;
    let lastHeadingText = '';

    for (const { el, r } of withRect) {
      const heading = nearestPrecedingHeading(el);
      const headingText = heading ? heading.text : '';
      const gap = r.y - lastBottom;
      const headingChanged = headingText && headingText !== lastHeadingText;

      if (!current || gap > GEOMETRY_GAP_PX || headingChanged) {
        const chain = collectHeadingChain(el);
        const name = chain[chain.length - 1] || `区域 ${regions.length + 1}`;
        const containerEl = el.parentElement || el;
        const evidence = headingChanged ? 'heading' : 'geometry-gap';
        current = {
          regionId: nextRegionId(containerEl, evidence),
          kind: 'kv',
          name,
          chain: chain.length ? chain : [name],
          frameId,
          fieldEls: [],
          containerEl,
          confidence: headingChanged ? 'high' : 'medium',
          evidence: [evidence],
        };
        regions.push(current);
        lastHeadingText = headingText || lastHeadingText;
      }

      current.fieldEls.push(el);
      elementToRegion.set(el, current);
      lastBottom = Math.max(lastBottom, r.y + r.h);
    }
  }

  return { regions, elementToRegion };
}

export { cssPath };
