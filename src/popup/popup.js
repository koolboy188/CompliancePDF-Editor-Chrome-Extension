document.getElementById("openPanel")?.addEventListener("click", async () => {
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (activeTab?.id) {
    await chrome.sidePanel.open({ tabId: activeTab.id });
  }
  window.close();
});
