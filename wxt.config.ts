import { defineConfig } from 'wxt';

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'Snapfill',
    description: '对话式表单填写助手',
    permissions: ['sidePanel'],
  },
});
