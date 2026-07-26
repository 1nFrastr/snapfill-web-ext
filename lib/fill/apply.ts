import { cssEscape } from '@/lib/formgraph/css-escape';
import type { FieldLocator } from '@/lib/fill/map-fields';
import type { FormFieldValue } from '@/lib/api/types';

export type ApplyResult = {
  filled: string[];
  skipped: Array<{ id: string; reason: string }>;
  lowConfidence: string[];
};

/** 部分框架（Vue/Element、表单校验库）依赖 blur/focusout 才触发校验或提交同步 */
function dispatchBlurEvents(el: HTMLElement) {
  const Evt = el.ownerDocument.defaultView?.FocusEvent ?? FocusEvent;
  try {
    el.dispatchEvent(new Evt('blur', { bubbles: false }));
    el.dispatchEvent(new Evt('focusout', { bubbles: true }));
  } catch {
    // 部分环境 FocusEvent 构造受限，忽略
  }
}

function dispatchInputEvents(el: HTMLElement) {
  const Evt = el.ownerDocument.defaultView?.Event ?? Event;
  el.dispatchEvent(new Evt('input', { bubbles: true }));
  el.dispatchEvent(new Evt('change', { bubbles: true }));
  dispatchBlurEvents(el);
}

function setNativeValue(
  el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  value: string,
) {
  const proto =
    el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : el instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
  const desc = Object.getOwnPropertyDescriptor(proto, 'value');
  if (desc?.set) desc.set.call(el, value);
  else el.value = value;
  dispatchInputEvents(el);
}

function matchOptionValue(
  options: Array<{ label: string; value: string }> | undefined,
  desired: string,
): string | undefined {
  if (!options?.length) return desired;
  const exact = options.find(
    (o) => o.value === desired || o.label === desired,
  );
  if (exact) return exact.value;
  const lower = desired.toLowerCase();
  const fuzzy = options.find(
    (o) =>
      o.value.toLowerCase() === lower ||
      o.label.toLowerCase() === lower ||
      o.label.includes(desired) ||
      desired.includes(o.label),
  );
  return fuzzy?.value;
}

function applyOne(
  locator: FieldLocator,
  raw: FormFieldValue,
): { ok: true } | { ok: false; reason: string } {
  const value = raw.value?.trim() ?? '';
  if (!value) return { ok: false, reason: '空值' };

  const el = document.querySelector(locator.selector);
  if (!el) return { ok: false, reason: `找不到控件 ${locator.selector}` };

  // 组件库场景：真值落在隐藏 backing input/select 上，优先写它（可见 div/button 只是展示层）
  if (locator.widget === 'component' && locator.backingSelector) {
    const backing = document.querySelector(locator.backingSelector);
    if (backing instanceof HTMLSelectElement) {
      const matched = matchOptionValue(
        [...backing.options].map((o) => ({ label: o.textContent?.trim() || o.value, value: o.value })),
        value,
      );
      if (matched != null) {
        setNativeValue(backing, matched);
        return { ok: true };
      }
    } else if (backing instanceof HTMLInputElement) {
      setNativeValue(backing, value);
      return { ok: true };
    }
  }

  if (locator.type === 'select' && el instanceof HTMLSelectElement) {
    const matched = matchOptionValue(
      [...el.options].map((o) => ({
        label: o.textContent?.trim() || o.value,
        value: o.value,
      })),
      value,
    );
    if (matched == null) return { ok: false, reason: '无匹配 option' };
    setNativeValue(el, matched);
    return { ok: true };
  }

  if (locator.type === 'radio') {
    const name = locator.name || (el as HTMLInputElement).name;
    if (!name) return { ok: false, reason: 'radio 缺少 name' };
    const radios = document.querySelectorAll<HTMLInputElement>(
      `input[type="radio"][name="${cssEscape(name)}"]`,
    );
    const matched = matchOptionValue(
      [...radios].map((r) => ({
        label: r.value,
        value: r.value,
      })),
      value,
    );
    const target =
      [...radios].find((r) => r.value === matched) ||
      [...radios].find((r) => r.value === value);
    if (!target) return { ok: false, reason: '无匹配 radio' };
    target.checked = true;
    dispatchInputEvents(target);
    return { ok: true };
  }

  if (locator.type === 'checkbox') {
    if (el instanceof HTMLInputElement && el.type === 'checkbox' && !el.name) {
      const on = /^(1|true|yes|是|选中|checked)$/i.test(value);
      el.checked = on;
      dispatchInputEvents(el);
      return { ok: true };
    }
    const name = locator.name || (el as HTMLInputElement).name;
    const parts = value.split(',').map((s) => s.trim()).filter(Boolean);
    if (name) {
      const boxes = document.querySelectorAll<HTMLInputElement>(
        `input[type="checkbox"][name="${cssEscape(name)}"]`,
      );
      if (boxes.length > 1 || parts.length > 0) {
        for (const box of boxes) {
          const labels = [box.value, box.getAttribute('aria-label') || ''];
          const hit = parts.some((p) =>
            labels.some((l) => l === p || l.includes(p) || p.includes(l)),
          );
          box.checked = hit;
          dispatchInputEvents(box);
        }
        return { ok: true };
      }
    }
    if (el instanceof HTMLInputElement && el.type === 'checkbox') {
      el.checked = true;
      dispatchInputEvents(el);
      return { ok: true };
    }
    return { ok: false, reason: 'checkbox 无法写入' };
  }

  if (
    el instanceof HTMLInputElement ||
    el instanceof HTMLTextAreaElement ||
    el instanceof HTMLSelectElement
  ) {
    setNativeValue(el, value);
    return { ok: true };
  }

  if (el.getAttribute('contenteditable') === 'true') {
    el.textContent = value;
    dispatchInputEvents(el as HTMLElement);
    return { ok: true };
  }

  return { ok: false, reason: '不支持的控件类型' };
}

