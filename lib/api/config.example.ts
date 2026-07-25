/**
 * 复制为 lib/api/config.ts（已 gitignore）并按本地环境调整。
 * 账号与后端 docs/FORM_FIELDS_FILL_API.md §0 一致，仅本机联调。
 */
export const apiConfig = {
  apiBaseUrl: 'http://127.0.0.1:8008',
  username: '19900000001',
  password: '123456',
  /** 单次 fill / 知识库请求超时（毫秒） */
  timeoutMs: 120_000,
  deviceIdPrefix: 'web-ext',
};
