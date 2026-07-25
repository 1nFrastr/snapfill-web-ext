import type { AppSettings } from '@/lib/settings/types';
import {
  ALLOWED_API_BASE_URLS,
  ALLOWED_DEEPSEEK_BASE_URLS,
  isAllowedApiBaseUrl,
  isAllowedDeepSeekBaseUrl,
  normalizeApiBaseUrl,
  normalizeDeepSeekBaseUrl,
} from '@/lib/settings/allowlist';

/** 打包时必须清空的凭证类变量（与 wxt.config define 对齐） */
export const SECRET_ENV_KEYS = [
  'WXT_DEEPSEEK_API_KEY',
  'WXT_API_DEFAULT_USERNAME',
  'WXT_API_DEFAULT_PASSWORD',
] as const;

type MetaEnv = Record<string, string | boolean | undefined>;

function metaEnv(): MetaEnv {
  try {
    return (import.meta as ImportMeta & { env?: MetaEnv }).env ?? {};
  } catch {
    return {};
  }
}

function fromProcess(key: string): string {
  try {
    if (typeof process !== 'undefined' && process.env?.[key] != null) {
      return String(process.env[key]);
    }
  } catch {
    // ignore
  }
  return '';
}

function raw(key: string): string {
  const v = metaEnv()[key];
  if (typeof v === 'string' && v.length > 0) return v;
  return fromProcess(key);
}

/** 扩展 production 构建不读密钥；CLI / dev 可读 */
function allowSecrets(): boolean {
  return metaEnv().PROD !== true;
}

function secret(key: string): string {
  if (!allowSecrets()) return '';
  return raw(key).trim();
}

function plain(key: string, fallback = ''): string {
  const v = raw(key).trim();
  return v || fallback;
}

function intEnv(key: string, fallback: number): number {
  const n = Number(plain(key));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** 从 .env.local（dev）或安全默认值构造内置设置 */
export function getEnvBuiltinDefaults(): AppSettings {
  let apiBaseUrl = normalizeApiBaseUrl(
    plain('WXT_API_BASE_URL', ALLOWED_API_BASE_URLS[0].value),
  );
  if (!isAllowedApiBaseUrl(apiBaseUrl)) {
    apiBaseUrl = ALLOWED_API_BASE_URLS[0].value;
  }

  let deepSeekBaseUrl = normalizeDeepSeekBaseUrl(
    plain(
      'WXT_DEEPSEEK_BASE_URL',
      ALLOWED_DEEPSEEK_BASE_URLS[0].value,
    ),
  );
  if (!isAllowedDeepSeekBaseUrl(deepSeekBaseUrl)) {
    deepSeekBaseUrl = ALLOWED_DEEPSEEK_BASE_URLS[0].value;
  }

  return {
    deepSeekApiKey: secret('WXT_DEEPSEEK_API_KEY'),
    deepSeekBaseUrl,
    deepSeekModel: plain('WXT_DEEPSEEK_MODEL', 'deepseek-v4-flash'),
    deepSeekTimeoutMs: intEnv('WXT_DEEPSEEK_TIMEOUT_MS', 180_000),
    apiBaseUrl,
    apiTimeoutMs: intEnv('WXT_API_TIMEOUT_MS', 120_000),
    defaultUsername: secret('WXT_API_DEFAULT_USERNAME'),
    defaultPassword: secret('WXT_API_DEFAULT_PASSWORD'),
    deviceIdPrefix: plain('WXT_DEVICE_ID_PREFIX', 'web-ext'),
  };
}
