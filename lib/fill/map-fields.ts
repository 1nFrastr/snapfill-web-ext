import type { FormFieldItem, FormFieldType } from '@/lib/api/types';
import type { FieldNode, FieldOption } from '@/lib/formgraph/types';

export type FieldLocator = {
  id: string;
  selector: string;
  type: FormFieldType;
  options?: FieldOption[];
  name?: string;
  inputType?: string;
  /** 多 frame 回填时定向；缺省为当前/顶层 */
  frameId?: number;
  /** 组件库场景：真值落在的隐藏原生 input/select */
  backingSelector?: string;
  /** FormGraph 控件真实类型，供 apply 引擎选择适配器 */
  widget?: FieldNode['control']['widget'];
  component?: FieldNode['control']['component'];
};

function toApiType(node: FieldNode): FormFieldType {
  const t = node.control.type.toLowerCase();
  if (t === 'email') return 'email';
  if (t === 'tel') return 'tel';
  if (['text', 'textarea', 'number', 'date', 'select', 'radio', 'checkbox'].includes(t)) {
    return t as FormFieldType;
  }
  if (node.control.tag === 'select') return 'select';
  if (node.control.tag === 'textarea' || node.control.widget === 'contenteditable') return 'textarea';
  return 'other';
}

/**
 * FormGraph 字段 → 后端 FormFieldItem[] + 本地回填定位表。
 *
 * 这是插件唯一的字段出口：LLM 不参与构造，避免语义在转述中丢失或被重建。
 * routeHint 为 skip/file/sign 的字段不参与 KB 检索，单独回收供汇报使用。
 */
export function formGraphToApiFields(fields: FieldNode[]): {
  fields: FormFieldItem[];
  locators: FieldLocator[];
  excluded: FieldNode[];
} {
  const apiFields: FormFieldItem[] = [];
  const locators: FieldLocator[] = [];
  const excluded: FieldNode[] = [];

  for (const f of fields) {
    if (f.routeHint === 'skip' || f.routeHint === 'file' || f.routeHint === 'sign') {
      excluded.push(f);
      continue;
    }
    const type = toApiType(f);
    const label = f.label || f.nearLabel || f.fieldId;
    const group = f.regionId !== 'ungrouped' ? f.queryHint.split(' / ').slice(0, -1).join(' / ') || undefined : undefined;
    const item: FormFieldItem = {
      id: f.fieldId,
      label,
      type,
      group,
      hint: f.queryHint && f.queryHint !== label ? f.queryHint : undefined,
    };
    const optionLabels = f.options?.map((o) => o.label || o.value).filter(Boolean);
    if ((type === 'select' || type === 'radio' || type === 'checkbox') && optionLabels?.length) {
      item.options = optionLabels;
    }
    apiFields.push(item);
    locators.push({
      id: f.fieldId,
      selector: f.locator.selector,
      type,
      options: f.options ?? undefined,
      name: f.locator.namePattern,
      inputType: f.control.type,
      frameId: f.frameId,
      backingSelector: f.locator.backingSelector,
      widget: f.control.widget,
      component: f.control.component,
    });
  }

  return { fields: apiFields, locators, excluded };
}

export function buildPageContext(meta: { title?: string; url?: string }): string {
  const title = meta.title?.trim() || '未命名页面';
  try {
    const host = meta.url ? new URL(meta.url).host : '';
    return host ? `${title}（${host}）` : title;
  } catch {
    return title;
  }
}
