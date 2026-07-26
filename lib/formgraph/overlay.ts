/**
 * 在页面上画 control_no 标注层，供截图后人工核对"控件 ↔ 题干"。
 *
 * 做法与 PDF 实验 `som_pipeline.render_annotated_page` 一致：控件描边 + 左上角编号徽标，
 * 编号取自 FieldNode.controlNo（阅读顺序），与 trace 映射表主键同源。
 * 区域另用虚线框标出，便于同时核对区域划分是否合理。
 *
 * 标注是临时的：截图后必须 clearOverlay()，不留任何 DOM 残留。
 */

const OVERLAY_ID = 'snapfill-control-overlay';

export type OverlayTarget = { key: string; el: Element };

function css(el: HTMLElement, text: string) {
  el.style.cssText = text;
}

function ensureLayer(): HTMLElement {
  clearOverlay();
  const layer = document.createElement('div');
  layer.id = OVERLAY_ID;
  css(
    layer,
    'all:initial;position:absolute;top:0;left:0;width:0;height:0;z-index:2147483646;pointer-events:none;',
  );
  document.body.appendChild(layer);
  return layer;
}

function box(x: number, y: number, w: number, h: number, style: string): HTMLElement {
  const el = document.createElement('div');
  css(
    el,
    `position:absolute;left:${x}px;top:${y}px;width:${w}px;height:${h}px;box-sizing:border-box;pointer-events:none;${style}`,
  );
  return el;
}

function badge(x: number, y: number, text: string, color: string): HTMLElement {
  const el = document.createElement('div');
  el.textContent = text;
  css(
    el,
    `position:absolute;left:${x}px;top:${y}px;transform:translate(-50%,-50%);` +
      'display:flex;align-items:center;justify-content:center;min-width:16px;height:16px;padding:0 3px;' +
      `border:1.2px solid ${color};border-radius:9px;background:#fff;color:${color};` +
      'font:700 10px/1 ui-monospace,SFMono-Regular,Menlo,monospace;pointer-events:none;white-space:nowrap;',
  );
  return el;
}

/**
 * 画标注层，返回实际画出的控件数。
 * 坐标用「视口 rect + 页面滚动量」换算成文档坐标，整页截图时编号不会错位。
 */
export function renderOverlay(fields: OverlayTarget[], regions: OverlayTarget[] = []): number {
  const layer = ensureLayer();
  const sx = window.scrollX;
  const sy = window.scrollY;

  for (const { key, el } of regions) {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    layer.appendChild(
      box(r.x + sx, r.y + sy, r.width, r.height, 'border:1px dashed rgba(29,78,216,.75);background:rgba(29,78,216,.03);'),
    );
    const tag = badge(r.x + sx + 4, r.y + sy - 2, key, '#1d4ed8');
    tag.style.transform = 'translate(0,-50%)';
    layer.appendChild(tag);
  }

  let drawn = 0;
  for (const { key, el } of fields) {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    layer.appendChild(box(r.x + sx, r.y + sy, r.width, r.height, 'border:1px solid rgba(234,88,12,.9);'));
    layer.appendChild(badge(r.x + sx, r.y + sy, key, '#bf0000'));
    drawn += 1;
  }

  return drawn;
}

export function clearOverlay(): void {
  document.getElementById(OVERLAY_ID)?.remove();
}
