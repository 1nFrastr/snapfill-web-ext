#!/usr/bin/env node
/**
 * Snapfill 端到端填表测试（不依赖扩展 UI）
 *
 * 链路：
 *   JSDOM 扫 fixture HTML
 *   → 映射 FormFieldItem
 *   → 登录本地后端 +（可选）上传知识库
 *   → POST /Table/form-fields/fill
 *   → 写回 DOM
 *   →（可选 --agent）DeepSeek ToolLoopAgent 再跑一轮
 *
 * 用法：
 *   pnpm e2e
 *   pnpm e2e visa-application
 *   pnpm e2e --agent
 *   pnpm e2e --fresh-kb
 *   pnpm e2e --kb-id <uuid>
 *   pnpm e2e --kb /path/to/kb.txt
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { ToolLoopAgent, isStepCount, tool } from 'ai';
import { createDeepSeek } from '@ai-sdk/deepseek';
import { z } from 'zod';
import { scanDocument } from '../lib/parser/scan';
import {
  buildPageContext,
  candidatesToApiFields,
  type FieldLocator,
} from '../lib/fill/map-fields';
import { applyFieldValuesToDom } from '../lib/fill/apply';
import type { FormFieldItem, FormFieldValue } from '../lib/api/types';
import { getEnvBuiltinDefaults } from '../lib/env';
import { loadEnvFiles } from './lib/load-env';
import {
  deepSeekProviderBaseUrl,
  isDeepSeekConfigured,
} from '../lib/ai/deepseek';
import { NodeSnapfillApi } from './lib/api-node';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
loadEnvFiles(ROOT);

const envDefaults = getEnvBuiltinDefaults();
const FORMS_DIR = join(ROOT, 'fixtures/forms');
const DEFAULT_KB = join(ROOT, 'fixtures/form_fields/visa_customs/kb.txt');

type Args = {
  fixture: string;
  agent: boolean;
  freshKb: boolean;
  kbPath?: string;
  kbId?: string;
  outDir: string;
  help: boolean;
};

function parseArgs(argv: string[]): Args {
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const get = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--')
      ? argv[i + 1]
      : undefined;
  };
  const valueOpts = new Set(['--kb', '--kb-id', '--out']);
  const targets: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      if (valueOpts.has(a)) i += 1;
      continue;
    }
    targets.push(a);
  }

  return {
    fixture: targets[0] || 'visa_customs',
    agent: flags.has('--agent'),
    freshKb: flags.has('--fresh-kb'),
    kbPath: get('--kb'),
    kbId: get('--kb-id'),
    outDir: resolve(get('--out') || join(ROOT, 'output/e2e')),
    help: flags.has('--help') || flags.has('-h'),
  };
}

function installDom(html: string, url: string) {
  const dom = new JSDOM(html, {
    url,
    contentType: 'text/html',
    pretendToBeVisual: true,
  });
  const w = dom.window;
  const g = globalThis as typeof globalThis & {
    window: Window & typeof globalThis;
    document: Document;
    HTMLElement: typeof HTMLElement;
    HTMLInputElement: typeof HTMLInputElement;
    HTMLTextAreaElement: typeof HTMLTextAreaElement;
    HTMLSelectElement: typeof HTMLSelectElement;
    HTMLTableCellElement: typeof HTMLTableCellElement;
    HTMLTableRowElement: typeof HTMLTableRowElement;
    CSS: typeof CSS;
    __SNAPFILL_CLI__?: boolean;
  };

  g.__SNAPFILL_CLI__ = true;
  Object.defineProperty(globalThis, 'window', {
    value: w,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, 'document', {
    value: w.document,
    configurable: true,
    writable: true,
  });
  g.HTMLElement = w.HTMLElement;
  g.HTMLInputElement = w.HTMLInputElement;
  g.HTMLTextAreaElement = w.HTMLTextAreaElement;
  g.HTMLSelectElement = w.HTMLSelectElement;
  g.HTMLTableCellElement = w.HTMLTableCellElement;
  g.HTMLTableRowElement = w.HTMLTableRowElement;
  g.CSS = w.CSS;

  return {
    dom,
    cleanup: () => {
      g.__SNAPFILL_CLI__ = false;
      w.close();
    },
  };
}

function readControlValue(locator: FieldLocator): string {
  const el = document.querySelector(locator.selector);
  if (!el) return '';
  if (el instanceof HTMLSelectElement) return el.value;
  if (el instanceof HTMLTextAreaElement) return el.value;
  if (el instanceof HTMLInputElement) {
    if (el.type === 'checkbox') return el.checked ? 'true' : '';
    if (el.type === 'radio') {
      const name = locator.name || el.name;
      const checked = document.querySelector<HTMLInputElement>(
        `input[type="radio"][name="${name}"]:checked`,
      );
      return checked?.value || '';
    }
    return el.value;
  }
  return (el.textContent || '').trim();
}

async function resolveKnowledgeIds(
  api: NodeSnapfillApi,
  args: Args,
): Promise<string[] | undefined> {
  if (args.kbId) return [args.kbId];

  if (args.freshKb || args.kbPath) {
    const kbPath = args.kbPath
      ? resolve(args.kbPath)
      : existsSync(DEFAULT_KB)
        ? DEFAULT_KB
        : null;
    if (!kbPath || !existsSync(kbPath)) {
      throw new Error(
        '需要 --kb <path> 或确保后端 visa_customs/kb.txt 存在（可用 --kb-id 复用已有知识库）',
      );
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const name = `snapfill_e2e_${stamp}.txt`;
    console.log(`\n=== 上传知识库 ${kbPath} → ${name} ===`);
    const { fileIds } = await api.uploadKnowledgeFile(kbPath, name);
    console.log(`✅ kb ids=${fileIds.join(',')}`);
    return fileIds;
  }

  const files = await api.listKnowledgeFiles('complete');
  if (files.length === 0) {
    console.log('⚠️ 无已完成知识库，尝试上传默认 kb…');
    if (!existsSync(DEFAULT_KB)) {
      throw new Error('无可用知识库，请传 --kb 或 --fresh-kb');
    }
    const { fileIds } = await api.uploadKnowledgeFile(
      DEFAULT_KB,
      `snapfill_e2e_${Date.now()}.txt`,
    );
    return fileIds;
  }
  console.log(`使用已有知识库 ${files.length} 个（省略 knowledge_file_ids=全部）`);
  return undefined; // 省略 = 全部
}

async function runDirectPipeline(opts: {
  api: NodeSnapfillApi;
  fields: FormFieldItem[];
  locators: FieldLocator[];
  pageContext: string;
  knowledgeFileIds?: string[];
}) {
  console.log('\n=== form-fields/fill ===');
  const data = await opts.api.fillFormFields({
    fields: opts.fields,
    knowledge_file_ids: opts.knowledgeFileIds,
    page_context: opts.pageContext,
    device_id: 'web-ext-e2e',
  });

  const nonEmpty = Object.entries(data.values).filter(([, v]) =>
    Boolean(v.value?.trim()),
  );
  console.log(
    `task=${data.task_id} 有值=${nonEmpty.length}/${opts.fields.length} unfilled=${data.unfilled.length}`,
  );
  for (const [id, v] of nonEmpty.slice(0, 8)) {
    console.log(`  · ${id} = ${JSON.stringify(v.value)} (${v.confidence})`);
  }

  console.log('\n=== applyFieldValuesToDom ===');
  const apply = applyFieldValuesToDom(opts.locators, data.values);
  console.log(
    `写入=${apply.filled.length} 跳过=${apply.skipped.length} 低置信=${apply.lowConfidence.length}`,
  );

  const verified = apply.filled.filter((id) => {
    const loc = opts.locators.find((l) => l.id === id);
    return loc ? Boolean(readControlValue(loc)) : false;
  });

  return { data, apply, verified, nonEmptyCount: nonEmpty.length };
}

async function runAgentPipeline(opts: {
  api: NodeSnapfillApi;
  knowledgeFileIds?: string[];
  pageHint: string;
}) {
  if (!isDeepSeekConfigured()) {
    throw new Error('未配置 WXT_DEEPSEEK_API_KEY（.env.local），无法跑 --agent');
  }

  let locators: FieldLocator[] = [];
  let lastFields: FormFieldItem[] = [];
  let lastPageContext = opts.pageHint;
  let lastApply: ReturnType<typeof applyFieldValuesToDom> | undefined;
  let lastFillNonEmpty = 0;

  const deepseek = createDeepSeek({
    apiKey: envDefaults.deepSeekApiKey,
    baseURL: deepSeekProviderBaseUrl(envDefaults.deepSeekBaseUrl),
  });

  const tools = {
    extractPageFields: tool({
      description: '抽取当前页表单字段',
      inputSchema: z.object({
        note: z.string().optional(),
      }),
      execute: async ({ note }) => {
        const scan = scanDocument();
        const mapped = candidatesToApiFields(scan.candidates);
        locators = mapped.locators;
        lastFields = mapped.fields.slice(0, 80);
        lastPageContext =
          (note ? `${note} · ` : '') + buildPageContext(scan.meta);
        return {
          fieldCount: lastFields.length,
          page_context: lastPageContext,
          fields: lastFields,
        };
      },
    }),
    listKnowledgeFiles: tool({
      description: '列出已完成知识库',
      inputSchema: z.object({}),
      execute: async () => {
        const files = await opts.api.listKnowledgeFiles('complete');
        return {
          count: files.length,
          files: files.slice(0, 10).map((f) => ({
            id: f.id,
            filename: f.filename,
          })),
        };
      },
    }),
    fillFormFields: tool({
      description: '调用后端填值',
      inputSchema: z.object({
        page_context: z.string().optional(),
        knowledge_file_ids: z.array(z.string()).optional(),
      }),
      execute: async (input) => {
        const fields = lastFields;
        if (!fields.length) throw new Error('请先 extractPageFields');
        const data = await opts.api.fillFormFields({
          fields,
          knowledge_file_ids:
            input.knowledge_file_ids ?? opts.knowledgeFileIds,
          page_context: input.page_context ?? lastPageContext,
          device_id: 'web-ext-e2e-agent',
        });
        lastFillNonEmpty = Object.values(data.values).filter((v) =>
          Boolean(v.value?.trim()),
        ).length;
        return {
          task_id: data.task_id,
          filledCount: lastFillNonEmpty,
          unfilled: data.unfilled,
          values: data.values,
        };
      },
    }),
    applyFieldValues: tool({
      description: '写回 DOM',
      inputSchema: z.object({
        values: z.record(
          z.string(),
          z.object({
            value: z.string(),
            confidence: z.enum(['high', 'medium', 'low']).optional(),
          }),
        ),
      }),
      execute: async ({ values }) => {
        const normalized: Record<string, FormFieldValue> = {};
        for (const [id, v] of Object.entries(values)) {
          normalized[id] = {
            value: v.value,
            confidence: v.confidence ?? 'medium',
            sources: [],
          };
        }
        lastApply = applyFieldValuesToDom(locators, normalized);
        return {
          filledCount: lastApply.filled.length,
          filled: lastApply.filled,
          skipped: lastApply.skipped,
        };
      },
    }),
  };

  const agent = new ToolLoopAgent({
    model: deepseek(envDefaults.deepSeekModel),
    instructions: `你是 Snapfill 填表 Agent。必须调用工具：extractPageFields → fillFormFields → applyFieldValues。不要编造值。完成后中文短汇报。`,
    tools,
    stopWhen: isStepCount(10),
    temperature: 0.1,
  });

  console.log(`\n=== ToolLoopAgent (${envDefaults.deepSeekModel}) ===`);
  const result = await agent.generate({
    prompt: `请填写当前签证/申报表单。page_hint=${opts.pageHint}`,
    timeout: { totalMs: Math.max(envDefaults.deepSeekTimeoutMs ?? 180_000, 180_000) },
  });

  console.log(`steps=${result.steps.length}`);
  console.log(`text=${(result.text || '').slice(0, 400)}`);

  return {
    text: result.text || '',
    steps: result.steps.length,
    apply: lastApply,
    nonEmptyCount: lastFillNonEmpty,
    fieldCount: lastFields.length,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(`Usage: pnpm e2e [fixture] [--agent] [--fresh-kb] [--kb path] [--kb-id id] [--out dir]`);
    process.exit(0);
  }

  const stem = args.fixture.replace(/\.html$/, '');
  const htmlPath = join(FORMS_DIR, `${stem}.html`);
  if (!existsSync(htmlPath)) {
    throw new Error(`找不到 fixture: ${htmlPath}`);
  }

  mkdirSync(args.outDir, { recursive: true });
  const html = readFileSync(htmlPath, 'utf8');
  const url = `http://127.0.0.1:4173/${stem}.html`;

  console.log(`Snapfill E2E · fixture=${stem}`);
  console.log(`API ${envDefaults.apiBaseUrl} · agent=${args.agent}`);

  const api = new NodeSnapfillApi({
    apiBaseUrl: envDefaults.apiBaseUrl,
    username: envDefaults.defaultUsername,
    password: envDefaults.defaultPassword,
    timeoutMs: envDefaults.apiTimeoutMs,
  });

  console.log('\n=== 1. login ===');
  await api.login();
  console.log('✅ login ok');

  const knowledgeFileIds = await resolveKnowledgeIds(api, args);

  const { cleanup } = installDom(html, url);
  try {
    console.log('\n=== 2. extractPageFields (JSDOM) ===');
    const scan = scanDocument();
    const { fields, locators } = candidatesToApiFields(scan.candidates);
    const pageContext = buildPageContext(scan.meta);
    console.log(
      `candidates=${scan.candidates.length} apiFields=${fields.length} noise=${scan.noiseSkipped.count}`,
    );
    console.log(`page_context=${pageContext}`);
    if (fields.length === 0) throw new Error('未抽取到字段');

    writeFileSync(
      join(args.outDir, `${stem}.fields.json`),
      JSON.stringify({ pageContext, fields }, null, 2),
    );

    let summary: Record<string, unknown>;

    if (args.agent) {
      const agentResult = await runAgentPipeline({
        api,
        knowledgeFileIds,
        pageHint: pageContext,
      });
      summary = {
        mode: 'agent',
        fieldCount: agentResult.fieldCount,
        nonEmptyCount: agentResult.nonEmptyCount,
        applied: agentResult.apply?.filled.length ?? 0,
        steps: agentResult.steps,
        text: agentResult.text,
      };
      if ((agentResult.apply?.filled.length ?? 0) < 1 && agentResult.nonEmptyCount < 1) {
        throw new Error('Agent 未产生有效填值/写回');
      }
    } else {
      const direct = await runDirectPipeline({
        api,
        fields,
        locators,
        pageContext,
        knowledgeFileIds,
      });
      summary = {
        mode: 'direct',
        fieldCount: fields.length,
        nonEmptyCount: direct.nonEmptyCount,
        applied: direct.apply.filled.length,
        verified: direct.verified.length,
        taskId: direct.data.task_id,
        unfilled: direct.data.unfilled,
        sample: Object.fromEntries(
          Object.entries(direct.data.values)
            .filter(([, v]) => v.value?.trim())
            .slice(0, 12),
        ),
      };
      if (direct.apply.filled.length < 1) {
        throw new Error(
          `回填 0 字段（后端有值 ${direct.nonEmptyCount}）。可试 --fresh-kb 上传签证 KB`,
        );
      }
    }

    const outPath = join(args.outDir, `${stem}.result.json`);
    writeFileSync(outPath, JSON.stringify(summary, null, 2));
    console.log(`\n✅ E2E 通过 → ${outPath}`);
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    cleanup();
  }
}

main().catch((e) => {
  console.error('\n❌ E2E 失败:', e instanceof Error ? e.message : e);
  process.exit(1);
});
