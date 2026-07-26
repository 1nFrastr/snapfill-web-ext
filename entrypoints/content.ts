import { applyFieldValuesToDom, verifyApplied } from '@/lib/fill/apply';
import { extractFormGraph } from '@/lib/formgraph/extract';
import { norm } from '@/lib/formgraph/dom-utils';
import { clearOverlay, renderOverlay, type OverlayTarget } from '@/lib/formgraph/overlay';
import {
  MessageType,
  type FillDomRequest,
  type ExtensionRequest,
  type SnapshotFormRequest,
  type DescribeRegionRequest,
  type ReadElementDetailRequest,
  type ActivateRequest,
  type OpenOptionsRequest,
  type WaitStableRequest,
  type VerifyAppliedRequest,
  type RenderOverlayRequest,
  type ElementDetail,
  type RegionFieldDetail,
} from '@/lib/messaging/types';
import type { FormGraphFragment } from '@/lib/formgraph/types';
import { elapsed, slog, serror } from '@/lib/log';

/** 最近一次 snapshotForm 的产出，供 describeRegion/readElementDetail/activate/openOptions 按 id 查回元素 */
let lastFragment: FormGraphFragment | null = null;
let lastRegistry: Map<string, Element> = new Map();

export default defineContentScript({
  matches: ['<all_urls>'],
  // 政务等站点表单常在 iframe；每个 frame 各自注入，由 background 按 frameId 定向消息
  allFrames: true,
  matchAboutBlank: true,
  runAt: 'document_idle',
  main() {
    slog(
      'content',
      `content script 已注入 url=${location.href} frame=${window === window.top ? 'top' : 'child'}`,
    );

    browser.runtime.onMessage.addListener((message: ExtensionRequest) => {
      if (message?.type === MessageType.SNAPSHOT_FORM) {
        const started = Date.now();
        const req = message as SnapshotFormRequest;
        slog('content', '收到 SNAPSHOT_FORM');
        try {
          const { fragment, registry } = extractFormGraph({ frameId: 0, maxFields: req.maxFields });
          lastFragment = fragment;
          lastRegistry = registry;
          slog(
            'content',
            `SNAPSHOT_FORM 完成 fields=${fragment.fields.length} regions=${fragment.regions.length} interactives=${fragment.interactives.length} ${elapsed(started)}`,
          );
          return Promise.resolve({ ok: true as const, fragment });
        } catch (e) {
          serror('content', `SNAPSHOT_FORM 异常 ${elapsed(started)}`, e);
          return Promise.resolve({ ok: false as const, error: e instanceof Error ? e.message : String(e) });
        }
      }

      if (message?.type === MessageType.DESCRIBE_REGION) {
        const req = message as DescribeRegionRequest;
        try {
          const region = lastFragment?.regions.find((r) => r.regionId === req.regionId);
          if (!region) throw new Error(`未找到 region ${req.regionId}，请先 snapshotForm`);
          const fields: RegionFieldDetail[] = (lastFragment?.fields ?? [])
            .filter((f) => region.fieldIds.includes(f.fieldId))
            .map((f) => ({
              fieldId: f.fieldId,
              label: f.label,
              control: `${f.control.tag}:${f.control.type}`,
              required: f.required,
              readonly: f.readonly,
              existingValue: f.existingValue,
              rect: f.rect,
            }));
          return Promise.resolve({
            ok: true as const,
            region: {
              regionId: region.regionId,
              kind: region.kind,
              name: region.name,
              chain: region.chain,
              fields,
              table: region.table ? { columns: region.table.columns } : undefined,
              repeat: region.repeat ? { rowCount: region.repeat.rowCount, addTargetLabel: region.repeat.addTargetLabel } : undefined,
            },
          });
        } catch (e) {
          return Promise.resolve({ ok: false as const, error: e instanceof Error ? e.message : String(e) });
        }
      }

      if (message?.type === MessageType.READ_ELEMENT_DETAIL) {
        const req = message as ReadElementDetailRequest;
        try {
          const el = lastRegistry.get(req.targetId);
          if (!el) throw new Error(`未找到元素 ${req.targetId}，请先 snapshotForm`);
          const st = el instanceof HTMLElement ? getComputedStyle(el) : null;
          const describedIds = (el.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean);
          const describedText = norm(
            describedIds.map((id) => document.getElementById(id)?.textContent).filter(Boolean).join(' '),
          );
          const detail: ElementDetail = {
            tag: el.tagName.toLowerCase(),
            visible: st ? st.display !== 'none' && st.visibility !== 'hidden' : false,
            display: st?.display ?? '',
            value:
              el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement
                ? el.value
                : norm(el.textContent) || null,
            checked: el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio') ? el.checked : null,
            ariaExpanded: el.getAttribute('aria-expanded'),
            disabled: (el as HTMLInputElement).disabled === true,
            readonly: (el as HTMLInputElement).readOnly === true,
            pattern: el.getAttribute('pattern'),
            min: el.getAttribute('min'),
            max: el.getAttribute('max'),
            step: el.getAttribute('step'),
            ariaDescribedByText: describedText || null,
            outerHtmlSnippet: (el.outerHTML || '').slice(0, 400),
          };
          return Promise.resolve({ ok: true as const, detail });
        } catch (e) {
          return Promise.resolve({ ok: false as const, error: e instanceof Error ? e.message : String(e) });
        }
      }

      if (message?.type === MessageType.ACTIVATE) {
        const req = message as ActivateRequest;
        try {
          const el = lastRegistry.get(req.targetId);
          if (!el) throw new Error(`未找到元素 ${req.targetId}，请先 snapshotForm`);
          const before = location.href;
          if (req.action === 'click') {
            (el as HTMLElement).scrollIntoView({ block: 'center' });
            (el as HTMLElement).click();
          } else if (req.action === 'focus') {
            (el as HTMLElement).focus?.();
          } else if (req.action === 'hover') {
            el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
            el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
          } else if (req.action === 'scrollIntoView') {
            (el as HTMLElement).scrollIntoView({ block: 'center' });
          } else if (req.action === 'check' || req.action === 'uncheck') {
            if (el instanceof HTMLInputElement) {
              el.checked = req.action === 'check';
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
            }
          }
          const urlChanged = location.href !== before;
          slog('content', `ACTIVATE ${req.action} target=${req.targetId} urlChanged=${urlChanged}`);
          return Promise.resolve({ ok: true as const, performed: req.action, urlChanged });
        } catch (e) {
          return Promise.resolve({ ok: false as const, error: e instanceof Error ? e.message : String(e) });
        }
      }

      if (message?.type === MessageType.OPEN_OPTIONS) {
        const req = message as OpenOptionsRequest;
        try {
          const el = lastRegistry.get(req.targetId);
          if (!el) throw new Error(`未找到元素 ${req.targetId}，请先 snapshotForm`);

          if (el instanceof HTMLSelectElement) {
            const options = [...el.options].map((o) => ({ label: norm(o.textContent) || o.value, value: o.value }));
            return Promise.resolve({ ok: true as const, options, method: 'native' as const });
          }

          (el as HTMLElement).click?.();
          return new Promise((resolve) => {
            setTimeout(() => {
              const optionEls = [
                ...document.querySelectorAll('[role="option"], .ant-select-item-option, .el-select-dropdown__item, [role="listbox"] li'),
              ].filter((n) => n instanceof HTMLElement && getComputedStyle(n).display !== 'none');
              const options = optionEls.slice(0, 60).map((n) => {
                const label = norm(n.textContent);
                return { label, value: n.getAttribute('data-value') || label };
              });
              document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
              resolve({
                ok: true as const,
                options,
                method: optionEls.length ? ('aria' as const) : ('heuristic' as const),
              });
            }, 180);
          });
        } catch (e) {
          return Promise.resolve({ ok: false as const, error: e instanceof Error ? e.message : String(e) });
        }
      }

      if (message?.type === MessageType.WAIT_STABLE) {
        const req = message as WaitStableRequest;
        const maxMs = req.maxMs ?? 3000;
        const quietMs = req.quietMs ?? 400;
        const started = Date.now();
        return new Promise((resolve) => {
          let mutationCount = 0;
          let quietTimer: ReturnType<typeof setTimeout>;
          const observer = new MutationObserver((mutations) => {
            mutationCount += mutations.length;
            clearTimeout(quietTimer);
            quietTimer = setTimeout(finish, quietMs);
          });
          const finish = () => {
            observer.disconnect();
            clearTimeout(maxTimer);
            resolve({ ok: true as const, waitedMs: Date.now() - started, mutationCount });
          };
          const maxTimer = setTimeout(finish, maxMs);
          quietTimer = setTimeout(finish, quietMs);
          observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
        });
      }

      if (message?.type === MessageType.VERIFY_APPLIED) {
        const req = message as VerifyAppliedRequest;
        try {
          const result = verifyApplied(req.locators, req.expected);
          return Promise.resolve({ ok: true as const, result });
        } catch (e) {
          return Promise.resolve({ ok: false as const, error: e instanceof Error ? e.message : String(e) });
        }
      }

      if (message?.type === MessageType.RENDER_OVERLAY) {
        const req = message as RenderOverlayRequest;
        try {
          const fields: OverlayTarget[] = [];
          for (const [fieldId, key] of Object.entries(req.numbers)) {
            const el = lastRegistry.get(fieldId);
            if (el) fields.push({ key, el });
          }
          const regions: OverlayTarget[] = (lastFragment?.regions ?? []).flatMap((r) => {
            const el = lastRegistry.get(r.regionId);
            return el ? [{ key: r.name || r.regionId, el }] : [];
          });
          const drawn = renderOverlay(fields, regions);
          slog('content', `RENDER_OVERLAY drawn=${drawn}/${Object.keys(req.numbers).length}`);
          return Promise.resolve({ ok: true as const, drawn });
        } catch (e) {
          return Promise.resolve({ ok: false as const, error: e instanceof Error ? e.message : String(e) });
        }
      }

      if (message?.type === MessageType.CLEAR_OVERLAY) {
        clearOverlay();
        return Promise.resolve({ ok: true as const });
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
