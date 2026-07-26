/** 与后端 /Table/form-regions/fill 事实层契约对齐 */

export type FormFieldType =
  | 'text'
  | 'select'
  | 'checkbox'
  | 'radio'
  | 'textarea'
  | 'date'
  | 'email'
  | 'tel'
  | 'number'
  | 'other';

export type FormFactRect = { x: number; y: number; w: number; h: number };

export type FormFactControl = {
  id: string;
  control_no: number;
  type: FormFieldType;
  tag?: string;
  widget?: string;
  frame_id: number;
  panel_key?: string;
  region_id?: string;
  rect: FormFactRect;
  dom_path: string;
  html_label?: string;
  label_source?: string;
  options?: string[];
  in_pager?: boolean;
  in_table_footer?: boolean;
  table_pos?: {
    table_index: number;
    row: number;
    col: number;
    colspan?: number;
    rowspan?: number;
  };
  row_index?: number;
  column_key?: string;
  sibling_slot?: { index: number; count: number; shared_label?: string };
  gated_by?: { field_id: string; when_value: string; label?: string };
  state?: {
    required?: boolean;
    readonly?: boolean;
    disabled?: boolean;
    existing_value?: unknown;
  };
};

export type FormFactText = {
  text: string;
  rect: FormFactRect;
  frame_id: number;
  panel_key?: string;
  dom_path: string;
  font_size: number;
  font_weight: number;
  leaf?: boolean;
  table_pos?: { table_index: number; row: number; col: number };
};

export type FormFactStructure = {
  regions: Array<{
    region_id: string;
    kind: string;
    name: string;
    chain: string[];
    frame_id: number;
    panel_key?: string;
    rect?: FormFactRect;
    field_ids: string[];
    columns?: Array<{ key: string; label: string }>;
    row_count?: number;
    gated_by?: { field_id: string; when_value: string; label?: string };
  }>;
  panels?: Array<{
    key: string;
    label: string;
    frame_id: number;
    captured: boolean;
  }>;
  interactives?: Array<{
    interactive_id: string;
    kind: string;
    label: string;
    frame_id: number;
    related_region_id?: string;
    status: string;
  }>;
};

export type FormFactPayload = {
  controls: FormFactControl[];
  texts: FormFactText[];
  structure: FormFactStructure;
  page_context?: string | null;
  knowledge_file_ids?: string[];
  profile_id?: string | null;
  device_id?: string | null;
};

export type FormFieldValue = {
  value: string;
  confidence: 'high' | 'medium' | 'low';
  sources: Array<{
    file_id?: string;
    filename?: string;
    path?: string;
    snippet?: string;
  }>;
};

export type FormFieldsFillData = {
  values: Record<string, FormFieldValue>;
  unfilled: string[];
  task_id: string;
  source_scope?: Record<string, unknown> | null;
  /** 后端语义关联摘要（可选） */
  semantics?: Record<string, unknown> | null;
};

export type ApiEnvelope<T> = {
  code: number;
  msg: string;
  data: T | null;
  date?: string;
};

export type KnowledgeFile = {
  id: string;
  filename: string;
  file_size?: number;
  created_at?: string;
  file_type?: string;
  is_active?: boolean;
  status?: string;
};

export type KnowledgeFilesData = {
  files: KnowledgeFile[];
  total?: number;
  page?: number;
  page_size?: number;
};
