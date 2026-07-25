/** DOM 扫描与字段候选类型（Agent 工具 extractPageFields 使用） */

export type FieldType =
  | 'text'
  | 'textarea'
  | 'number'
  | 'date'
  | 'select'
  | 'radio'
  | 'checkbox'
  | 'file'
  | 'unknown';

export type FieldOption = {
  label: string;
  value: string;
};

export type NoiseSkippedSample = {
  reason: string;
  label?: string;
  name?: string;
  selector?: string;
};

/** Content script 扫出的轻量候选 */
export type FieldCandidate = {
  tempId: string;
  label: string;
  guessedType: FieldType;
  required: boolean;
  options?: FieldOption[];
  value?: string | string[] | boolean;
  placeholder?: string;
  name?: string;
  idAttr?: string;
  selector: string;
  tagName: string;
  inputType?: string;
  context: string;
  sectionHint?: string;
  rowIndex?: number;
  repeatableHint?: boolean;
};

export type ScanResult = {
  meta: {
    url: string;
    title: string;
    locale: string;
  };
  candidates: FieldCandidate[];
  noiseSkipped: {
    count: number;
    samples: NoiseSkippedSample[];
  };
};
