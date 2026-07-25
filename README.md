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

浏览器打开 `http://localhost:4173/`，点扩展图标打开侧栏，发消息或点「智能填表」。对话中会实时出现工具调用卡片（抽取 → 填值 → 写回）。

日志在 **`pnpm dev` 终端**（`[Snapfill …] [bg|agent|api|content|…]`）。

## 配置

1. DeepSeek（Agent）：复制 [`lib/ai/config.example.ts`](lib/ai/config.example.ts) → `lib/ai/config.ts`，填写 `deepSeekConfig`。
2. 后端联调：复制 [`lib/api/config.example.ts`](lib/api/config.example.ts) → `lib/api/config.ts`（默认 `http://127.0.0.1:8008`）。

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

需本地后端 `http://127.0.0.1:8008` 已启动，且已配置 `lib/api/config.ts`。

主用例 HTML 由 `fixtures/form_fields/<case>/fields.json` 生成：

```bash
pnpm gen:forms                # 生成 visa_customs / gov_project HTML
pnpm e2e                      # 默认 visa_customs：扫 DOM → fill → 写回
pnpm e2e --fresh-kb           # 上传同目录 kb.txt 再填
pnpm e2e gov_project --kb fixtures/form_fields/gov_project/kb.txt --fresh-kb
pnpm e2e:agent
```

产物：`output/e2e/<fixture>.fields.json`、`.result.json`。
