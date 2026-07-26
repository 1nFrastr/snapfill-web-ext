import type { FieldLocator } from '@/lib/fill/map-fields';
import type { FormFieldValue } from '@/lib/api/types';
import type { ApplyResult, VerifyStatus } from '@/lib/fill/apply';
import type { FormGraphFragment } from '@/lib/formgraph/types';

export const MessageType = {
  FILL_DOM: 'SNAPFILL_FILL_DOM',
  SNAPSHOT_FORM: 'SNAPFILL_SNAPSHOT_FORM',
  DESCRIBE_REGION: 'SNAPFILL_DESCRIBE_REGION',
  READ_ELEMENT_DETAIL: 'SNAPFILL_READ_ELEMENT_DETAIL',
  ACTIVATE: 'SNAPFILL_ACTIVATE',
  OPEN_OPTIONS: 'SNAPFILL_OPEN_OPTIONS',
  WAIT_STABLE: 'SNAPFILL_WAIT_STABLE',
  VERIFY_APPLIED: 'SNAPFILL_VERIFY_APPLIED',
  RENDER_OVERLAY: 'SNAPFILL_RENDER_OVERLAY',
  CLEAR_OVERLAY: 'SNAPFILL_CLEAR_OVERLAY',
} as const;

export type MessageTypeName = (typeof MessageType)[keyof typeof MessageType];

/** Sidepanel ↔ background 流式 Agent 的 Port 名 */
export const AGENT_PORT = 'snapfill-agent';

export type FillDomRequest = {
  type: typeof MessageType.FILL_DOM;
  locators: FieldLocator[];
  values: Record<string, FormFieldValue>;
};

export type FillDomResponse =
  | { ok: true; result: ApplyResult }
  | { ok: false; error: string };

export type SnapshotFormRequest = {
  type: typeof MessageType.SNAPSHOT_FORM;
  maxFields?: number;
};

export type SnapshotFormResponse =
  | { ok: true; fragment: FormGraphFragment }
  | { ok: false; error: string };

export type DescribeRegionRequest = {
  type: typeof MessageType.DESCRIBE_REGION;
  regionId: string;
};

export type RegionFieldDetail = {
  fieldId: string;
  label: string;
  control: string;
  required: boolean;
  readonly: boolean;
  existingValue: string | string[] | boolean | null;
  rect: { x: number; y: number; w: number; h: number };
};

export type DescribeRegionResponse =
  | {
      ok: true;
      region: {
        regionId: string;
        kind: string;
        name: string;
        chain: string[];
        fields: RegionFieldDetail[];
        table?: { columns: { key: string; label: string }[] };
        repeat?: { rowCount: number; addTargetLabel?: string };
      };
    }
  | { ok: false; error: string };

export type ReadElementDetailRequest = {
  type: typeof MessageType.READ_ELEMENT_DETAIL;
  targetId: string;
};

export type ElementDetail = {
  tag: string;
  visible: boolean;
  display: string;
  value: string | null;
  checked: boolean | null;
  ariaExpanded: string | null;
  disabled: boolean;
  readonly: boolean;
  pattern: string | null;
  min: string | null;
  max: string | null;
  step: string | null;
  ariaDescribedByText: string | null;
  outerHtmlSnippet: string;
};

export type ReadElementDetailResponse =
  | { ok: true; detail: ElementDetail }
  | { ok: false; error: string };

export type ActivateAction = 'click' | 'focus' | 'hover' | 'scrollIntoView' | 'check' | 'uncheck';

export type ActivateRequest = {
  type: typeof MessageType.ACTIVATE;
  targetId: string;
  action: ActivateAction;
};

export type ActivateResponse =
  | { ok: true; performed: ActivateAction; urlChanged: boolean }
  | { ok: false; error: string };

export type OpenOptionsRequest = {
  type: typeof MessageType.OPEN_OPTIONS;
  targetId: string;
};

export type OpenOptionsResponse =
  | { ok: true; options: { label: string; value: string }[]; method: 'native' | 'aria' | 'heuristic' }
  | { ok: false; error: string };

export type WaitStableRequest = {
  type: typeof MessageType.WAIT_STABLE;
  maxMs?: number;
  quietMs?: number;
};

export type WaitStableResponse =
  | { ok: true; waitedMs: number; mutationCount: number }
  | { ok: false; error: string };

export type VerifyAppliedRequest = {
  type: typeof MessageType.VERIFY_APPLIED;
  locators: FieldLocator[];
  expected: Record<string, string>;
};

export type VerifyAppliedResponse =
  | { ok: true; result: Record<string, VerifyStatus> }
  | { ok: false; error: string };

/** 标注层：numbers 是 fieldId → control_key（含跨 frame 前缀），由 background 统一分配 */
export type RenderOverlayRequest = {
  type: typeof MessageType.RENDER_OVERLAY;
  numbers: Record<string, string>;
};

export type RenderOverlayResponse =
  | { ok: true; drawn: number }
  | { ok: false; error: string };

export type ClearOverlayRequest = {
  type: typeof MessageType.CLEAR_OVERLAY;
};

export type ClearOverlayResponse = { ok: true };

/** Sidepanel → background（Port） */
export type AgentPortClientMessage =
  | {
      type: 'start';
      prompt?: string;
      knowledgeFileIds?: string[];
      tabId?: number;
    }
  | { type: 'abort' };

/** Background → sidepanel（Port）流式事件 */
export type AgentStreamEvent =
  | { type: 'started'; model: string }
  | { type: 'text-delta'; delta: string }
  | { type: 'reasoning-delta'; delta: string }
  | {
      type: 'tool-call';
      toolCallId: string;
      toolName: string;
      args: unknown;
    }
  | {
      type: 'tool-result';
      toolCallId: string;
      toolName: string;
      result: unknown;
    }
  | {
      type: 'tool-error';
      toolCallId: string;
      toolName: string;
      error: string;
    }
  | { type: 'step-finish'; stepNumber: number }
  | {
      type: 'done';
      text: string;
      filledCount: number;
      unfilledCount: number;
      steps: number;
    }
  | { type: 'error'; error: string };

export type ExtensionRequest =
  | FillDomRequest
  | SnapshotFormRequest
  | DescribeRegionRequest
  | ReadElementDetailRequest
  | ActivateRequest
  | OpenOptionsRequest
  | WaitStableRequest
  | VerifyAppliedRequest
  | RenderOverlayRequest
  | ClearOverlayRequest;

export type ExtensionResponse =
  | FillDomResponse
  | SnapshotFormResponse
  | DescribeRegionResponse
  | ReadElementDetailResponse
  | ActivateResponse
  | OpenOptionsResponse
  | WaitStableResponse
  | VerifyAppliedResponse
  | RenderOverlayResponse
  | ClearOverlayResponse;
