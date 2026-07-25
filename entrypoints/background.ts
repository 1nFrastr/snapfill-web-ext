import {
  AGENT_PORT,
  type AgentPortClientMessage,
  type AgentStreamEvent,
} from '@/lib/messaging/types';
import { streamSnapfillAgent } from '@/lib/agent/snapfill-agent';
import { elapsed, serror, slog } from '@/lib/log';

async function getActiveTabId(explicit?: number): Promise<number> {
  if (explicit != null) return explicit;
  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  const id = tabs[0]?.id;
  if (id == null) throw new Error('没有活动标签页');
  return id;
}

async function assertInjectableTab(tabId: number) {
  const tab = await browser.tabs.get(tabId);
  slog('bg', `活动标签 tab=${tabId} url=${tab.url ?? '(none)'}`);
  if (
    tab.url?.startsWith('chrome://') ||
    tab.url?.startsWith('chrome-extension://') ||
    tab.url?.startsWith('about:')
  ) {
    throw new Error('当前页面无法注入脚本，请打开普通网页或 fixtures 测试页');
  }
  return tab;
}

function post(
  port: ReturnType<typeof browser.runtime.connect>,
  event: AgentStreamEvent,
) {
  try {
    port.postMessage(event);
  } catch {
    // port 已断开
  }
}

export default defineBackground(() => {
  slog('bg', 'background 已启动。流式 ToolLoopAgent 经 Port 推送到侧栏。');

  browser.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((error) => serror('bg', 'sidePanel.setPanelBehavior 失败', error));

  browser.runtime.onConnect.addListener((port) => {
    if (port.name !== AGENT_PORT) return;

    let abort: AbortController | null = null;

    port.onDisconnect.addListener(() => {
      abort?.abort();
      abort = null;
    });

    port.onMessage.addListener((raw: AgentPortClientMessage) => {
      void (async () => {
        if (raw.type === 'abort') {
          abort?.abort();
          abort = null;
          return;
        }
        if (raw.type !== 'start') return;

        abort?.abort();
        abort = new AbortController();
        const signal = abort.signal;
        const started = Date.now();

        try {
          const tabId = await getActiveTabId(raw.tabId);
          await assertInjectableTab(tabId);
          slog('bg', `Agent 流式开始 tab=${tabId}`);

          await streamSnapfillAgent({
            tabId,
            prompt: raw.prompt,
            knowledgeFileIds: raw.knowledgeFileIds,
            abortSignal: signal,
            onEvent: (event) => post(port, event),
          });

          slog('bg', `Agent 流式完成 ${elapsed(started)}`);
        } catch (e) {
          if (signal.aborted) {
            post(port, { type: 'error', error: '已取消' });
            return;
          }
          serror('bg', `Agent 流式失败 ${elapsed(started)}`, e);
          post(port, {
            type: 'error',
            error: e instanceof Error ? e.message : String(e),
          });
        } finally {
          if (abort?.signal === signal) abort = null;
        }
      })();
    });
  });
});
