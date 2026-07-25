/**
 * 可配置的 DeepSeek / 后端 Base URL 白名单。
 * 新增环境时：先加这里，再同步 wxt.config.ts 的 host_permissions。
 */

export type AllowlistOption = {
  label: string;
  value: string;
};

/** 后端 API Base URL（无尾斜杠） */
export const ALLOWED_API_BASE_URLS: readonly AllowlistOption[] = [
  { label: '本地 · 127.0.0.1:8008', value: 'http://127.0.0.1:8008' },
  { label: '本地 · localhost:8008', value: 'http://localhost:8008' },
  {
    label: 'Staging · staging.gosnapfill.cn',
    value: 'https://staging.gosnapfill.cn/api',
  },
] as const;

/** DeepSeek chat completions 完整 URL */
export const ALLOWED_DEEPSEEK_BASE_URLS: readonly AllowlistOption[] = [
  {
    label: 'DeepSeek 官方',
    value: 'https://api.deepseek.com/v1/chat/completions',
  },
] as const;

export function normalizeApiBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

export function normalizeDeepSeekBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

export function isAllowedApiBaseUrl(url: string): boolean {
  const n = normalizeApiBaseUrl(url);
  return ALLOWED_API_BASE_URLS.some((o) => o.value === n);
}

export function isAllowedDeepSeekBaseUrl(url: string): boolean {
  const n = normalizeDeepSeekBaseUrl(url);
  return ALLOWED_DEEPSEEK_BASE_URLS.some((o) => o.value === n);
}

export function assertAllowedEndpoints(input: {
  apiBaseUrl: string;
  deepSeekBaseUrl: string;
}): { apiBaseUrl: string; deepSeekBaseUrl: string } {
  const apiBaseUrl = normalizeApiBaseUrl(input.apiBaseUrl);
  const deepSeekBaseUrl = normalizeDeepSeekBaseUrl(input.deepSeekBaseUrl);

  if (!isAllowedApiBaseUrl(apiBaseUrl)) {
    throw new Error(
      `后端 API Base URL 不在白名单：${apiBaseUrl}。请从设置下拉中选择。`,
    );
  }
  if (!isAllowedDeepSeekBaseUrl(deepSeekBaseUrl)) {
    throw new Error(
      `DeepSeek Base URL 不在白名单：${deepSeekBaseUrl}。请从设置下拉中选择。`,
    );
  }
  return { apiBaseUrl, deepSeekBaseUrl };
}

/** 写入 manifest host_permissions 时用（不含页面注入用的 <all_urls>） */
export function allowlistHostPermissions(): string[] {
  const origins = new Set<string>();
  for (const o of ALLOWED_API_BASE_URLS) {
    try {
      const u = new URL(o.value);
      origins.add(`${u.origin}/*`);
    } catch {
      // skip
    }
  }
  for (const o of ALLOWED_DEEPSEEK_BASE_URLS) {
    try {
      const u = new URL(o.value);
      origins.add(`${u.origin}/*`);
    } catch {
      // skip
    }
  }
  return Array.from(origins);
}
