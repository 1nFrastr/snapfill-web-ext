import { deepSeekConfig } from '@/lib/ai/config';

/** 从完整 chat/completions URL 得到 provider baseURL（默认 https://api.deepseek.com） */
export function deepSeekProviderBaseUrl(chatUrl = deepSeekConfig.baseUrl): string {
  try {
    const u = new URL(chatUrl);
    // https://api.deepseek.com/v1/chat/completions → https://api.deepseek.com
    const path = u.pathname.replace(/\/v1\/chat\/completions\/?$/, '').replace(/\/$/, '');
    return `${u.origin}${path}` || 'https://api.deepseek.com';
  } catch {
    return 'https://api.deepseek.com';
  }
}

export function isDeepSeekConfigured(): boolean {
  return Boolean(
    deepSeekConfig.apiKey &&
      !deepSeekConfig.apiKey.includes('REPLACE_WITH_YOUR'),
  );
}
