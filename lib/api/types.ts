/** 与后端 FORM_FIELDS_FILL_API.md §6 对齐 */

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

export interface FormFieldItem {
  id: string;
  label?: string;
  type?: FormFieldType;
  options?: string[];
  hint?: string;
  group?: string;
}

export interface FormFieldsFillRequest {
  fields: FormFieldItem[];
  knowledge_file_ids?: string[];
  profile_id?: string | null;
  page_context?: string | null;
  device_id?: string | null;
}

export interface FormFieldValue {
  value: string;
  confidence: 'high' | 'medium' | 'low';
  sources: Array<{
    file_id?: string;
    filename?: string;
    path?: string;
    snippet?: string;
  }>;
}

export interface FormFieldsFillData {
  values: Record<string, FormFieldValue>;
  unfilled: string[];
  task_id: string;
  source_scope?: Record<string, unknown> | null;
}

export interface ApiEnvelope<T> {
  code: number;
  msg: string;
  data: T | null;
  date?: string;
}

export interface KnowledgeFile {
  id: string;
  filename: string;
  file_size?: number;
  created_at?: string;
  file_type?: string;
  is_active?: boolean;
  status?: string;
}

export interface KnowledgeFilesData {
  files: KnowledgeFile[];
  total?: number;
  page?: number;
  page_size?: number;
}
