import { scanDocument } from '@/lib/parser/scan';
import { applyFieldValuesToDom } from '@/lib/fill/apply';
import {
  MessageType,
  type FillDomRequest,
  type ExtensionRequest,
} from '@/lib/messaging/types';
import { elapsed, slog, serror } from '@/lib/log';

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',
  main() {
    slog('content', `content script 已注入 url=${location.href}`);

    browser.runtime.onMessage.addListener((message: ExtensionRequest) => {
      if (message?.type === MessageType.SCAN_DOM) {
        const started = Date.now();
        slog('content', '收到 SCAN_DOM，开始 scanDocument()');
        try {
          const scan = scanDocument();
          slog(
            'content',
            `scanDocument 完成 candidates=${scan.candidates.length} noise=${scan.noiseSkipped.count} ${elapsed(started)}`,
          );
          return Promise.resolve({ ok: true as const, scan });
        } catch (e) {
          serror('content', `scanDocument 异常 ${elapsed(started)}`, e);
          return Promise.resolve({
            ok: false as const,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }

      if (message?.type === MessageType.FILL_DOM) {
        const started = Date.now();
        const req = message as FillDomRequest;
        slog(
          'content',
          `收到 FILL_DOM locators=${req.locators.length} values=${Object.keys(req.values).length}`,
        );
        try {
          const result = applyFieldValuesToDom(req.locators, req.values);
          slog(
            'content',
            `FILL_DOM 完成 filled=${result.filled.length} skipped=${result.skipped.length} ${elapsed(started)}`,
          );
          return Promise.resolve({ ok: true as const, result });
        } catch (e) {
          serror('content', `FILL_DOM 异常 ${elapsed(started)}`, e);
          return Promise.resolve({
            ok: false as const,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }

      return;
    });
  },
});
