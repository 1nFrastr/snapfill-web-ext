/**
 * 复制为 lib/ai/config.ts 并填入真实 key（config.ts 已 gitignore）。
 *
 * deepSeekConfig：ToolLoopAgent 编排（@ai-sdk/deepseek）
 */
export const deepSeekConfig = {
  apiKey: 'REPLACE_WITH_YOUR_DEEPSEEK_KEY',
  /** OpenAI 兼容 chat completions 完整 URL */
  baseUrl: 'https://api.deepseek.com/v1/chat/completions',
  /** Agent 模型：deepseek-v4-flash / deepseek-v4-pro */
  model: 'deepseek-v4-flash',
  timeoutMs: 180_000,
};
