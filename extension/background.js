// 点击工具栏图标，在新标签页打开归档界面。
// 界面需要活得比 popup 久（批量任务要跑几分钟），所以用独立标签页而不是 popup。
chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL('app.html') });
});
