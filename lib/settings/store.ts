import { getBuiltinDefaults } from '@/lib/settings/defaults';
import {
  ALLOWED_API_BASE_URLS,
  ALLOWED_DEEPSEEK_BASE_URLS,
  assertAllowedEndpoints,
  isAllowedApiBaseUrl,
  isAllowedDeepSeekBaseUrl,
  normalizeApiBaseUrl,
  normalizeDeepSeekBaseUrl,
} from '@/lib/settings/allowlist';
import {
  SETTINGS_STORAGE_KEY,
  type AppSettings,
} from '@/lib/settings/types';
import { slog, swarn } from '@/lib/log';

let cache: AppSettings | null = null;
let loadPromise: Promise<AppSettings> | null = null;
let listening = false;

function isRecord(v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

function fallbackApiBaseUrl(): string {
  const d = normalizeApiBaseUrl(getBuiltinDefaults().apiBaseUrl);
  return isAllowedApiBaseUrl(d) ? d : ALLOWED_API_BASE_URLS[0].value;
}

function fallbackDeepSeekBaseUrl(): string {
  const d = normalizeDeepSeekBaseUrl(getBuiltinDefaults().deepSeekBaseUrl);
  return isAllowedDeepSeekBaseUrl(d) ? d : ALLOWED_DEEPSEEK_BASE_URLS[0].value;
}

/** 把不在白名单的 URL 打回安全值，避免脏 storage */
function sanitizeEndpoints(settings: AppSettings): AppSettings {
  let apiBaseUrl = normalizeApiBaseUrl(settings.apiBaseUrl);
  let deepSeekBaseUrl = normalizeDeepSeekBaseUrl(settings.deepSeekBaseUrl);

  if (!isAllowedApiBaseUrl(apiBaseUrl)) {
    swarn('settings', `apiBaseUrl 不在白名单，回退: ${apiBaseUrl}`);
    apiBaseUrl = fallbackApiBaseUrl();
  }
  if (!isAllowedDeepSeekBaseUrl(deepSeekBaseUrl)) {
    swarn(
      'settings',
      `deepSeekBaseUrl 不在白名单，回退: ${deepSeekBaseUrl}`,
    );
    deepSeekBaseUrl = fallbackDeepSeekBaseUrl();
  }

  return { ...settings, apiBaseUrl, deepSeekBaseUrl };
}

function mergeSettings(
  base: AppSettings,
  patch: Partial<AppSettings> | Record<string, unknown> | null | undefined,
): AppSettings {
  if (!isRecord(patch)) return sanitizeEndpoints({ ...base });
  const next = { ...base };
  for (const key of Object.keys(base) as (keyof AppSettings)[]) {
    const v = patch[key];
    if (v === undefined || v === null) continue;
    if (typeof base[key] === 'number') {
      const n = typeof v === 'number' ? v : Number(v);
      if (Number.isFinite(n) && n > 0) (next[key] as number) = n;
    } else if (typeof v === 'string') {
      (next[key] as string) = v;
    }
  }
  return sanitizeEndpoints(next);
}

function ensureListener() {
  if (listening) return;
  listening = true;
  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[SETTINGS_STORAGE_KEY]) return;
    const next = changes[SETTINGS_STORAGE_KEY].newValue;
    cache = mergeSettings(getBuiltinDefaults(), next as Partial<AppSettings>);
    slog('settings', 'storage 变更，已刷新内存缓存');
  });
}

/** 加载设置（storage 覆盖内置默认）；结果缓存在内存供 sync 读取 */
export async function ensureSettingsLoaded(): Promise<AppSettings> {
  ensureListener();
  if (cache) return cache;
  if (!loadPromise) {
    loadPromise = (async () => {
      const defaults = getBuiltinDefaults();
      try {
        const stored = await browser.storage.local.get(SETTINGS_STORAGE_KEY);
        const raw = stored[SETTINGS_STORAGE_KEY];
        cache = mergeSettings(defaults, raw as Partial<AppSettings>);
      } catch (e) {
        slog('settings', `读取 storage 失败，用内置默认: ${e}`);
        cache = sanitizeEndpoints(defaults);
      }
      return cache;
    })().finally(() => {
      loadPromise = null;
    });
  }
  return loadPromise;
}

/** 须先 ensureSettingsLoaded；未加载时退回内置默认 */
export function getSettings(): AppSettings {
  return cache ?? sanitizeEndpoints(getBuiltinDefaults());
}

export async function saveSettings(
  patch: Partial<AppSettings>,
): Promise<AppSettings> {
  ensureListener();
  const current = await ensureSettingsLoaded();
  const merged = mergeSettings(current, patch);
  const endpoints = assertAllowedEndpoints({
    apiBaseUrl: merged.apiBaseUrl,
    deepSeekBaseUrl: merged.deepSeekBaseUrl,
  });
  const next: AppSettings = { ...merged, ...endpoints };
  await browser.storage.local.set({ [SETTINGS_STORAGE_KEY]: next });
  cache = next;
  slog('settings', '已保存设置到 storage.local');
  return next;
}

/** 清除用户覆盖，恢复 config.ts 内置默认 */
export async function resetSettings(): Promise<AppSettings> {
  ensureListener();
  await browser.storage.local.remove(SETTINGS_STORAGE_KEY);
  cache = sanitizeEndpoints(getBuiltinDefaults());
  slog('settings', '已重置为内置默认');
  return cache;
}

export function isDeepSeekKeyConfigured(settings = getSettings()): boolean {
  const key = settings.deepSeekApiKey?.trim() ?? '';
  return Boolean(key) && !key.includes('REPLACE_WITH_YOUR');
}
