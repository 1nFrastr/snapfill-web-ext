import type { FieldCandidate, FieldOption, FieldType } from '@/lib/schema/form-schema';
import type { FormFieldItem, FormFieldType } from '@/lib/api/types';

export type FieldLocator = {
  id: string;
  selector: string;
  type: FormFieldType;
  options?: FieldOption[];
  name?: string;
  inputType?: string;
};

function toApiType(guessed: FieldType, inputType?: string): FormFieldType {
  const t = (inputType || '').toLowerCase();
  if (t === 'email') return 'email';
  if (t === 'tel') return 'tel';
  switch (guessed) {
    case 'text':
    case 'textarea':
    case 'number':
    case 'date':
    case 'select':
    case 'radio':
    case 'checkbox':
      return guessed;
    case 'file':
    case 'unknown':
    default:
      return 'other';
  }
}

function optionStrings(options?: FieldOption[]): string[] | undefined {
  if (!options?.length) return undefined;
  return options.map((o) => o.label || o.value).filter(Boolean);
}

function stableFieldId(c: FieldCandidate, used: Set<string>): string {
  const base = (c.name || c.idAttr || c.tempId).trim() || c.tempId;
  let id = base.slice(0, 200);
  if (!used.has(id)) {
    used.add(id);
    return id;
  }
  let n = 2;
  while (used.has(`${id}__${n}`)) n += 1;
  const next = `${id}__${n}`.slice(0, 200);
  used.add(next);
  return next;
}

/** 扫描候选 → 后端 FormFieldItem[] + 本地回填定位表 */
export function candidatesToApiFields(candidates: FieldCandidate[]): {
  fields: FormFieldItem[];
  locators: FieldLocator[];
} {
  const used = new Set<string>();
  const fields: FormFieldItem[] = [];
  const locators: FieldLocator[] = [];

  for (const c of candidates) {
    if (c.guessedType === 'file') continue;
    const id = stableFieldId(c, used);
    const type = toApiType(c.guessedType, c.inputType);
    const options = optionStrings(c.options);
    const item: FormFieldItem = {
      id,
      label: c.label || c.name || id,
      type,
      group: c.sectionHint || undefined,
      hint: c.placeholder || undefined,
    };
    if (
      (type === 'select' || type === 'radio' || type === 'checkbox') &&
      options?.length
    ) {
      item.options = options;
    }
    fields.push(item);
    locators.push({
      id,
      selector: c.selector,
      type,
      options: c.options,
      name: c.name,
      inputType: c.inputType,
    });
  }

  return { fields, locators };
}

export function buildPageContext(meta: {
  title?: string;
  url?: string;
}): string {
  const title = meta.title?.trim() || '未命名页面';
  try {
    const host = meta.url ? new URL(meta.url).host : '';
    return host ? `${title}（${host}）` : title;
  } catch {
    return title;
  }
}
