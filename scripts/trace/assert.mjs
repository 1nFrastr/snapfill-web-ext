/**
 * 抽取质量回归断言（事实层口径）。
 *
 * - 通用不变量：控件归属、空重复表结构、无生成串题干（仅 html 事实 label）
 * - 质量下限：coverage / regions / emptyRepeatTables / interactives / chapterTexts
 * labeledRate 不再作为上传质量门槛（题干关联在后端）
 */

const GENERATED_TOKEN_RE = [
  /\d{10,}/,
  /^[0-9a-f]{16,}$/i,
  /\.(pdf|docx?|xlsx?|pptx?|jpe?g|png|zip|rar|ofd)\b/i,
  /_\d{4}_\d{6,}/,
];

function looksGenerated(text) {
  return GENERATED_TOKEN_RE.some((re) => re.test(text));
}

function checkInvariants(graph) {
  const errors = [];
  const push = (msg) => errors.push(msg);

  if (graph.metrics.unresolvedCount !== 0) {
    push(`unresolved=${graph.metrics.unresolvedCount}，应为 0`);
  }

  if (!Array.isArray(graph.texts)) {
    push('缺少 texts 事实层');
  }

  for (const r of graph.regions) {
    // 空名合法：前端无命名事实时不编造，由后端用 texts 层章节标题归属
    if (r.name && looksGenerated(r.name)) push(`区域名像生成串：「${r.name}」(${r.regionId})`);

    if (r.kind === 'repeat_group') {
      const cols = r.table?.columns?.length ?? 0;
      if (cols < 2) push(`重复块「${r.name}」只有 ${cols} 列，应 >=2`);
      // 空表（rowCount=0）合法：供 Agent 激活增行；有行时至少 1
      const rows = r.repeat?.rowCount ?? 0;
      if (rows < 0) push(`重复块「${r.name}」rowCount 非法`);
    }

    if (r.kind === 'kv' && (r.table?.columns?.length ?? 0) > 0) {
      const cols = r.table.columns.map((c) => c.label ?? c).join(',');
      push(`kv 区域「${r.name}」带了列结构 [${cols}]`);
    }
  }

  const regionIds = new Set(graph.regions.map((r) => r.regionId));
  for (const f of graph.fields) {
    if (f.regionId !== 'ungrouped' && !regionIds.has(f.regionId)) {
      push(`字段 ${f.fieldId} 指向不存在的区域 ${f.regionId}`);
    }
    // 仅当有 html 事实 label 时检查；空 label 合法（后端几何关联）
    if (f.label && looksGenerated(f.label)) push(`题干像生成串：「${f.label}」(${f.fieldId})`);
  }

  return errors;
}

function checkFloors(graph, floor) {
  const errors = [];
  const m = graph.metrics;
  if (floor.minCoverage != null && m.coverage < floor.minCoverage) {
    errors.push(`coverage ${m.coverage.toFixed(3)} < 下限 ${floor.minCoverage}`);
  }
  if (floor.minRegions != null && graph.regions.length < floor.minRegions) {
    errors.push(`regions ${graph.regions.length} < 下限 ${floor.minRegions}`);
  }
  if (floor.minTexts != null && (graph.texts?.length ?? 0) < floor.minTexts) {
    errors.push(`texts ${graph.texts?.length ?? 0} < 下限 ${floor.minTexts}`);
  }
  if (floor.minEmptyRepeatTables != null) {
    const empty = graph.regions.filter(
      (r) => r.kind === 'repeat_group' && (r.repeat?.rowCount ?? 0) === 0,
    );
    if (empty.length < floor.minEmptyRepeatTables) {
      errors.push(`空重复表 ${empty.length} < 下限 ${floor.minEmptyRepeatTables}`);
    }
  }
  if (floor.requireAddButton) {
    const has = (graph.interactives ?? []).some((i) => i.kind === 'add-button');
    if (!has) errors.push('缺少 add-button interactive');
  }
  // 重复块按「必含列名」定位而不是按区域名：区域命名已是后端职责，前端产出可能为空名
  for (const want of floor.repeatGroups ?? []) {
    const label = want.columnsInclude?.join('/') ?? '(未指定列)';
    const r = graph.regions.find(
      (x) =>
        x.kind === 'repeat_group' &&
        (want.columnsInclude ?? []).every((col) =>
          (x.table?.columns ?? []).some((c) => (c.label ?? '').includes(col)),
        ),
    );
    if (!r) {
      errors.push(`缺少含列 [${label}] 的重复块`);
      continue;
    }
    if (want.rowCount != null && r.repeat?.rowCount !== want.rowCount) {
      errors.push(`重复块 [${label}] rowCount=${r.repeat?.rowCount}，期望 ${want.rowCount}`);
    }
    if (want.columns != null && r.table?.columns?.length !== want.columns) {
      errors.push(`重复块 [${label}] 列数=${r.table?.columns?.length}，期望 ${want.columns}`);
    }
  }
  for (const name of floor.regionNames ?? []) {
    if (!graph.regions.some((r) => r.name === name || r.chain?.includes(name))) {
      // 区域名可能在 texts 里（语义分节迁后端后本地 region 名较粗）
      const inTexts = (graph.texts ?? []).some((t) => t.text?.includes(name));
      if (!inTexts) errors.push(`缺少区域/文本「${name}」`);
    }
  }
  for (const name of floor.chapterTexts ?? []) {
    if (!(graph.texts ?? []).some((t) => t.text?.includes(name))) {
      errors.push(`texts 缺少章节原文「${name}」`);
    }
  }
  return errors;
}

export function checkGraph(name, graph, expectations) {
  return [...checkInvariants(graph), ...checkFloors(graph, expectations[name] ?? {})];
}
