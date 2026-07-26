/** FormGraph 抽取的底层 DOM 工具：可见性判定、几何、Shadow DOM 穿透、文本节点收集。 */

import { cssEscape } from '@/lib/formgraph/css-escape';
import type { Rect, UnresolvedItem } from '@/lib/formgraph/types';

export function norm(t: string | null | undefined): string {
  return (t || '').replace(/\s+/g, ' ').trim();
}

export function looksLikeHash(t: string): boolean {
  return (
    /^[a-f0-9]{8,}([-_][a-f0-9]{4,})*$/i.test(t) ||
    (t.length > 48 && /^[a-z0-9_-]+$/i.test(t))
  );
}

/** 分页器/表尾结构事实（不做丢弃，随控件上传）。 */
const PAGER_SELECTOR =
  '.datapager,.dataTables_paginate,.dataTables_length,.pagination,[class*="page-size"],[class*="pagesize"],[class*="pager"]';

export function inPagerContainer(el: Element): boolean {
  return Boolean(el.closest(PAGER_SELECTOR));
}

export function inTableFooter(el: Element): boolean {
  return Boolean(el.closest('tfoot'));
}

/**
 * 可填控件选择器：`type=hidden` 不算。
 *
 * 政务/OA 表单会在标签格里塞一串 `<input type="hidden">` 存字典码，
 * 用 `input,select,textarea` 去判断「这一格是标签格还是数据格」会把标签格全判成数据格，
 * 于是整列题干退化成几何近邻猜测。
 */
export const DATA_CONTROL_SELECTOR =
  'input:not([type="hidden"]),select,textarea,[contenteditable="true"]';

/** 元素内部有没有真正可填的控件（忽略隐藏域） */
export function hasDataControl(el: Element): boolean {
  return Boolean(el.querySelector(DATA_CONTROL_SELECTOR));
}

export function rectOf(el: Element): Rect {
  const r = el.getBoundingClientRect();
  return {
    x: Math.round(r.x),
    y: Math.round(r.y),
    w: Math.round(r.width),
    h: Math.round(r.height),
  };
}

export function isHiddenType(el: Element): boolean {
  if (!(el instanceof HTMLInputElement)) return false;
  return ['hidden', 'submit', 'button', 'reset', 'image'].includes(el.type);
}

export function isVisible(el: Element): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.hidden || el.getAttribute('aria-hidden') === 'true') return false;
  const st = getComputedStyle(el);
  if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0) {
    return false;
  }
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

/** 元素是否在文档流中被祖先隐藏（display:none / hidden / [hidden] 链上任意一环） */
export function isAncestorHidden(el: Element): boolean {
  let cur: Element | null = el;
  while (cur) {
    if (cur instanceof HTMLElement) {
      if (cur.hidden) return true;
      const st = getComputedStyle(cur);
      if (st.display === 'none') return true;
    }
    cur = cur.parentElement;
    if (!cur) {
      // 穿越 shadow root 边界继续向上
      const root = (el.getRootNode() as ShadowRoot | Document);
      if ('host' in root && root.host) {
        cur = root.host as Element;
      }
    }
  }
  return false;
}

const NOISE_ANCESTOR =
  'nav,header,footer,[role="navigation"],[role="banner"],[role="contentinfo"],.navbar,.site-header,.site-footer';
const SEARCH_RE = /search|query|keyword|关键词|搜索/i;
const CAPTCHA_RE = /captcha|verify.?code|验证码|校验码/i;

export type NoiseReason =
  | 'hidden-type'
  | 'zero-size'
  | 'not-visible'
  | 'in-chrome'
  | 'search'
  | 'captcha'
  | 'select2-ghost'
  | 'disabled-template';

export function noiseReason(el: Element): NoiseReason | null {
  if (el instanceof HTMLInputElement && isHiddenType(el)) return 'hidden-type';
  if (!isVisible(el)) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return 'zero-size';
    return 'not-visible';
  }
  if (el.closest(NOISE_ANCESTOR)) return 'in-chrome';
  const name = el.getAttribute('name') || '';
  const id = el.id || '';
  const lab = norm(el.getAttribute('aria-label') || el.getAttribute('placeholder') || '');
  if (SEARCH_RE.test(name) || SEARCH_RE.test(id) || SEARCH_RE.test(lab)) return 'search';
  if (CAPTCHA_RE.test(name) || CAPTCHA_RE.test(id) || CAPTCHA_RE.test(lab)) return 'captcha';
  if (/^s2id_autogen/i.test(id) || el.classList.contains('select2-focusser')) {
    return 'select2-ghost';
  }
  const r = el.getBoundingClientRect();
  if (r.width <= 2 && r.height <= 2) return 'zero-size';
  return null;
}

