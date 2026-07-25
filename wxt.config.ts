import { defineConfig } from 'wxt';
import { allowlistHostPermissions } from './lib/settings/allowlist';

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ['@wxt-dev/module-react', 'wxt-module-console-forward'],
  manifest: {
    name: 'Snapfill',
    description: '对话式表单填写助手',
    permissions: ['sidePanel', 'activeTab', 'scripting', 'storage', 'tabs'],
    host_permissions: [
      // 任意页抽 DOM / 知识库对象存储 PUT
      '<all_urls>',
      // 与 lib/settings/allowlist.ts 同步的 LLM / 后端 API
      ...allowlistHostPermissions(),
    ],
  },
  // 把 background / content / sidepanel 的 console 转到 `pnpm dev` 终端
  consoleForward: {
    enabled: true,
    levels: ['log', 'warn', 'error', 'info'],
    silentOnError: false,
    forwardErrors: true,
  },
});
