/** 控件真实类型识别：原生 / ARIA 伪控件 / 组件库 / contenteditable / canvas。 */

import type { ComponentKind, ControlInfo } from '@/lib/formgraph/types';
import { isHiddenType, norm } from '@/lib/formgraph/dom-utils';

const RICHTEXT_CLASS_RE = /ql-editor|tox-edit-area|ProseMirror|cke_editable|w-e-text/i;
const DATEPICKER_CLASS_RE = /date-?picker|calendar|el-date-editor|ant-picker/i;
const SIGNATURE_LABEL_RE = /签名|签字|signature/i;

export function controlTag(el: Element): string {
  return el.tagName.toLowerCase();
}

function detectComponentKind(el: Element): ComponentKind | undefined {
  const cls = (el.className && typeof el.className === 'string' ? el.className : '') || '';
  const container = el.closest('[class]');
  const containerCls = (container?.className && typeof container.className === 'string' ? container.className : '') || '';
  const all = `${cls} ${containerCls}`;

  if (/select__control|select__value-container/i.test(all)) return 'react-select';
  if (/ant-select/i.test(all)) return 'antd-select';
  if (/el-select/i.test(all)) return 'element-select';
  if (DATEPICKER_CLASS_RE.test(all)) return 'datepicker';
  if (RICHTEXT_CLASS_RE.test(all)) return 'richtext';
  if (el instanceof HTMLInputElement && el.type === 'file') return 'upload';
  return undefined;
}

/**
 * 组件库 Select 常见模式：可见的是 div/button（承载 role=combobox 或纯样式），
 * 真值落在一个视觉隐藏的原生 input/select（name 才是提交字段）。
 * 在控件的最近块级祖先内查找这个 backing input，避免误配到毫不相关的控件。
 */
export function findHiddenBackingInput(visibleEl: Element): HTMLInputElement | HTMLSelectElement | null {
  const scope = visibleEl.closest('div,section,li') || visibleEl.parentElement;
  if (!scope) return null;
  const candidates = scope.querySelectorAll('input,select');
  for (const c of candidates) {
    if (c === visibleEl) continue;
    if (c instanceof HTMLInputElement && (isHiddenType(c) || c.type === 'text')) {
      const st = getComputedStyle(c);
      const invisible =
        c.type === 'hidden' ||
        st.display === 'none' ||
        st.opacity === '0' ||
        (c.offsetWidth <= 1 && c.offsetHeight <= 1);
      if (invisible && c.name) return c;
    }
    if (c instanceof HTMLSelectElement) {
      const st = getComputedStyle(c);
      if (st.display === 'none' || st.opacity === '0') return c;
    }
  }
  return null;
}

export function detectControl(el: Element): ControlInfo {
  const tag = controlTag(el);

  if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) {
    const componentKind = detectComponentKind(el);
    return {
      tag,
      type: el instanceof HTMLSelectElement ? 'select' : el instanceof HTMLTextAreaElement ? 'textarea' : el.type || 'text',
      widget: componentKind ? 'component' : 'native',
      component: componentKind,
    };
  }

  if (el.getAttribute('contenteditable') === 'true') {
    const componentKind = detectComponentKind(el);
    return {
      tag,
      type: 'contenteditable',
      widget: 'contenteditable',
      component: componentKind ?? (RICHTEXT_CLASS_RE.test(el.className || '') ? 'richtext' : undefined),
    };
  }

  if (tag === 'canvas') {
    const nearbyLabel = norm(el.getAttribute('aria-label') || el.closest('[data-field]')?.textContent || '');
    return {
      tag,
      type: 'canvas',
      widget: 'canvas',
      component: SIGNATURE_LABEL_RE.test(nearbyLabel) ? 'signature' : undefined,
    };
  }

  const role = el.getAttribute('role') || '';
  const componentKind = detectComponentKind(el);
  return {
    tag,
    type: role || tag,
    widget: componentKind ? 'component' : 'aria',
    component: componentKind,
  };
}

export function isFileInput(el: Element): boolean {
  return el instanceof HTMLInputElement && el.type === 'file';
}

export function isSignatureCanvas(control: ControlInfo): boolean {
  return control.widget === 'canvas' && control.component === 'signature';
}
