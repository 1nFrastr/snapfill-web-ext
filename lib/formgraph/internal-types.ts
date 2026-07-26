/**
 * 抽取过程中的「带元素引用」中间态类型。
 * 最终产出 FormGraphFragment 前会剥离 el 引用（DOM 节点不可结构化克隆/上传）；
 * 元素引用另存进 content script 的本地 registry，供 describeRegion/activate 等工具按 id 查回。
 */
import type {
  FieldNode,
  GatedBy,
  InteractiveNode,
  RegionKind,
  RegionEvidence,
  RepeatInfo,
} from '@/lib/formgraph/types';

export type WorkingField = FieldNode & { el: Element };

export type WorkingRegion = {
  regionId: string;
  kind: RegionKind;
  name: string;
  chain: string[];
  frameId: number;
  fieldEls: Element[]; // 本区域内的字段元素（用于二次归属/重复块检测）
  containerEl: Element; // 区域容器元素，供 describeRegion 使用
  /**
   * 容器被内部标题行切成了多段，本区域只是其中一段。
   * 此时 containerEl 覆盖的范围大于本区域，rect 得由字段并集算，
   * 表格分类也不该再按整个容器来做（它是布局表，不是数据表）。
   */
  split: boolean;
  table?: { rowRange: [number, number]; columns: { key: string; label: string }[] };
  repeat?: RepeatInfo;
  gatedBy?: GatedBy;
  confidence: 'high' | 'medium' | 'low';
  evidence: RegionEvidence[];
};

export type WorkingInteractive = InteractiveNode & { el: Element };