export function cssPath(el: Element, root: ParentNode = document): string {
  if (el.id) return `#${cssEscape(el.id)}`;
  const parts: string[] = [];
  let cur: Element | null = el;
  while (cur && cur.nodeType === 1 && parts.length < 6) {
    let part = cur.tagName.toLowerCase();
    if (cur.id) {
      parts.unshift(`#${cssEscape(cur.id)}`);
      break;
    }
    const parent: Element | null = cur.parentElement;
    if (parent) {
      const siblings = [...parent.children].filter((c) => c.tagName === cur!.tagName);
      if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(cur) + 1})`;
    } else if (cur.parentNode && cur.parentNode !== root) {
      // 到达 shadow root 边界，停止往上（shadowPath 单独记录宿主链）
      parts.unshift(part);
      break;
    }
    parts.unshift(part);
    cur = parent;
  }
  return parts.join(' > ');
}

/** 穿透 open shadow root 的宿主链（供 locator.shadowPath 使用） */
export function shadowHostChain(el: Element): string[] {
  const chain: string[] = [];
  let root = el.getRootNode();
  while (root instanceof ShadowRoot) {
    chain.unshift(cssPath(root.host));
    root = root.host.getRootNode();
  }
  return chain;
}

/**
 * 递归收集文档内（含 open shadow root）所有匹配 selector 的元素。
 * closed shadow root 尝试用 chrome.dom.openOrClosedShadowRoot()（Chrome content script 可用，
 * 无需 debugger 权限）；不可用时该子树内容进 unresolved。
 */
export function deepQueryAll(
  selector: string,
  root: ParentNode = document,
  unresolved: UnresolvedItem[] = [],
  frameId = 0,
): Element[] {
  const out: Element[] = [...root.querySelectorAll(selector)];
  const hosts = root.querySelectorAll('*');
  for (const host of hosts) {
    const open = (host as Element).shadowRoot;
    if (open) {
      out.push(...deepQueryAll(selector, open, unresolved, frameId));
      continue;
    }
    // 尝试 closed shadow root（Chrome 88+，content script 上下文可用）
    const chromeDom = (globalThis as unknown as { chrome?: { dom?: { openOrClosedShadowRoot?: (el: Element) => ShadowRoot | null } } }).chrome?.dom;
    if (chromeDom?.openOrClosedShadowRoot) {
      try {
        const closed = chromeDom.openOrClosedShadowRoot(host as Element);
        if (closed) {
          out.push(...deepQueryAll(selector, closed, unresolved, frameId));
        }
      } catch {
        // 非 shadow host 或访问失败，忽略
      }
    }
  }
  return out;
}

export type TextNode = {
  t: string;
  r: DOMRect;
  el: Element;
  /**
   * 最内层承载这段文本的元素（后代里再没有别的带文本元素）。
   * 栅格布局里同一段文本会被外层容器重复计一遍，几何列头/标题行判定必须只看叶子，
   * 否则「阶段 起止时间 研究内容」的父行会被当成一个宽文本块，压掉三个真列头。
   */
  leaf: boolean;
};

/** 元素的直接/间接子元素里还有别的文本承载者吗 */
function hasTextBearingChild(node: Element): boolean {
  for (const child of node.children) {
    if (norm((child as HTMLElement).textContent)) return true;
  }
  return false;
}

export function collectTextNodes(root: ParentNode = document): TextNode[] {
  const out: TextNode[] = [];
  const nodes = deepQueryAll(
    'td,th,label,span,div,p,b,strong,legend,h1,h2,h3,h4,h5,h6,li,dt,dd',
    root,
  );
  for (const node of nodes) {
    if (node.querySelector('input,select,textarea')) continue;
    const t = norm((node as HTMLElement).innerText || node.textContent);
    if (!t) continue;
    const r = node.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    if (!isVisible(node)) continue;
    out.push({ t, r, el: node, leaf: !hasTextBearingChild(node) });
  }
  return out;
}

/** 可见文本的排版事实（字号/字重），供事实层上传。 */
export function readTextTypography(el: Element): { fontSize: number; fontWeight: number } {
  if (!(el instanceof HTMLElement)) return { fontSize: 0, fontWeight: 400 };
  const st = getComputedStyle(el);
  return {
    fontSize: Number.parseFloat(st.fontSize) || 0,
    fontWeight: Number.parseInt(st.fontWeight, 10) || (st.fontWeight === 'bold' ? 700 : 400),
  };
}

/**
 * 同源 iframe 链的累积页面偏移（best-effort，不需要 webNavigation 权限）。
 * 跨域链在任意一环访问 parent 会抛 SecurityError，此时返回 null。
 */
export function computePageOffset(): { dx: number; dy: number } | null {
  try {
    let dx = 0;
    let dy = 0;
    let win: Window = window;
    while (win !== win.top) {
      const frameEl = win.frameElement;
      if (!frameEl) return null; // 跨域，无法拿到 frameElement
      const r = frameEl.getBoundingClientRect();
      dx += r.x;
      dy += r.y;
      const parent = win.parent;
      if (!parent) return null;
      win = parent;
    }
    return { dx, dy };
  } catch {
    return null;
  }
}
