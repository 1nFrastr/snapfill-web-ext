import { ToolLoopAgent, isStepCount } from 'ai';
import { createDeepSeek } from '@ai-sdk/deepseek';
import { deepSeekConfig } from '@/lib/ai/config';
import {
  deepSeekProviderBaseUrl,
  isDeepSeekConfigured,
} from '@/lib/ai/deepseek';
import {
  createSnapfillTools,
  type AgentToolContext,
} from '@/lib/agent/tools';
import type { AgentStreamEvent } from '@/lib/messaging/types';
import { elapsed, slog, swarn } from '@/lib/log';

const INSTRUCTIONS = `你是 Snapfill 网页表单填写 Agent。插件侧负责抽 DOM / 回填；后端 form-fields/fill 负责根据知识库生成建议值。

标准流程（必须用工具，不要臆造字段值）：
1. extractPageFields — 抽取当前页/当前步骤可见字段
2. （可选）listKnowledgeFiles — 查看可用知识库；用户未指定时通常省略 knowledge_file_ids，让后端用全部已完成知识库
3. fillFormFields — 把 fields + page_context 交给后端
4. applyFieldValues — 把返回的 values 写回页面

约束：
- 不要一次塞超过 80 个字段；大表单可提示用户分步，但当前页仍应尽量完成一轮
- page_context 要带步骤/页签语义
- 只信任工具返回；完成后用中文简短汇报：抽取数、写入数、未填、低置信度字段
- 若抽取 0 字段或后端报错，说明原因并停止`;

export type RunSnapfillAgentInput = {
  tabId: number;
  prompt?: string;
  knowledgeFileIds?: string[];
  abortSignal?: AbortSignal;
  onEvent?: (event: AgentStreamEvent) => void;
};

export type RunSnapfillAgentResult = {
  text: string;
  filledCount: number;
  unfilledCount: number;
  steps: number;
};

function summarizeToolResult(toolName: string, output: unknown): unknown {
  if (output == null || typeof output !== 'object') return output;
  const o = output as Record<string, unknown>;

  switch (toolName) {
    case 'extractPageFields': {
      const fields = Array.isArray(o.fields) ? o.fields : [];
      return {
        ok: o.ok,
        fieldCount: fields.length,
        page_context: o.page_context,
        message: o.message,
      };
    }
    case 'listKnowledgeFiles': {
      const files = Array.isArray(o.files) ? o.files : [];
      return {
        count: files.length,
        files: files.slice(0, 12).map((f) => {
          const file = f as Record<string, unknown>;
          return {
            id: file.id,
            name: file.name ?? file.filename,
            status: file.status,
          };
        }),
      };
    }
    case 'fillFormFields': {
      const values =
        o.values && typeof o.values === 'object'
          ? Object.keys(o.values as object).length
          : 0;
      return {
        ok: o.ok,
        valueCount: values,
        unfilled: Array.isArray(o.unfilled) ? o.unfilled.length : undefined,
        low_confidence: Array.isArray(o.low_confidence)
          ? o.low_confidence.length
          : undefined,
        message: o.message,
      };
    }
    case 'applyFieldValues': {
      return {
        ok: o.ok,
        filled: Array.isArray(o.filled) ? o.filled.length : 0,
        skipped: Array.isArray(o.skipped) ? o.skipped.length : 0,
        message: o.message,
      };
    }
    default:
      return o;
  }
}

function createAgent(ctx: AgentToolContext) {
  const deepseek = createDeepSeek({
    apiKey: deepSeekConfig.apiKey,
    baseURL: deepSeekProviderBaseUrl(),
  });

  return new ToolLoopAgent({
    model: deepseek(deepSeekConfig.model),
    instructions: INSTRUCTIONS,
    tools: createSnapfillTools(ctx),
    stopWhen: isStepCount(12),
    temperature: 0.1,
  });
}

/** 流式运行 Agent，通过 onEvent 推送文本增量与工具调用 */
export async function streamSnapfillAgent(
  input: RunSnapfillAgentInput,
): Promise<RunSnapfillAgentResult> {
  if (!isDeepSeekConfigured()) {
    throw new Error('未配置 DeepSeek API Key（lib/ai/config.ts → deepSeekConfig）');
  }

  const started = Date.now();
  const emit = (event: AgentStreamEvent) => input.onEvent?.(event);
  const ctx: AgentToolContext = {
    tabId: input.tabId,
    locators: [],
    lastFields: [],
    lastPageContext: '',
    preferredKnowledgeIds: input.knowledgeFileIds,
  };

  const agent = createAgent(ctx);
  const userPrompt =
    input.prompt?.trim() ||
    '请填写当前页可见表单：抽取字段 → 调用后端填值 → 写回 DOM，并汇报结果。';

  slog(
    'agent',
    `ToolLoopAgent.stream 开始 tab=${input.tabId} model=${deepSeekConfig.model}`,
  );
  emit({ type: 'started', model: deepSeekConfig.model });

  const result = await agent.stream({
    prompt: userPrompt,
    abortSignal: input.abortSignal,
    timeout: {
      totalMs: Math.max(deepSeekConfig.timeoutMs ?? 180_000, 180_000),
    },
  });

  let stepNumber = 0;
  for await (const part of result.fullStream) {
    switch (part.type) {
      case 'text-delta':
        emit({ type: 'text-delta', delta: part.text });
        break;
      case 'tool-call':
        emit({
          type: 'tool-call',
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          args: part.input,
        });
        break;
      case 'tool-result':
        emit({
          type: 'tool-result',
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          result: summarizeToolResult(part.toolName, part.output),
        });
        break;
      case 'tool-error':
        emit({
          type: 'tool-error',
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          error:
            part.error instanceof Error
              ? part.error.message
              : String(part.error),
        });
        break;
      case 'finish-step':
        stepNumber += 1;
        emit({ type: 'step-finish', stepNumber });
        break;
      case 'error':
        throw part.error instanceof Error
          ? part.error
          : new Error(String(part.error));
      default:
        break;
    }
  }

  const text = (await result.text)?.trim() ?? '';
  const steps = (await result.steps).length;
  const filledCount = ctx.lastApply?.filled.length ?? 0;
  const finalText =
    text ||
    (filledCount > 0
      ? `已写入 ${filledCount} 个字段。`
      : 'Agent 已结束，但未产生可展示摘要。');

  slog(
    'agent',
    `ToolLoopAgent.stream 完成 steps=${steps} filled=${filledCount} ${elapsed(started)}`,
  );

  if (!ctx.lastApply && ctx.lastFields.length > 0) {
    swarn('agent', '有抽取字段但未执行 applyFieldValues');
  }

  const out: RunSnapfillAgentResult = {
    text: finalText,
    filledCount,
    unfilledCount: Math.max(0, ctx.lastFields.length - filledCount),
    steps,
  };

  emit({
    type: 'done',
    text: out.text,
    filledCount: out.filledCount,
    unfilledCount: out.unfilledCount,
    steps: out.steps,
  });

  return out;
}

/** 非流式（CLI / 兼容）；内部仍走 stream 并丢弃中间事件 */
export async function runSnapfillAgent(
  input: Omit<RunSnapfillAgentInput, 'onEvent'>,
): Promise<RunSnapfillAgentResult> {
  return streamSnapfillAgent(input);
}
