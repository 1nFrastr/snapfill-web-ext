import {
  getSettings,
  isDeepSeekKeyConfigured,
} from '@/lib/settings/store';

/** 从完整 chat/completions URL 得到 provider baseURL（默认 https://api.deepseek.com） */
export function deepSeekProviderBaseUrl(
  chatUrl = getSettings().deepSeekBaseUrl,
): string {
  try {
    const u = new URL(chatUrl);
    const path = u.pathname
      .replace(/\/v1\/chat\/completions\/?$/, '')
      .replace(/\/$/, '');
    return `${u.origin}${path}` || 'https://api.deepseek.com';
  } catch {
    return 'https://api.deepseek.com';
  }
}

export function isDeepSeekConfigured(): boolean {
  return isDeepSeekKeyConfigured();
}

export function getDeepSeekRuntime() {
  const s = getSettings();
  return {
    apiKey: s.deepSeekApiKey,
    baseUrl: s.deepSeekBaseUrl,
    model: s.deepSeekModel,
    timeoutMs: s.deepSeekTimeoutMs,
  };
}
