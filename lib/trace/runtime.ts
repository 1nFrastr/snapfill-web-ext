/**
 * 扩展运行时的产物通道：抓取 → 暂存 → 侧栏导出。
 *
 * 与 playwright harness 共用 `buildTrace` / `renderOverlay`，两边产物口径一致。
 * 截图口径也已对齐整页：`captureVisibleTab` 单次只能拍可视区，这里逐屏滚动多拍再拼接
 * （harness 走 playwright 的 fullPage，一次成图）。
 */

import { buildTrace, makeControlKey, type ControlRow } from '@/lib/formgraph/trace';
import type { FormGraph } from '@/lib/formgraph/types';
import { MessageType, type ScrollPageResponse } from '@/lib/messaging/types';
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
  /** 整页标注截图（dataURL）；抓取失败或过大时为 null */
  screenshot: string | null;
};

/** 存进 storage 的上限，避免单个产物撑爆 storage.local 配额 */
const MAX_SCREENSHOT_CHARS = 8_000_000;
/** 逐屏拍摄的张数上限，防止超长页把导出拖到分钟级 */
const MAX_TILES = 40;
/**
 * 两次 captureVisibleTab 之间的间隔。
 * MV3 对这个 API 有每秒调用配额，连拍会直接抛 quota 错误。
 */
const CAPTURE_INTERVAL_MS = 550;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

/** 内容所在 frame：字段最多的那个，滚动与拼图都以它的页面坐标为准 */
function busiestFrameId(graph: FormGraph): number {
  const count = new Map<number, number>();
  for (const f of graph.fields) count.set(f.frameId, (count.get(f.frameId) ?? 0) + 1);
  let best = 0;
  let max = -1;
  for (const [frameId, n] of count) {
    if (n > max) {
      max = n;
      best = frameId;
    }
  }
  return best;
}

async function captureTab(windowId: number): Promise<string> {
  try {
    return await browser.tabs.captureVisibleTab(windowId, { format: 'png' });
  } catch {
    // 撞上每秒配额时退避一次再试，避免整张长图因为一格失败而作废
    await sleep(CAPTURE_INTERVAL_MS * 2);
    return browser.tabs.captureVisibleTab(windowId, { format: 'png' });
  }
}

async function encode(canvas: OffscreenCanvas): Promise<string> {
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) {
    bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  }
  return `data:image/png;base64,${btoa(bin)}`;
}

/**
 * 逐屏滚动 + 拼接成整页标注图。
 *
 * `captureVisibleTab` 只给可视区，所以只能多拍再拼。两个关键点：
 * - 按**实际到达**的滚动位置排布（滚到底部时最后一屏与上一屏重叠），并且只画重叠之外的新增部分，
 *   否则 sticky 页头会在长图里重复出现一串；
 * - 编码后超出 storage 配额时整体降采样重编一次，而不是直接放弃截图。
 */
async function captureFullPage(tabId: number, graph: FormGraph): Promise<string | null> {
  const tab = await browser.tabs.get(tabId);
  const frameId = busiestFrameId(graph);
  const probe = await sendToFrame<ScrollPageResponse>(tabId, frameId, {
    type: MessageType.SCROLL_PAGE,
  });
  if (!probe.ok) throw new Error(probe.error);

  const { contentHeight, viewportHeight, viewportWidth, devicePixelRatio: dpr } = probe;
  const originalY = probe.scrollY;
  const step = Math.max(1, viewportHeight);
  const tiles = Math.min(MAX_TILES, Math.max(1, Math.ceil(contentHeight / step)));

  const canvas = new OffscreenCanvas(
    Math.round(viewportWidth * dpr),
    Math.round(Math.min(contentHeight, tiles * step) * dpr),
  );
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建 OffscreenCanvas 2d 上下文');

  let drawnBottom = 0;
  for (let i = 0; i < tiles; i += 1) {
    const at = await sendToFrame<ScrollPageResponse>(tabId, frameId, {
      type: MessageType.SCROLL_PAGE,
      y: i * step,
    });
    if (!at.ok) throw new Error(at.error);
    // 等一帧让 sticky/lazy 元素稳定，同时满足 captureVisibleTab 的调用间隔
    await sleep(CAPTURE_INTERVAL_MS);

    const bitmap = await createImageBitmap(dataUrlToBlob(await captureTab(tab.windowId)));
    const top = at.scrollY * dpr;
    // 与已画区域重叠的部分跳过：重叠里可能是重复的 sticky 页头
    const skip = Math.max(0, drawnBottom - top);
    if (skip < bitmap.height) {
      ctx.drawImage(
        bitmap,
        0,
        skip,
        bitmap.width,
        bitmap.height - skip,
        0,
        top + skip,
        bitmap.width,
        bitmap.height - skip,
      );
      drawnBottom = top + bitmap.height;
    }
    bitmap.close();
    if (drawnBottom >= canvas.height) break;
  }

  await sendToFrame(tabId, frameId, { type: MessageType.SCROLL_PAGE, y: originalY }).catch(
    () => undefined,
  );

  let out = await encode(canvas);
  if (out.length > MAX_SCREENSHOT_CHARS) {
    const scaled = new OffscreenCanvas(Math.round(canvas.width / dpr), Math.round(canvas.height / dpr));
    scaled.getContext('2d')?.drawImage(canvas, 0, 0, scaled.width, scaled.height);
    out = await encode(scaled);
    slog('trace', `整页截图降采样到 ${scaled.width}x${scaled.height} 以适配 storage 配额`);
  }
  slog('trace', `整页截图 ${canvas.width}x${canvas.height} tiles=${tiles}`);
  return out.length > MAX_SCREENSHOT_CHARS ? null : out;
}

/** 画标注 → 逐屏拍摄拼整页 → 组装三件套写入 storage，供侧栏导出 */
export async function captureTrace(tabId: number, graph: FormGraph, pageContext = ''): Promise<StoredTrace> {
  const trace = buildTrace(graph, pageContext);

  let screenshot: string | null = null;
  try {
    screenshot = await withOverlay(tabId, graph, async () => {
      try {
        return await captureFullPage(tabId, graph);
      } catch (e) {
        // 整页拼接依赖滚动与 OffscreenCanvas，失败时退回单屏，别让截图整个丢掉
        swarn('trace', `整页拼接失败，退回可视区截图: ${e instanceof Error ? e.message : String(e)}`);
        const tab = await browser.tabs.get(tabId);
        return browser.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
      }
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
