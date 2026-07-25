#!/usr/bin/env node
/**
 * 根据 fixtures/form_fields/<case>/fields.json 生成对齐的 HTML 表单。
 * 用法：pnpm gen:forms
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const FF_DIR = join(ROOT, 'fixtures/form_fields');
const OUT_DIR = join(ROOT, 'fixtures/forms');

type Field = {
  id: string;
  label: string;
  type: string;
  group?: string;
  hint?: string;
  options?: string[];
};

type Section = {
  name: string;
  page_context: string;
  fields: Field[];
};

type FieldsDoc = {
  page_context: string;
  sections: Section[];
};

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/"/g, '&quot;');
}

function renderField(f: Field): string {
  const id = esc(f.id);
  const label = esc(f.label);
  const ph = f.hint ? ` placeholder="${esc(f.hint)}"` : '';
  const title = f.hint ? ` title="${esc(f.hint)}"` : '';
  const common = `id="${id}" name="${id}"${ph}${title}`;

  switch (f.type) {
    case 'textarea':
      return `<div class="field">
  <label class="form-label" for="${id}">${label}</label>
  <textarea class="form-control" ${common} rows="3"></textarea>
</div>`;
    case 'select': {
      const opts = (f.options || [])
        .map((o) => `<option value="${esc(o)}">${esc(o)}</option>`)
        .join('\n          ');
      return `<div class="field">
  <label class="form-label" for="${id}">${label}</label>
  <select class="form-select" ${common}>
          <option value="">请选择</option>
          ${opts}
  </select>
</div>`;
    }
    case 'radio': {
      const opts = (f.options || [])
        .map((o, i) => {
          const rid = `${id}__${i}`;
          return `<label class="radio"><input type="radio" name="${id}" id="${esc(rid)}" value="${esc(o)}" aria-label="${label}"/> ${esc(o)}</label>`;
        })
        .join('\n        ');
      return `<div class="field" data-field-id="${id}">
  <div class="form-label" id="lbl_${id}">${label}</div>
  <div class="radio-row" role="radiogroup" aria-labelledby="lbl_${id}">
        ${opts}
  </div>
</div>`;
    }
    case 'checkbox': {
      const opts = f.options?.length
        ? f.options
            .map((o, i) => {
              const cid = `${id}__${i}`;
              return `<label class="check"><input type="checkbox" name="${id}" id="${esc(cid)}" value="${esc(o)}"/> ${esc(o)}</label>`;
            })
            .join('\n        ')
        : `<label class="check"><input type="checkbox" ${common} value="是"/> ${label}</label>`;
      return `<div class="field">
  <div class="form-label">${label}</div>
  <div class="check-row">
        ${opts}
  </div>
</div>`;
    }
    case 'date':
      return `<div class="field">
  <label class="form-label" for="${id}">${label}</label>
  <input class="form-control" type="date" ${common}/>
</div>`;
    case 'email':
      return `<div class="field">
  <label class="form-label" for="${id}">${label}</label>
  <input class="form-control" type="email" ${common}/>
</div>`;
    case 'tel':
      return `<div class="field">
  <label class="form-label" for="${id}">${label}</label>
  <input class="form-control" type="tel" ${common}/>
</div>`;
    case 'number':
      return `<div class="field">
  <label class="form-label" for="${id}">${label}</label>
  <input class="form-control" type="number" ${common}/>
</div>`;
    default:
      return `<div class="field">
  <label class="form-label" for="${id}">${label}</label>
  <input class="form-control" type="text" ${common}/>
</div>`;
  }
}

function sharedCss(): string {
  return `
:root {
  color-scheme: light dark;
  --ink: #14212b;
  --muted: #5d6b76;
  --line: #d5dde3;
  --bg: #f3f6f8;
  --card: #fff;
  --accent: #0f766e;
  --accent-ink: #ecfdf8;
}
@media (prefers-color-scheme: dark) {
  :root {
    --ink: #e8eef2;
    --muted: #9aabb7;
    --line: #2a3640;
    --bg: #10171c;
    --card: #182028;
    --accent: #2dd4bf;
    --accent-ink: #042f2e;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  font-family: "Avenir Next", "PingFang SC", "Segoe UI", sans-serif;
  color: var(--ink);
  background: var(--bg);
}
.topbar {
  background: #1b2a4a;
  color: #fff;
  padding: 12px 20px;
  display: flex;
  gap: 16px;
  align-items: center;
  justify-content: space-between;
}
.topbar a { color: #a5f3fc; font-size: 0.85rem; }
.wrap { max-width: 920px; margin: 24px auto; padding: 0 16px 48px; }
.card {
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 14px;
  padding: 20px;
  box-shadow: 0 8px 24px rgb(15 23 42 / 6%);
}
h1 { margin: 0 0 6px; font-size: 1.35rem; letter-spacing: -0.02em; }
.sub { margin: 0 0 18px; color: var(--muted); font-size: 0.92rem; }
.steps, .tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 16px;
}
.steps button, .tabs button {
  border: 1px solid var(--line);
  background: transparent;
  color: var(--ink);
  border-radius: 999px;
  padding: 7px 12px;
  font: inherit;
  font-size: 0.82rem;
  cursor: pointer;
}
.steps button.is-active, .tabs button.is-active {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--accent-ink);
  font-weight: 600;
}
.panel[hidden] { display: none !important; }
fieldset {
  border: 1px solid var(--line);
  border-radius: 12px;
  padding: 14px 16px 8px;
  margin: 0 0 14px;
}
legend {
  padding: 0 6px;
  font-size: 0.95rem;
  font-weight: 650;
}
.grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px 14px;
}
@media (max-width: 720px) {
  .grid { grid-template-columns: 1fr; }
}
.field { margin-bottom: 4px; }
.form-label {
  display: block;
  font-size: 0.82rem;
  color: var(--muted);
  margin-bottom: 5px;
}
.form-control, .form-select {
  width: 100%;
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 9px 11px;
  font: inherit;
  background: transparent;
  color: var(--ink);
}
.radio-row, .check-row { display: flex; flex-wrap: wrap; gap: 10px 14px; }
.radio, .check { font-size: 0.9rem; display: inline-flex; gap: 6px; align-items: center; }
.nav-row {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  margin-top: 16px;
}
.nav-row button {
  border: none;
  border-radius: 10px;
  padding: 10px 14px;
  font: inherit;
  font-weight: 600;
  cursor: pointer;
  background: var(--accent);
  color: var(--accent-ink);
}
.nav-row button.ghost {
  background: transparent;
  color: var(--ink);
  border: 1px solid var(--line);
}
.noise {
  position: fixed; right: 16px; bottom: 16px; width: 220px;
  background: var(--card); border: 1px solid var(--line);
  padding: 10px; border-radius: 8px; z-index: 20;
}
.site-footer {
  margin-top: 28px; padding-top: 12px; border-top: 1px solid var(--line);
  color: var(--muted); font-size: 0.8rem;
}
`.trim();
}

function renderWizard(doc: FieldsDoc, stem: string, title: string): string {
  const stepBtns = doc.sections
    .map(
      (s, i) =>
        `<button type="button" class="step-btn${i === 0 ? ' is-active' : ''}" data-step="${i}">${esc(s.name)}</button>`,
    )
    .join('\n      ');

  const panels = doc.sections
    .map((s, i) => {
      const fields = s.fields.map(renderField).join('\n      ');
      const group = s.fields[0]?.group || s.name;
      // 不写 hidden：JSDOM/e2e 可扫全量；浏览器脚本再按步骤隐藏
      return `<section class="panel" data-step-panel="${i}">
    <p class="sub">${esc(s.page_context)}</p>
    <fieldset data-section="${esc(group)}">
      <legend>${esc(group)}</legend>
      <div class="grid">
      ${fields}
      </div>
    </fieldset>
  </section>`;
    })
    .join('\n');

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>${esc(title)}</title>
  <style>${sharedCss()}</style>
</head>
<body data-fixture="${esc(stem)}">
  <header class="topbar site-header">
    <strong>${esc(title)}</strong>
    <form id="global-search" role="search">
      <input type="search" name="q" placeholder="搜索办证指南"/>
    </form>
  </header>
  <main class="wrap">
    <div class="card">
      <h1>${esc(title)}</h1>
      <p class="sub">${esc(doc.page_context)} · 字段与 fixtures/form_fields/${esc(stem)}/fields.json 对齐</p>
      <div class="steps" id="steps">
      ${stepBtns}
      </div>
      <form id="main-form" data-fixture="${esc(stem)}">
      ${panels}
        <div class="nav-row">
          <button type="button" class="ghost" id="prev">上一步</button>
          <button type="button" id="next">下一步</button>
        </div>
      </form>
      <p class="site-footer">提示：浏览器中默认只显示当前步骤；加 <code>?all=1</code> 展开全部。CLI/e2e（不执行脚本）可扫到全部字段。</p>
    </div>
  </main>
  <div class="chat-widget noise">
    <div>在线客服</div>
    <input name="chat_msg" placeholder="输入消息"/>
  </div>
  <script>
    (function () {
      const panels = [...document.querySelectorAll('[data-step-panel]')];
      const buttons = [...document.querySelectorAll('.step-btn')];
      let idx = 0;
      const showAll = new URLSearchParams(location.search).has('all');
      function show(i) {
        idx = Math.max(0, Math.min(panels.length - 1, i));
        panels.forEach((p, n) => { p.hidden = showAll ? false : n !== idx; });
        buttons.forEach((b, n) => b.classList.toggle('is-active', n === idx));
      }
      buttons.forEach((b) => b.addEventListener('click', () => show(Number(b.dataset.step))));
      document.getElementById('prev')?.addEventListener('click', () => show(idx - 1));
      document.getElementById('next')?.addEventListener('click', () => show(idx + 1));
      show(0);
    })();
  </script>
</body>
</html>
`;
}

function renderTabs(doc: FieldsDoc, stem: string, title: string): string {
  const tabBtns = doc.sections
    .map(
      (s, i) =>
        `<button type="button" class="tab-btn${i === 0 ? ' is-active' : ''}" data-tab="${i}">${esc(s.name)}</button>`,
    )
    .join('\n      ');

  const panels = doc.sections
    .map((s, i) => {
      const fields = s.fields.map(renderField).join('\n      ');
      const group = s.fields[0]?.group || s.name;
      return `<section class="panel" data-tab-panel="${i}">
    <p class="sub">${esc(s.page_context)}</p>
    <fieldset data-section="${esc(group)}">
      <legend>${esc(group)}</legend>
      <div class="grid">
      ${fields}
      </div>
    </fieldset>
  </section>`;
    })
    .join('\n');

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>${esc(title)}</title>
  <style>${sharedCss()}</style>
</head>
<body data-fixture="${esc(stem)}">
  <header class="topbar site-header">
    <strong>${esc(title)}</strong>
    <form id="global-search" role="search">
      <input type="search" name="q" placeholder="搜索申报指南"/>
    </form>
  </header>
  <main class="wrap">
    <div class="card">
      <h1>${esc(title)}</h1>
      <p class="sub">${esc(doc.page_context)} · 字段与 fixtures/form_fields/${esc(stem)}/fields.json 对齐</p>
      <div class="tabs" id="tabs">
      ${tabBtns}
      </div>
      <form id="main-form" data-fixture="${esc(stem)}">
      ${panels}
      </form>
      <p class="site-footer">提示：浏览器中默认只显示当前页签；加 <code>?all=1</code> 展开全部。CLI/e2e（不执行脚本）可扫到全部字段。</p>
    </div>
  </main>
  <aside class="sidebar-search noise" style="position:fixed;left:16px;bottom:16px;width:200px;background:var(--card);border:1px solid var(--line);padding:10px;border-radius:8px;">
    <div>进度查询</div>
    <input name="progress_query" placeholder="申请号"/>
  </aside>
  <script>
    (function () {
      const panels = [...document.querySelectorAll('[data-tab-panel]')];
      const buttons = [...document.querySelectorAll('.tab-btn')];
      const showAll = new URLSearchParams(location.search).has('all');
      function show(i) {
        panels.forEach((p, n) => { p.hidden = showAll ? false : n !== i; });
        buttons.forEach((b, n) => b.classList.toggle('is-active', n === i));
      }
      buttons.forEach((b) => b.addEventListener('click', () => show(Number(b.dataset.tab))));
      show(0);
    })();
  </script>
</body>
</html>
`;
}

function writeExpected(stem: string, doc: FieldsDoc, exclude: string[]) {
  const mustIncludeNames = doc.sections.flatMap((s) => s.fields.map((f) => f.id));
  const expected = {
    fixture: stem,
    mustIncludeNames,
    mustExcludeNames: exclude,
  };
  const out = join(ROOT, 'fixtures/expected', `${stem}.json`);
  writeFileSync(out, JSON.stringify(expected, null, 2) + '\n');
  console.log('wrote', out);
}

function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  mkdirSync(join(ROOT, 'fixtures/expected'), { recursive: true });

  const visaPath = join(FF_DIR, 'visa_customs/fields.json');
  const govPath = join(FF_DIR, 'gov_project/fields.json');
  if (!existsSync(visaPath) || !existsSync(govPath)) {
    throw new Error('缺少 fixtures/form_fields/*/fields.json');
  }

  const visa = JSON.parse(readFileSync(visaPath, 'utf8')) as FieldsDoc;
  const gov = JSON.parse(readFileSync(govPath, 'utf8')) as FieldsDoc;

  writeFileSync(
    join(OUT_DIR, 'visa_customs.html'),
    renderWizard(visa, 'visa_customs', '签证 + 海关申报向导'),
  );
  writeFileSync(
    join(OUT_DIR, 'gov_project.html'),
    renderTabs(gov, 'gov_project', '政企项目网上申报'),
  );
  console.log('wrote fixtures/forms/visa_customs.html');
  console.log('wrote fixtures/forms/gov_project.html');

  writeExpected('visa_customs', visa, ['q', 'chat_msg']);
  writeExpected('gov_project', gov, ['q', 'progress_query']);
}

main();
