import { tool } from 'ai';
import { z } from 'zod';
import {
  fillFormFields,
  listKnowledgeFiles,
} from '@/lib/api/client';
import type { FormFieldItem, FormFieldValue } from '@/lib/api/types';
import {
  buildPageContext,
  candidatesToApiFields,
  type FieldLocator,
} from '@/lib/fill/map-fields';
import { MessageType } from '@/lib/messaging/types';
import { slog } from '@/lib/log';

export type AgentToolContext = {
  tabId: number;
  /** 最近一次抽取的定位表，供 apply 使用 */
  locators: FieldLocator[];
  lastFields: FormFieldItem[];
  lastPageContext: string;
  lastApply?: {
    filled: string[];
    skipped: Array<{ id: string; reason: string }>;
    lowConfidence: string[];
  };
  preferredKnowledgeIds?: string[];
};

async function withContentScript<T>(
  tabId: number,
  send: () => Promise<T>,
): Promise<T> {
  try {
    return await send();
  } catch (first) {
    await browser.scripting.executeScript({
      target: { tabId },
      files: ['/content-scripts/content.js'],
    });
    try {
      return await send();
    } catch {
      throw first instanceof Error
        ? first
        : new Error('无法连接页面脚本，请刷新后重试');
    }
  }
}

export function createSnapfillTools(ctx: AgentToolContext) {
  return {
    extractPageFields: tool({
      description:
        '从当前浏览器标签页抽取可见表单字段（结构化 JSON，非 HTML）。返回 fields[] 供后续 fillFormFields 使用。每步/页签应单独抽取一次。',
      inputSchema: z.object({
        note: z
          .string()
          .optional()
          .describe('可选备注，例如当前步骤名'),
      }),
      execute: async ({ note }) => {
        const res = await withContentScript(ctx.tabId, () =>
          browser.tabs.sendMessage(ctx.tabId, {
            type: MessageType.SCAN_DOM,
          }),
        );
        if (!res?.ok) {
          throw new Error(res?.error || '页面字段抽取失败');
        }
        const scan = res.scan;
        const { fields, locators } = candidatesToApiFields(scan.candidates);
        if (fields.length === 0) {
          return {
            ok: false as const,
            message: '当前页没有可填表单字段',
            fields: [] as FormFieldItem[],
            page_context: '',
          };
        }
        if (fields.length > 80) {
          fields.length = 80;
          locators.length = 80;
        }
        const page_context =
          (note?.trim() ? `${note.trim()} · ` : '') +
          buildPageContext(scan.meta);
        ctx.locators = locators;
        ctx.lastFields = fields;
        ctx.lastPageContext = page_context;
        slog('agent', `extractPageFields n=${fields.length} context=${page_context}`);
        return {
          ok: true as const,
          fieldCount: fields.length,
          page_context,
          fields,
          tip: '推荐每批 ≤20 字段；可把 fields 原样传给 fillFormFields',
        };
      },
    }),

    listKnowledgeFiles: tool({
      description:
        '列出用户已完成解析的知识库文件。侧栏勾选的文件会作为 preferred ids 自动传入 fill；一般无需再改 knowledge_file_ids。',
      inputSchema: z.object({
        page: z.number().int().min(1).optional(),
        pageSize: z.number().int().min(1).max(100).optional(),
      }),
      execute: async ({ page, pageSize }) => {
        const files = await listKnowledgeFiles({ page, pageSize });
        return {
          count: files.length,
          files: files.map((f) => ({
            id: f.id,
            filename: f.filename,
            status: f.status,
            created_at: f.created_at,
          })),
        };
      },
    }),

    fillFormFields: tool({
      description:
        '调用后端 POST /Table/form-fields/fill，根据知识库为 fields 生成建议值。必须先 extractPageFields。超时建议充足；返回 values / unfilled。',
      inputSchema: z.object({
        fields: z
          .array(
            z.object({
              id: z.string(),
              label: z.string().optional(),
              type: z
                .enum([
                  'text',
                  'select',
                  'checkbox',
                  'radio',
                  'textarea',
                  'date',
                  'email',
                  'tel',
                  'number',
                  'other',
                ])
                .optional(),
              options: z.array(z.string()).optional(),
              hint: z.string().optional(),
              group: z.string().optional(),
            }),
          )
          .min(1)
          .max(80)
          .optional()
          .describe('省略则使用最近一次 extractPageFields 的结果'),
        knowledge_file_ids: z
          .array(z.string())
          .optional()
          .describe(
            '优先省略：侧栏已勾选时由系统注入；显式传入会覆盖。[]=不使用知识库（需 profile_id）',
          ),
        page_context: z.string().optional(),
        profile_id: z.string().nullable().optional(),
      }),
      execute: async (input) => {
        const fields = input.fields?.length ? input.fields : ctx.lastFields;
        if (!fields.length) {
          throw new Error('没有可填字段，请先调用 extractPageFields');
        }
        const knowledge_file_ids =
          ctx.preferredKnowledgeIds?.length
            ? ctx.preferredKnowledgeIds
            : input.knowledge_file_ids;
        const data = await fillFormFields({
          fields,
          knowledge_file_ids,
          page_context: input.page_context ?? ctx.lastPageContext ?? null,
          profile_id: input.profile_id ?? null,
        });
        const filledIds = Object.entries(data.values)
          .filter(([, v]) => Boolean(v.value?.trim()))
          .map(([id]) => id);
        slog(
          'agent',
          `fillFormFields task=${data.task_id} filled=${filledIds.length} unfilled=${data.unfilled.length}`,
        );
        return {
          task_id: data.task_id,
          filledCount: filledIds.length,
          unfilled: data.unfilled,
          values: data.values,
          tip: '接着调用 applyFieldValues，把 values 写回页面',
        };
      },
    }),

    applyFieldValues: tool({
      description:
        '把 fillFormFields 返回的 values 写回当前页 DOM。仅写入非空 value；不会清空未返回的字段。',
      inputSchema: z.object({
        values: z.record(
          z.string(),
          z.object({
            value: z.string(),
            confidence: z.enum(['high', 'medium', 'low']).optional(),
            sources: z
              .array(
                z.object({
                  file_id: z.string().optional(),
                  filename: z.string().optional(),
                  path: z.string().optional(),
                  snippet: z.string().optional(),
                }),
              )
              .optional(),
          }),
        ),
      }),
      execute: async ({ values }) => {
        if (!ctx.locators.length) {
          throw new Error('缺少字段定位表，请先 extractPageFields');
        }
        const normalized: Record<string, FormFieldValue> = {};
        for (const [id, v] of Object.entries(values)) {
          normalized[id] = {
            value: v.value,
            confidence: v.confidence ?? 'medium',
            sources: v.sources ?? [],
          };
        }
        const res = await withContentScript(ctx.tabId, () =>
          browser.tabs.sendMessage(ctx.tabId, {
            type: MessageType.FILL_DOM,
            locators: ctx.locators,
            values: normalized,
          }),
        );
        if (!res?.ok) {
          throw new Error(res?.error || 'DOM 回填失败');
        }
        ctx.lastApply = res.result;
        slog(
          'agent',
          `applyFieldValues filled=${res.result.filled.length} skipped=${res.result.skipped.length}`,
        );
        return {
          filled: res.result.filled,
          filledCount: res.result.filled.length,
          skipped: res.result.skipped,
          lowConfidence: res.result.lowConfidence,
        };
      },
    }),
  };
}

export type SnapfillTools = ReturnType<typeof createSnapfillTools>;