export type VerifyStatus = 'verified' | 'reverted' | 'mismatch' | 'not-found';

function readCurrentValue(locator: FieldLocator): string {
  const target = locator.backingSelector
    ? document.querySelector(locator.backingSelector) || document.querySelector(locator.selector)
    : document.querySelector(locator.selector);
  if (!target) return '';
  if (target instanceof HTMLSelectElement) return target.value;
  if (target instanceof HTMLTextAreaElement) return target.value;
  if (target instanceof HTMLInputElement) {
    if (target.type === 'checkbox') return target.checked ? 'true' : '';
    if (target.type === 'radio') {
      const name = locator.name || target.name;
      const checked = document.querySelector<HTMLInputElement>(
        `input[type="radio"][name="${cssEscape(name || '')}"]:checked`,
      );
      return checked?.value || '';
    }
    return target.value;
  }
  return (target.textContent || '').trim();
}

/**
 * 写入后回读校验：部分受控组件（React/Vue）会在下一个事件循环把值回滚，
 * 或组件库根本没有响应 setNativeValue。用于向 Agent 暴露真实成功率，而非"写了就算成功"。
 */
export function verifyApplied(
  locators: FieldLocator[],
  expected: Record<string, string>,
): Record<string, VerifyStatus> {
  const byId = new Map(locators.map((l) => [l.id, l]));
  const out: Record<string, VerifyStatus> = {};
  for (const [id, expectedValue] of Object.entries(expected)) {
    const locator = byId.get(id);
    if (!locator) {
      out[id] = 'not-found';
      continue;
    }
    const current = readCurrentValue(locator);
    if (!current) {
      out[id] = 'reverted';
    } else if (current === expectedValue || current.includes(expectedValue) || expectedValue.includes(current)) {
      out[id] = 'verified';
    } else {
      out[id] = 'mismatch';
    }
  }
  return out;
}

/** 按定位表把后端 values 写回当前文档 */
export function applyFieldValuesToDom(
  locators: FieldLocator[],
  values: Record<string, FormFieldValue>,
): ApplyResult {
  const byId = new Map(locators.map((l) => [l.id, l]));
  const filled: string[] = [];
  const skipped: Array<{ id: string; reason: string }> = [];
  const lowConfidence: string[] = [];

  for (const [id, fv] of Object.entries(values)) {
    const locator = byId.get(id);
    if (!locator) {
      skipped.push({ id, reason: '无定位信息' });
      continue;
    }
    const result = applyOne(locator, fv);
    if (result.ok) {
      filled.push(id);
      if (fv.confidence === 'low') lowConfidence.push(id);
    } else {
      skipped.push({ id, reason: result.reason });
    }
  }

  return { filled, skipped, lowConfidence };
}
