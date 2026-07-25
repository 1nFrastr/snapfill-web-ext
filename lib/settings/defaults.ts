import { deepSeekConfig } from '@/lib/ai/config';
import { apiConfig } from '@/lib/api/config';
import type { AppSettings } from '@/lib/settings/types';

/** 内置默认值（来自 lib/ai|api/config.ts；重置时回到这里） */
export function getBuiltinDefaults(): AppSettings {
  return {
    deepSeekApiKey: deepSeekConfig.apiKey,
    deepSeekBaseUrl: deepSeekConfig.baseUrl,
    deepSeekModel: deepSeekConfig.model,
    deepSeekTimeoutMs: deepSeekConfig.timeoutMs ?? 180_000,
    apiBaseUrl: apiConfig.apiBaseUrl,
    apiTimeoutMs: apiConfig.timeoutMs ?? 120_000,
    defaultUsername: apiConfig.username,
    defaultPassword: apiConfig.password,
    deviceIdPrefix: apiConfig.deviceIdPrefix ?? 'web-ext',
  };
}
