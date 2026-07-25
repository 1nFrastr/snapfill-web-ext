const NOISE_ANCESTOR_SELECTORS = [
  'nav',
  'header',
  'footer',
  '[role="navigation"]',
  '[role="banner"]',
  '[role="contentinfo"]',
  '.navbar',
  '.nav-bar',
  '.site-header',
  '.site-footer',
  '.sidebar-search',
  '.chat-widget',
  '.float-service',
  '#global-search',
];

const SEARCH_NAME_RE = /search|query|q\b|keyword|关键词|搜索/i;
const CAPTCHA_RE = /captcha|verify.?code|验证码|校验码/i;

export type NoiseReason =
  | 'hidden-type'
  | 'not-visible'
  | 'in-chrome'
  | 'search'
  | 'captcha'
  | 'disabled-template'
  | 'duplicate-hidden-form';

export function isHiddenInputType(el: HTMLInputElement): boolean {
  return el.type === 'hidden' || el.type === 'submit' || el.type === 'button' || el.type === 'reset' || el.type === 'image';
}

export function isElementVisible(el: Element): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.hidden || el.getAttribute('aria-hidden') === 'true') return false;
  if (el.classList.contains('template-row')) return false;
  if (el.getAttribute('data-template') === 'true') return false;

  const inline = el.style;
  if (inline.display === 'none' || inline.visibility === 'hidden' || inline.opacity === '0') {
    return false;
  }

  // CLI / jsdom：没有真实布局时走启发式，避免 getBoundingClientRect 全 0 误杀
  const hasRealLayout =
    typeof window !== 'undefined' &&
    typeof window.getComputedStyle === 'function' &&
    !((globalThis as { __SNAPFILL_CLI__?: boolean }).__SNAPFILL_CLI__);

  if (!hasRealLayout) {
    let cur: HTMLElement | null = el;
    while (cur) {
      if (cur.hidden || cur.getAttribute('aria-hidden') === 'true') return false;
      if (cur.classList.contains('template-row')) return false;
      if (cur.getAttribute('data-template') === 'true') return false;
      if (
        cur.style.display === 'none' ||
        cur.style.visibility === 'hidden' ||
        cur.getAttribute('style')?.includes('display:none') ||
        cur.getAttribute('style')?.includes('display: none')
      ) {
        return false;
      }
      cur = cur.parentElement;
    }
    return true;
  }

  const style = window.getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
    return false;
  }
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return false;
  return true;
}

export function isInNoiseAncestor(el: Element): boolean {
  return NOISE_ANCESTOR_SELECTORS.some((sel) => el.closest(sel));
}

export function looksLikeSearch(el: Element, label: string): boolean {
  if (el instanceof HTMLInputElement && el.type === 'search') return true;
  const blob = [
    label,
    el.getAttribute('name') ?? '',
    el.getAttribute('id') ?? '',
    el.getAttribute('placeholder') ?? '',
    el.getAttribute('aria-label') ?? '',
  ].join(' ');
  return SEARCH_NAME_RE.test(blob);
}

export function looksLikeCaptcha(el: Element, label: string): boolean {
  const blob = [
    label,
    el.getAttribute('name') ?? '',
    el.getAttribute('id') ?? '',
    el.getAttribute('placeholder') ?? '',
  ].join(' ');
  return CAPTCHA_RE.test(blob);
}

/** 隐藏模板行 / display:none 容器内的控件 */
export function isInDisabledTemplate(el: Element): boolean {
  const row = el.closest('tr, .form-row, .ant-form-item, [data-template]');
  if (!row) return false;
  if (row.getAttribute('data-template') === 'true') return true;
  if (row.classList.contains('template-row')) return true;
  if (!isElementVisible(row)) return true;
  return false;
}

/** footer 等区域内重复的订阅/登录小表单 */
export function isDuplicateChromeForm(el: Element): boolean {
  const form = el.closest('form');
  if (!form) return false;
  if (form.dataset.noise === 'true' || form.classList.contains('noise-form')) return true;
  if (form.closest('footer, .site-footer, .newsletter, .login-widget')) return true;
  return false;
}

export function classifyNoise(
  el: Element,
  label: string,
): NoiseReason | null {
  if (el instanceof HTMLInputElement && isHiddenInputType(el)) return 'hidden-type';
  if (!isElementVisible(el)) return 'not-visible';
  if (isInNoiseAncestor(el)) return 'in-chrome';
  if (isDuplicateChromeForm(el)) return 'duplicate-hidden-form';
  if (isInDisabledTemplate(el)) return 'disabled-template';
  if (looksLikeSearch(el, label)) return 'search';
  if (looksLikeCaptcha(el, label)) return 'captcha';
  return null;
}
