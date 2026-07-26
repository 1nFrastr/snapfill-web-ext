# WXT + React — Snapfill

对话式表单填写助手：侧栏流式展示 Agent 工具调用；插件抽 DOM / 回填；后端知识库填值；Vercel AI SDK `ToolLoopAgent` 编排。

**职责边界**：插件只做浏览器物理上独占的事（DOM 遍历、shadow 穿透、交互探索、坐标测量、回填校验）；
语义判断（区域分类、query 生成、检索、填值）全部在后端。Agent 不构造字段清单，也不经手具体的值。

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

对话中会实时出现工具调用卡片（抽取 → 交互探索 → 提交 → 写回）。未勾选知识库时，后端使用账号下全部已解析文件。

日志在 **`pnpm dev` 终端**（`[Snapfill …] [bg|agent|api|content|…]`）。

## 配置

1. 复制 [`.env.example`](.env.example) → `.env.local`，填写 DeepSeek Key / 后端等（已 gitignore）。
2. 侧栏「设置」可覆盖并持久化到 `browser.storage.local`（可重置回 env 默认）。
3. Base URL 仅可从白名单选择（[`lib/settings/allowlist.ts`](lib/settings/allowlist.ts)）。

`pnpm build` / `zip` 会清空密钥类 env，**不会把 `.env.local` 打进扩展产物**；正式使用靠侧栏设置或留空后用户自配。

后端文档：`snapfill-backend/docs/FORM_FIELDS_FILL_API.md`。本地 API 需已启动。

## 智能填表流程

```
感知  probeFrames / snapshotForm / describeRegion / readElementDetail
行动  activate / openOptions（内建导航守卫、预算上限、危险按钮黑名单）
观察  getExtractionReport（覆盖率 / 标签置信率 / 低置信控件清单）
提交  commitFormGraph（事实层 controls+texts+structure → POST /Table/form-regions/fill）
回填  applyValues（按 frameId 定向写回 + 回读校验 verified/reverted/mismatch）
```

background 经 `runtime.connect` Port 把 `ToolLoopAgent.stream` 的文本增量与工具事件推到侧栏。

分工：**点不点、按什么顺序点、哪个面板该跳过、什么时候收敛**归 Agent；
**这次快照属于哪个面板、抽过哪些、激活过哪些**归代码。FormGraph 的累积粒度是 `(frameId, panelKey)`
而非 frameId——切 tab 会移除上一个面板的 DOM，按 frame 覆盖会把先前抽到的字段静默抹掉。
`snapshotForm` 返回 `panelsPending` 告诉 Agent 还剩哪些面板没抽。

## 抽取产物（可观测性）

`FieldNode.controlNo` 是阅读顺序编号，既画在截图上、又是映射表主键——肉眼对一遍编号
就能判断"控件 ↔ 题干"配没配对（做法沿用 PDF 实验的 SoM 编号）。

离线 harness（真实 Chrome、整页截图，推荐）：

```bash
pnpm trace                     # 全部 fixture
pnpm trace personnel           # 只跑文件名匹配的
pnpm trace --probe             # 复刻 Agent 探索循环：逐个激活 → 重抽 → 累加
pnpm trace --url https://...   # 抽真实站点
```

产物：`output/trace/<name>/{form_graph.json, controls.md, overlay.png}`。summary 里的
`panels:` 行标出哪些面板还「未抽取」，`dropped:` 直方图区分"正确忽略的噪声"和"误杀的字段"。

运行时：每轮 Agent 结束自动抓一份存进 `storage.local`，侧栏「导出抽取产物」下载同样的三件套
（截图受 `captureVisibleTab` 限制只有可视区，整页请用 harness）。
