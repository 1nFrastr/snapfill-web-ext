/** 侧栏可编辑并持久化到 browser.storage.local 的应用设置 */

export type AppSettings = {
  deepSeekApiKey: string;
  deepSeekBaseUrl: string;
  deepSeekModel: string;
  deepSeekTimeoutMs: number;
  apiBaseUrl: string;
  apiTimeoutMs: number;
  /** 登录表单预填 */
  defaultUsername: string;
  defaultPassword: string;
  deviceIdPrefix: string;
};

export const SETTINGS_STORAGE_KEY = 'snapfill:appSettings';
