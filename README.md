# WXT + React — Snapfill

对话式表单填写助手：侧栏流式展示 Agent 工具调用；插件抽 DOM / 回填；后端知识库填值；Vercel AI SDK `ToolLoopAgent` 编排。

## 开发

```bash
pnpm install
pnpm dev
```

另开终端启动测试表单：

```bash
pnpm fixtures
```

浏览器打开 `http://localhost:4173/`，点扩展图标打开侧栏：

1. **登录**后端账号（表单预填本地联调账号，需点确认）
2. **勾选 / 上传**知识库材料
3. 发消息或点「智能填表」

对话中会实时出现工具调用卡片（抽取 → 填值 → 写回）。未勾选知识库时，后端使用账号下全部已解析文件。

日志在 **`pnpm dev` 终端**（`[Snapfill …] [bg|agent|api|content|…]`）。

## 配置

1. 复制 [`.env.example`](.env.example) → `.env.local`，填写 DeepSeek Key / 后端等（已 gitignore）。
2. 侧栏「设置」可覆盖并持久化到 `browser.storage.local`（可重置回 env 默认）。
3. Base URL 仅可从白名单选择（[`lib/settings/allowlist.ts`](lib/settings/allowlist.ts)）。

`pnpm build` / `zip` 会清空密钥类 env，**不会把 `.env.local` 打进扩展产物**；正式使用靠侧栏设置或留空后用户自配。

后端文档：`snapfill-backend/docs/FORM_FIELDS_FILL_API.md`。本地 API 需已启动。

## 智能填表流程

```
extractPageFields（content 扫 DOM）
  → listKnowledgeFiles（可选）
  → fillFormFields（POST /Table/form-fields/fill）
  → applyFieldValues（写回控件）
```

background 经 `runtime.connect` Port 把 `ToolLoopAgent.stream` 的文本增量与工具事件推到侧栏。

## 端到端填表测试

需本地后端已启动，且已配置 `.env.local`（或侧栏设置）。

主用例 HTML 由 `fixtures/form_fields/<case>/fields.json` 生成：

```bash
pnpm gen:forms                # 生成 visa_customs / gov_project HTML
pnpm e2e                      # 默认 visa_customs：扫 DOM → fill → 写回
pnpm e2e --fresh-kb           # 上传同目录 kb.txt 再填
pnpm e2e gov_project --kb fixtures/form_fields/gov_project/kb.txt --fresh-kb
pnpm e2e:agent
```

产物：`output/e2e/<fixture>.fields.json`、`.result.json`。
