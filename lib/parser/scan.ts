import type {
  FieldCandidate,
  FieldOption,
  FieldType,
  NoiseSkippedSample,
  ScanResult,
} from '@/lib/schema/form-schema';
import { classifyNoise } from '@/lib/parser/noise';
import {
  nearbyContext,
  resolveLabel,
  sectionHintFromDom,
} from '@/lib/parser/label';
import { cssEscape } from '@/lib/parser/css-escape';

function cssPath(el: Element): string {
  if (el.id) return `#${cssEscape(el.id)}`;
  const name = el.getAttribute('name');
  const tag = el.tagName.toLowerCase();
  if (name) {
    const same = document.querySelectorAll(`${tag}[name="${cssEscape(name)}"]`);
    if (same.length === 1) return `${tag}[name="${cssEscape(name)}"]`;
  }
  const parts: string[] = [];
  let cur: Element | null = el;
  while (cur && cur.nodeType === 1 && parts.length < 5) {
    let part = cur.tagName.toLowerCase();
    if (cur.id) {
      parts.unshift(`#${cssEscape(cur.id)}`);
      break;
    }
    const parentEl: HTMLElement | null = cur.parentElement;
    if (parentEl) {
      const siblings = [...parentEl.children].filter((c) => c.tagName === cur!.tagName);
      if (siblings.length > 1) {
        const idx = siblings.indexOf(cur) + 1;
        part += `:nth-of-type(${idx})`;
      }
    }
    parts.unshift(part);
    cur = parentEl;
  }
  return parts.join(' > ');
}

function mapInputType(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement): FieldType {
  if (el instanceof HTMLTextAreaElement) return 'textarea';
  if (el instanceof HTMLSelectElement) return 'select';
  const t = el.type.toLowerCase();
  if (t === 'number' || t === 'range') return 'number';
  if (t === 'date' || t === 'datetime-local' || t === 'month' || t === 'week') return 'date';
  if (t === 'checkbox') return 'checkbox';
  if (t === 'radio') return 'radio';
  if (t === 'file') return 'file';
  if (t === 'email' || t === 'tel' || t === 'url' || t === 'password' || t === 'text') return 'text';
  return 'unknown';
}

function readOptions(el: Element): FieldOption[] | undefined {
  if (el instanceof HTMLSelectElement) {
    return [...el.options].map((o) => ({
      label: o.textContent?.trim() || o.value,
      value: o.value,
    }));
  }
  if (el instanceof HTMLInputElement && el.type === 'radio' && el.name) {
    const group = document.querySelectorAll<HTMLInputElement>(
      `input[type="radio"][name="${cssEscape(el.name)}"]`,
    );
    return [...group].map((r) => ({
      label: resolveLabel(r),
      value: r.value,
    }));
  }
  return undefined;
}

function readValue(
  el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
): string | string[] | boolean | undefined {
  if (el instanceof HTMLSelectElement) {
    if (el.multiple) return [...el.selectedOptions].map((o) => o.value);
    return el.value || undefined;
  }
  if (el instanceof HTMLInputElement) {
    if (el.type === 'checkbox') return el.checked;
    if (el.type === 'radio') return el.checked ? el.value : undefined;
    if (el.type === 'file') return undefined;
    return el.value || undefined;
  }
  return el.value || undefined;
}

function detectRowIndex(el: Element): number | undefined {
  const tr = el.closest('tr[data-row], .goods-row, [data-repeat-index]');
  if (!tr) return undefined;
  const attr = tr.getAttribute('data-row') ?? tr.getAttribute('data-repeat-index');
  if (attr != null && attr !== '') {
    const n = Number(attr);
    return Number.isFinite(n) ? n : undefined;
  }
  const tbody = tr.closest('tbody');
  if (tbody && tr.parentElement === tbody) {
    return [...tbody.querySelectorAll(':scope > tr')].indexOf(tr as HTMLTableRowElement);
  }
  return undefined;
}

function isRepeatableContext(el: Element): boolean {
  return Boolean(
    el.closest('[data-repeatable], .goods-table, .line-items, table.repeatable'),
  );
}

function collectNativeControls(): Element[] {
  return [
    ...document.querySelectorAll('input, select, textarea'),
  ];
}

function collectCustomControls(): Element[] {
  return [
    ...document.querySelectorAll(
      '[role="combobox"], [role="listbox"], [role="textbox"][contenteditable="true"]',
    ),
  ].filter((el) => !(el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement));
}

export function scanDocument(): ScanResult {
  const noiseSamples: NoiseSkippedSample[] = [];
  let noiseCount = 0;
  const candidates: FieldCandidate[] = [];
  const seenRadio = new Set<string>();

  const elements = [...collectNativeControls(), ...collectCustomControls()];

  for (const el of elements) {
    const label = resolveLabel(el);
    const reason = classifyNoise(el, label);
    if (reason) {
      noiseCount += 1;
      if (noiseSamples.length < 12) {
        noiseSamples.push({
          reason,
          label,
          name: el.getAttribute('name') ?? undefined,
          selector: cssPath(el),
        });
      }
      continue;
    }

    if (el instanceof HTMLInputElement && el.type === 'radio') {
      const key = el.name || cssPath(el);
      if (seenRadio.has(key)) continue;
      seenRadio.add(key);
    }

    const tagName = el.tagName.toLowerCase();
    let guessedType: FieldType = 'unknown';
    let inputType: string | undefined;
    let options: FieldOption[] | undefined;
    let value: string | string[] | boolean | undefined;
    let required = el.hasAttribute('required') || el.getAttribute('aria-required') === 'true';
    let placeholder = el.getAttribute('placeholder') ?? undefined;

    if (
      el instanceof HTMLInputElement ||
      el instanceof HTMLTextAreaElement ||
      el instanceof HTMLSelectElement
    ) {
      guessedType = mapInputType(el);
      inputType = el instanceof HTMLInputElement ? el.type : tagName;
      options = readOptions(el);
      value = readValue(el);
    } else if (el.getAttribute('role') === 'combobox') {
      guessedType = 'select';
      inputType = 'combobox';
    } else if (el.getAttribute('role') === 'textbox') {
      guessedType = 'text';
    }

    const tempId = `c_${candidates.length + 1}`;
    candidates.push({
      tempId,
      label,
      guessedType,
      required,
      options,
      value,
      placeholder,
      name: el.getAttribute('name') ?? undefined,
      idAttr: el.id || undefined,
      selector: cssPath(el),
      tagName,
      inputType,
      context: nearbyContext(el),
      sectionHint: sectionHintFromDom(el),
      rowIndex: detectRowIndex(el),
      repeatableHint: isRepeatableContext(el),
    });
  }

  return {
    meta: {
      url:
        (typeof location !== 'undefined' && location.href) ||
        document.URL ||
        '',
      title: document.title,
      locale:
        document.documentElement.lang ||
        (typeof navigator !== 'undefined' && navigator.language) ||
        'zh-CN',
    },
    candidates,
    noiseSkipped: {
      count: noiseCount,
      samples: noiseSamples,
    },
  };
}
