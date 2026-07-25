import { getEnvBuiltinDefaults } from '@/lib/env';
import type { AppSettings } from '@/lib/settings/types';

/** 内置默认值（dev 来自 .env.local；production 打包不含密钥） */
export function getBuiltinDefaults(): AppSettings {
  return getEnvBuiltinDefaults();
}
