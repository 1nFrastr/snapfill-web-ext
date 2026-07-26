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
  type RevealAllResponse,
  type ScrollPageRequest,
  type ScrollPageResponse,
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

const countControls = () =>
  document.querySelectorAll('input:not([type="hidden"]),select,textarea,[contenteditable="true"]').length;

/**
 * 把本 frame 的页面坐标 `y` 滚到视口顶部，并回报拼整页截图所需的指标。
 *
 * 表单常在 iframe 里，而 iframe 未必自己有滚动条——内容被完全撑开、由祖先文档滚动。
 * 两种情况都要覆盖：自己能滚就滚自己，否则同源逐级上溯换算成顶层文档的偏移再滚顶层。
 * 回报的是**实际到达**的位置（滚到底会小于请求值），拼图必须按实际值排布，否则末尾会错位。
 */
function scrollPage(y?: number): ScrollPageResponse {
  try {
    const se = document.scrollingElement ?? document.documentElement;
    const selfScrolls = se.scrollHeight > se.clientHeight + 4;

    if (y != null) {
      if (selfScrolls) {
        se.scrollTop = y;
      } else {
        let win: Window = window;
        let offset = y;
        // 同源才能读 frameElement；跨域时退化成只滚自己（上面那一支）
        while (win.parent !== win && win.frameElement) {
          const rect = win.frameElement.getBoundingClientRect();
          offset += rect.top + win.parent.scrollY;
          win = win.parent;
        }
        win.scrollTo({ top: offset, behavior: 'instant' as ScrollBehavior });
      }
    }

    const viewport = selfScrolls ? se.clientHeight : window.innerHeight;
    return {
      ok: true as const,
      scrollY: selfScrolls ? se.scrollTop : window.scrollY || se.scrollTop,
      contentHeight: Math.max(se.scrollHeight, document.body?.scrollHeight ?? 0),
      viewportHeight: viewport,
      viewportWidth: selfScrolls ? se.clientWidth : window.innerWidth,
      devicePixelRatio: window.devicePixelRatio || 1,
      selfScrolls,
    };
  } catch (e) {
    return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * 滚过整页与所有内部滚动容器，把懒渲染/虚拟列表的内容逼出来。
 *
 * 抽取本身不要求控件在视口内（只要求有非零尺寸），所以这里唯一的目的是触发
 * IntersectionObserver 之类的延迟挂载。滚完恢复原位，避免影响后续截图与坐标。
 */
async function revealAll(): Promise<RevealAllResponse> {
  try {
    const controlsBefore = countControls();
    const containers = [
      document.scrollingElement ?? document.documentElement,
      ...[...document.querySelectorAll('*')].filter((el) => {
        const st = getComputedStyle(el);
        return (
          /auto|scroll/.test(st.overflowY) && el.scrollHeight > el.clientHeight + 200
        );
      }),
    ];

    for (const el of containers) {
      const original = el.scrollTop;
      const step = Math.max(el.clientHeight * 0.8, 200);
      for (let y = 0; y <= el.scrollHeight; y += step) {
        el.scrollTop = y;
        await new Promise((r) => setTimeout(r, 60));
      }
      el.scrollTop = original;
    }
    await new Promise((r) => setTimeout(r, 200));

    return {
      ok: true as const,
      controlsBefore,
      controlsAfter: countControls(),
      scrolledContainers: containers.length,
    };
  } catch (e) {
    return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
  }
}

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
              labelSource: f.labelSource,
              control: `${f.control.tag}:${f.control.type}`,
              required: f.required,
              readonly: f.readonly,
              existingValue: f.existingValue,
              rowIndex: f.rowIndex,
              columnKey: f.columnKey,
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

      if (message?.type === MessageType.REVEAL_ALL) {
        return revealAll();
      }

      if (message?.type === MessageType.SCROLL_PAGE) {
        const req = message as ScrollPageRequest;
        return Promise.resolve(scrollPage(req.y));
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
