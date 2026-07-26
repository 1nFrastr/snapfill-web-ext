/**
 * FormGraph：网页表单空间抽取的统一中间表示。
 *
 * 设计原则（对齐改造计划第四节）：
 * - 结构优先：DOM 能确定性给出的信息（控件类型/options/必填只读/table 行列/
 *   重复子树/门控关系/标签归属）一律结构+几何求解，不留给 LLM 猜。
 * - `locator` / `rect` 等定位信息只在插件本地使用，不随 commitFormGraph 上传后端；
 *   上传的是 regions + fields 的语义与空间摘要。
 * - source.kind 预留 'pdf'，但本契约由 Web 侧的信息量定义，不迁就 PDF 实验的临时 schema。
 */

export type Rect = { x: number; y: number; w: number; h: number };

export type ControlWidget =
  | 'native' // input/select/textarea
  | 'aria' // role=combobox|listbox|textbox
  | 'component' // 组件库（react-select/antd-select/...），真值在隐藏 backing input
  | 'contenteditable'
  | 'canvas'; // 签名板等，仅能截图兜底

export type ComponentKind =
  | 'react-select'
  | 'antd-select'
  | 'element-select'
  | 'datepicker'
  | 'richtext'
  | 'upload'
  | 'signature';

export type LabelSource =
  | 'label-for'
  | 'wrapping-label'
  | 'aria'
  /** radio/checkbox 组被去重成单字段后，取到的"组问题"（如"是否含境外人员"） */
  | 'group-question'
  | 'table-header'
  | 'placeholder'
  | 'empty';

export type TextFact = {
  text: string;
  rect: Rect;
  frameId: number;
  panelKey: string;
  domPath: string;
  fontSize: number;
  fontWeight: number;
  tablePos?: { tableIndex: number; row: number; col: number };
  leaf: boolean;
};

export type RouteHint =
  | 'normal'
  | 'verbose'
  | 'choice'
  | 'file'
  | 'sign'
  | 'skip';

export type RegionKind =
  | 'kv'
  | 'multiline'
  | 'repeat_group'
  | 'choice_group'
  | 'upload'
  | 'readonly';

export type RegionEvidence =
  | 'fieldset'
  | 'heading'
  | 'table'
  | 'geometry-gap'
  | 'repeat-pattern'
  | 'dialog'
  | 'tabpanel';

export type FrameNode = {
  frameId: number;
  parentFrameId: number | null;
  url: string;
  title: string;
  crossOrigin: boolean;
  /** 该 frame 相对顶层页面的累积偏移；同源链可算，跨域链只能是 null */
  pageOffset: { dx: number; dy: number } | null;
  totalControls: number;
  visibleControls: number;
};

/**
 * 面板（tab / 步骤条页签）：同一个 frame 内互斥显示的表单分片。
 *
 * 它是累积的第二维度：切 tab 会把上一个面板的 DOM 移除，若仍按 frame 整体覆盖，
 * 先前抽到的字段会被抹掉。key 由 tab 按钮的 cssPath 派生（与 interactiveId 同源），
 * 因此"刚激活的那个 tab"和"当前激活面板"能对上号。
 */
export type PanelRef = {
  /** '' 表示该 frame 没有面板结构（单面板页面） */
  key: string;
  label: string;
};

export type PanelNode = PanelRef & {
  frameId: number;
  /** 是否已经抽取过；false = 已知存在但 Agent 还没切进去看 */
  captured: boolean;
  /** 该面板一次抽取里的候选控件数，作为 coverage 的分母来源 */
  controlsSeen: number;
  dropped: Record<string, number>;
};

export type TableMeta = {
  tableIndex: number;
  row: number;
  col: number;
  colspan: number;
  rowspan: number;
  controlsInCell: number;
  /**
   * 格内控件跨了几个视觉行。>1 说明这个 td 是布局容器而不是数据格——
   * 左邻格/表头描述的是外层大表的行列，与格内控件无关。
   */
  rowsInCell: number;
};

export type SiblingSlot = {
  index: number;
  count: number;
  sharedLabel: string;
};

export type NeighborsInfo = {
  textLeft: string;
  textRight: string;
  textAbove: string;
  textBelow: string;
  fieldLeftId: string | null;
  fieldRightId: string | null;
  fieldAboveId: string | null;
  fieldBelowId: string | null;
};

export type FieldOption = { label: string; value: string };

export type ControlInfo = {
  tag: string;
  type: string; // input.type / select|textarea / role
  widget: ControlWidget;
  component?: ComponentKind;
};

