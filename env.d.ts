/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly WXT_DEEPSEEK_API_KEY?: string;
  readonly WXT_DEEPSEEK_BASE_URL?: string;
  readonly WXT_DEEPSEEK_MODEL?: string;
  readonly WXT_DEEPSEEK_TIMEOUT_MS?: string;
  readonly WXT_API_BASE_URL?: string;
  readonly WXT_API_TIMEOUT_MS?: string;
  readonly WXT_API_DEFAULT_USERNAME?: string;
  readonly WXT_API_DEFAULT_PASSWORD?: string;
  readonly WXT_DEVICE_ID_PREFIX?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
