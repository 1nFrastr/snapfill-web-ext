export default defineBackground(() => {
  // 点击扩展图标时打开侧边栏，而不是 popup
  browser.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((error) => console.error(error));
});
