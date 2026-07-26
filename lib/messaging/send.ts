/** background/sidepanel → content script 的定向发送（含首次注入兜底） */

export async function ensureContentScripts(tabId: number): Promise<void> {
  try {
    await browser.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ['/content-scripts/content.js'],
    });
  } catch {
    // 部分 frame 可能拒绝注入（chrome-error 等），忽略
  }
}

export async function sendToFrame<T>(tabId: number, frameId: number | undefined, message: unknown): Promise<T> {
  const send = () =>
    browser.tabs.sendMessage(tabId, message, frameId != null ? { frameId } : undefined) as Promise<T>;
  try {
    return await send();
  } catch (first) {
    await ensureContentScripts(tabId);
    try {
      return await send();
    } catch {
      throw first instanceof Error ? first : new Error('无法连接页面脚本，请刷新后重试');
    }
  }
}
