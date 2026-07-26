/**
 * 离线抽取产物 harness：真实 Chrome 打开 fixture，产出可人工核对的三件套。
 *
 *   output/trace/<fixture>/form_graph.json  完整 FormGraph（含 controlNo），可做回归断言
 *   output/trace/<fixture>/controls.md      control_no 为主键的映射表
 *   output/trace/<fixture>/overlay.png      整页截图，控件上画着同一批 control_no
 *
 * 用法：
 *   pnpm trace                     # 全部 fixture
 *   pnpm trace personnel           # 文件名包含 personnel 的 fixture
 *   pnpm trace --probe             # 额外逐个激活 interactives，验证"点击→重抽→新增字段"闭环
 *   pnpm trace --url https://...   # 抽真实站点
 */
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const BUNDLE = path.join(ROOT, 'output/trace-bundle/trace-bundle.js');
const FORMS_DIR = path.join(ROOT, 'fixtures/forms');
const OUT_DIR = path.join(ROOT, 'output/trace');

const args = process.argv.slice(2);
const probeInteractives = args.includes('--probe');
const urlArgIndex = args.indexOf('--url');
const externalUrl = urlArgIndex >= 0 ? args[urlArgIndex + 1] : undefined;
const only = args.find((a) => !a.startsWith('--') && a !== externalUrl);

const targets = externalUrl
  ? [{ name: new URL(externalUrl).hostname, url: externalUrl }]
  : readdirSync(FORMS_DIR)
      .filter((f) => f.endsWith('.html') && f !== 'index.html')
      .filter((f) => !only || f.includes(only))
      .map((f) => ({ name: f.replace(/\.html$/, ''), url: `file://${path.join(FORMS_DIR, f)}` }));

if (!targets.length) {
  console.error('没有匹配的 fixture');
  process.exit(1);
}

const snapshot = (page) => page.evaluate(() => window.__snapfillTrace.snapshot(300));

/** probe 的点击预算，防止环形交互（tab 互相激活）打不完 */
const MAX_PROBE_ROUNDS = 24;

const browser = await chromium.launch({ channel: 'chrome', headless: true });

for (const target of targets) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1200 } });
  await page.goto(target.url, { waitUntil: 'load' });
  await page.addScriptTag({ path: BUNDLE });

  let graph = await snapshot(page);

  // --probe：模拟 Agent 的探索循环——逐个激活交互点后重新抽取并累加，
  // 产物因此反映"探索完整之后"的图，而不只是首屏那一眼。
  const probeLog = [];
  if (probeInteractives) {
    const visited = new Set();
    for (let round = 0; round < MAX_PROBE_ROUNDS; round++) {
      const next = graph.interactives.find((i) => i.status === 'pending' && !visited.has(i.interactiveId));
      if (!next) break;
      visited.add(next.interactiveId);

      // 切走面板后，别的面板里的交互点还留在图里但已不可见，直接跳过省掉超时等待
      const visible = await page.locator(next.selector).first().isVisible().catch(() => false);
      if (!visible) {
        probeLog.push(`  - [${next.kind}] ${next.label} → 当前面板不可见，跳过`);
        continue;
      }

      const before = graph.fields.length;
      try {
        await page.click(next.selector, { timeout: 2000 });
      } catch (err) {
        probeLog.push(`  - [${next.kind}] ${next.label} → 点击失败: ${String(err).split('\n')[0]}`);
        continue;
      }
      await page.waitForTimeout(300);
      graph = await page.evaluate(
        ([g, ids]) => window.__snapfillTrace.accumulate(g, ids),
        [graph, [...visited]],
      );
      probeLog.push(`  - [${next.kind}] ${next.label} → +${graph.fields.length - before} 字段，累积 ${graph.fields.length}`);
    }
  }

  const trace = await page.evaluate((g) => window.__snapfillTrace.buildTrace(g), graph);

  const dir = path.join(OUT_DIR, target.name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'form_graph.json'), JSON.stringify(graph, null, 2));
  writeFileSync(path.join(dir, 'controls.md'), trace.markdown);

  const drawn = await page.evaluate((g) => window.__snapfillTrace.annotate(g), graph);
  await page.screenshot({ path: path.join(dir, 'overlay.png'), fullPage: true });
  await page.evaluate(() => window.__snapfillTrace.clearOverlay());

  console.log(`\n========== ${target.name} ==========`);
  for (const line of trace.summary) console.log(line);
  console.log(`产物: ${path.relative(ROOT, dir)}/{form_graph.json,controls.md,overlay.png} 标注控件=${drawn}`);
  if (probeLog.length) {
    console.log('interaction probe:');
    for (const line of probeLog) console.log(line);
  }

  await page.close();
}

await browser.close();
