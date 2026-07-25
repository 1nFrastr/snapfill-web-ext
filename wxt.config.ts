import { defineConfig } from 'wxt';

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ['@wxt-dev/module-react', 'wxt-module-console-forward'],
  manifest: {
    name: 'Snapfill',
    description: '对话式表单填写助手',
    permissions: ['sidePanel', 'activeTab', 'scripting', 'storage', 'tabs'],
    host_permissions: [
      '<all_urls>',
      'https://api.deepseek.com/*',
      'http://127.0.0.1:8008/*',
      'http://localhost:8008/*',
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