export type FieldNode = {
  fieldId: string;
  /**
   * 阅读顺序编号（单个 frame 的单个面板内 1-based）。它同时是标注截图上画的徽标数字和 trace
   * 映射表的主键：肉眼对一遍编号就能判断"控件 ↔ 题干"配没配对。
   * 跨 frame / 跨面板由 trace.makeControlKey() 加 f{frameId}- / p{面板序号}- 前缀去歧义。
   */
  controlNo: number;
  regionId: string;
  /** 所属面板；与 frameId 一起构成累积/覆盖的键 */
  panelKey: string;
  control: ControlInfo;

  label: string;
  labelSource: LabelSource;
  labelConfidence: 'high' | 'medium' | 'low';
  /** 本地核对提示（最近文本），不上传后端 */
  nearLabel: string;

  rect: Rect;
  pageRect: Rect;
  frameId: number;

  table: TableMeta | null;
  rowIndex?: number;
  columnKey?: string;
  siblingSlot: SiblingSlot | null;
  neighbors: NeighborsInfo;

  options: FieldOption[] | null;
  optionsSource: 'dom' | 'expanded' | 'unknown';
  required: boolean;
  readonly: boolean;
  disabled: boolean;
  existingValue: string | string[] | boolean | null;
  routeHint: RouteHint;
  /** 结构事实：位于分页器或表尾 */
  inPager: boolean;
  inTableFooter: boolean;

  /** 本地定位信息；不上传后端 */
  locator: {
    selector: string;
    backingSelector?: string; // 隐藏真值 input（组件库场景）
    shadowPath?: string[]; // open shadow root 穿透路径（每级宿主 selector）
    frameId: number;
    namePattern?: string;
  };
};

export type RepeatInfo = {
  templateFieldIds: string[];
  rowCount: number;
  addTargetSelector?: string;
  addTargetLabel?: string;
};

export type GatedBy = {
  fieldId: string;
  whenValue: string;
  label: string;
};

export type RegionNode = {
  regionId: string;
  kind: RegionKind;
  name: string;
  /** [theme?, parentSection?, section] 对齐后端 _build_kb_query 的三层链 */
  chain: string[];
  rect: Rect;
  frameId: number;
  panelKey: string;
  fieldIds: string[];

  table?: {
    rowRange: [number, number];
    columns: { key: string; label: string }[];
  };
  repeat?: RepeatInfo;
  gatedBy?: GatedBy;

  confidence: 'high' | 'medium' | 'low';
  evidence: RegionEvidence[];
};

export type InteractiveKind =
  | 'tab'
  | 'accordion'
  | 'add-button'
  | 'dialog-trigger'
  | 'gate-candidate'
  | 'wizard-next';

export type InteractiveNode = {
  interactiveId: string;
  kind: InteractiveKind;
  label: string;
  frameId: number;
  rect: Rect;
  selector: string;
  /** 关联的 region（例如 add-button 关联的重复块 / gate-candidate 关联的受控区） */
  relatedRegionId?: string;
  status: 'pending' | 'activated' | 'skipped';
  /** gate-candidate 专用：猜测的门控取值（例如"是"对应的 radio value） */
  suggestedValue?: string;
};

export type UnresolvedReason =
  | 'closed-shadow'
  | 'canvas-form'
  | 'cross-origin-frame'
  | 'tag-input'
  | 'file-input'
  | 'virtualized-list'
  | 'unknown-widget';

export type UnresolvedItem = {
  reason: UnresolvedReason;
  frameId: number;
  selector?: string;
  note: string;
};

export type ExtractionMetrics = {
  /** 本面板内渲染出来的候选控件数（不含隐藏面板/隐藏类型/backing/重复 radio） */
  controlsSeen: number;
  /** 被丢弃的控件按原因计数；没有它就分不清"正确忽略噪声"和"误杀字段" */
  dropped: Record<string, number>;
  fieldsResolved: number;
  coverage: number; // fieldsResolved / max(controlsSeen,1)
  labeledHighConf: number;
  labeledRate: number; // labeledHighConf / max(fieldsResolved,1)
  regionsClassified: number;
  regionsAmbiguous: number;
  interactivesPending: number;
  interactivesActivated: number;
  unresolvedCount: number;
};

export type FormGraphSource = {
  kind: 'web' | 'pdf';
  url?: string;
  title?: string;
  capturedAt: string;
};

/** 单个 frame 一次抽取产出的片段；跨 frame/跨轮次由 merge.ts 累积成完整 FormGraph */
export type FormGraphFragment = {
  schemaVersion: 'form_graph.v1';
  frameId: number;
  /** 本次抽取时处于激活态的面板；null = 该 frame 无面板结构 */
  panel: PanelRef | null;
  /** 本次在 DOM 里看到的全部面板（含未激活的），用于告诉 Agent 还剩哪些没抽 */
  panels: PanelRef[];
  regions: RegionNode[];
  fields: FieldNode[];
  /** 本 frame 全部可见文本叶子（事实层，供后端语义关联） */
  texts: TextFact[];
  interactives: InteractiveNode[];
  unresolved: UnresolvedItem[];
  metrics: ExtractionMetrics;
};

export type FormGraph = {
  schemaVersion: 'form_graph.v1';
  source: FormGraphSource;
  frames: FrameNode[];
  panels: PanelNode[];
  regions: RegionNode[];
  fields: FieldNode[];
  texts: TextFact[];
  interactives: InteractiveNode[];
  unresolved: UnresolvedItem[];
  metrics: ExtractionMetrics;
};

export type FormGraphDiff = {
  addedFieldIds: string[];
  removedFieldIds: string[];
  changedFieldIds: string[];
  addedRegionIds: string[];
  removedRegionIds: string[];
};
