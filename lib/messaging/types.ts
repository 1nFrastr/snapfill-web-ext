import type { FieldLocator } from '@/lib/fill/map-fields';
import type { FormFieldValue } from '@/lib/api/types';
import type { ScanResult } from '@/lib/schema/form-schema';
import type { ApplyResult } from '@/lib/fill/apply';

export const MessageType = {
  SCAN_DOM: 'SNAPFILL_SCAN_DOM',
  FILL_DOM: 'SNAPFILL_FILL_DOM',
} as const;

export type MessageTypeName = (typeof MessageType)[keyof typeof MessageType];

/** Sidepanel ↔ background 流式 Agent 的 Port 名 */
export const AGENT_PORT = 'snapfill-agent';

export type ScanDomRequest = {
  type: typeof MessageType.SCAN_DOM;
};

export type ScanDomResponse =
  | { ok: true; scan: ScanResult }
  | { ok: false; error: string };

export type FillDomRequest = {
  type: typeof MessageType.FILL_DOM;
  locators: FieldLocator[];
  values: Record<string, FormFieldValue>;
};

export type FillDomResponse =
  | { ok: true; result: ApplyResult }
  | { ok: false; error: string };

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

export type ExtensionRequest = ScanDomRequest | FillDomRequest;

export type ExtensionResponse = ScanDomResponse | FillDomResponse;
