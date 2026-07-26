/**
 * 扩展运行时的产物通道：抓取 → 暂存 → 侧栏导出。
 *
 * 与 playwright harness 共用 `buildTrace` / `renderOverlay`，两边产物口径一致；
 * 差别只在截图能力：captureVisibleTab 只能拍可视区，整页标注图请用 harness（pnpm trace）。
 */

import { buildTrace, makeControlKey, type ControlRow } from '@/lib/formgraph/trace';
import type { FormGraph } from '@/lib/formgraph/types';
import { MessageType } from '@/lib/messaging/types';
import { sendToFrame } from '@/lib/messaging/send';
import { slog, swarn } from '@/lib/log';

export const TRACE_STORAGE_KEY = 'snapfill:trace:last';

export type StoredTrace = {
  capturedAt: string;
  pageContext: string;
  formGraph: FormGraph;
  controls: ControlRow[];
  markdown: string;
  summary: string[];
  /** 可视区标注截图（dataURL）；抓取失败或过大时为 null */
  screenshot: string | null;
};

/** 存进 storage 的上限，避免单个产物撑爆 storage.local 配额 */
const MAX_SCREENSHOT_CHARS = 4_000_000;

async function withOverlay<T>(
  tabId: number,
  graph: FormGraph,
  fn: () => Promise<T>,
): Promise<T> {
  const keyOf = makeControlKey(graph);
  const numbersByFrame = new Map<number, Record<string, string>>();
  for (const f of graph.fields) {
    const numbers = numbersByFrame.get(f.frameId) ?? {};
    numbers[f.fieldId] = keyOf(f);
    numbersByFrame.set(f.frameId, numbers);
  }

  const frameIds = [...numbersByFrame.keys()];
  try {
    for (const frameId of frameIds) {
      await sendToFrame(tabId, frameId, {
        type: MessageType.RENDER_OVERLAY,
        numbers: numbersByFrame.get(frameId)!,
      }).catch(() => undefined);
    }
    return await fn();
  } finally {
    for (const frameId of frameIds) {
      await sendToFrame(tabId, frameId, { type: MessageType.CLEAR_OVERLAY }).catch(() => undefined);
    }
  }
}

/** 画标注 → 截可视区 → 组装三件套写入 storage，供侧栏导出 */
export async function captureTrace(tabId: number, graph: FormGraph, pageContext = ''): Promise<StoredTrace> {
  const trace = buildTrace(graph, pageContext);

  let screenshot: string | null = null;
  try {
    screenshot = await withOverlay(tabId, graph, async () => {
      const tab = await browser.tabs.get(tabId);
      return browser.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    });
    if (screenshot && screenshot.length > MAX_SCREENSHOT_CHARS) {
      swarn('trace', '标注截图过大，仅保留 JSON 与映射表');
      screenshot = null;
    }
  } catch (e) {
    swarn('trace', `标注截图失败（不影响 JSON/映射表）: ${e instanceof Error ? e.message : String(e)}`);
  }

  const stored: StoredTrace = {
    capturedAt: new Date().toISOString(),
    pageContext,
    formGraph: trace.formGraph,
    controls: trace.controls,
    markdown: trace.markdown,
    summary: trace.summary,
    screenshot,
  };

  await browser.storage.local.set({ [TRACE_STORAGE_KEY]: stored });
  slog('trace', `产物已暂存 controls=${stored.controls.length} screenshot=${screenshot ? 'yes' : 'no'}`);
  return stored;
}

export async function readTrace(): Promise<StoredTrace | null> {
  const got = await browser.storage.local.get(TRACE_STORAGE_KEY);
  return (got[TRACE_STORAGE_KEY] as StoredTrace | undefined) ?? null;
}

function download(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function dataUrlToBlob(dataUrl: string): Blob {
  const [head, b64] = dataUrl.split(',');
  const mime = /:(.*?);/.exec(head)?.[1] || 'image/png';
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

/** 侧栏导出：form_graph.json + controls.md + overlay.png（三件套同一时间戳前缀） */
export function downloadTrace(trace: StoredTrace): string[] {
  const stamp = trace.capturedAt.replace(/[:.]/g, '-');
  const written = [`snapfill-${stamp}-form_graph.json`, `snapfill-${stamp}-controls.md`];

  download(written[0], new Blob([JSON.stringify(trace.formGraph, null, 2)], { type: 'application/json' }));
  download(written[1], new Blob([trace.markdown], { type: 'text/markdown' }));
  if (trace.screenshot) {
    const png = `snapfill-${stamp}-overlay.png`;
    download(png, dataUrlToBlob(trace.screenshot));
    written.push(png);
  }
  return written;
}
