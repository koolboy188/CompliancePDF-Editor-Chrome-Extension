import { MESSAGE_TYPES } from "../shared/message-types.js";

const viewerClients = new Set();
let latestViewerTabId = null;

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {
    // Ignore side panel setup failures.
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === latestViewerTabId) {
    latestViewerTabId = null;
  }
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "flexipdf-viewer") {
    return;
  }

  viewerClients.add(port);
  port.onDisconnect.addListener(() => {
    viewerClients.delete(port);
  });
});

chrome.action.onClicked.addListener(async (tab) => {
  if (tab?.id) {
    await openSidePanelForTab(tab.id);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message?.type) {
    return false;
  }

  switch (message.type) {
    case MESSAGE_TYPES.OPEN_PDF_IN_VIEWER:
      handleAsyncMessage(sendResponse, async () => {
        const viewerTabId = await openViewerWithSource(message.payload?.url);
        return { ok: true, viewerTabId };
      });
      return true;

    case MESSAGE_TYPES.OPEN_SIDE_PANEL:
      if (sender.tab?.id) {
        handleAsyncMessage(sendResponse, async () => {
          await openSidePanelForTab(sender.tab.id);
          return { ok: true };
        });
        return true;
      }
      return false;

    case MESSAGE_TYPES.SIDE_PANEL_COMMAND:
      broadcastToViewer(message);
      return false;

    case MESSAGE_TYPES.VIEWER_READY:
      if (sender.tab?.id) {
        latestViewerTabId = sender.tab.id;
      }
      return false;

    default:
      return false;
  }
});

async function openViewerWithSource(sourceUrl) {
  const viewerUrl = new URL(chrome.runtime.getURL("src/viewer/viewer.html"));
  if (sourceUrl) {
    viewerUrl.searchParams.set("src", sourceUrl);
  }

  const existingViewerTab = await getExistingViewerTab();
  if (existingViewerTab?.id) {
    await chrome.tabs.update(existingViewerTab.id, {
      url: viewerUrl.toString(),
      active: true
    });
    latestViewerTabId = existingViewerTab.id;
    return latestViewerTabId;
  }

  const tab = await chrome.tabs.create({
    url: viewerUrl.toString(),
    active: true
  });

  latestViewerTabId = tab.id ?? null;
  return latestViewerTabId;
}

async function getExistingViewerTab() {
  if (!latestViewerTabId) {
    return null;
  }
  try {
    const tab = await chrome.tabs.get(latestViewerTabId);
    return tab?.id ? tab : null;
  } catch (_) {
    latestViewerTabId = null;
    return null;
  }
}

async function openSidePanelForTab(tabId) {
  try {
    await chrome.sidePanel.open({ tabId });
  } catch (_) {
    // Avoid throwing from action/popup handlers.
  }
}

function handleAsyncMessage(sendResponse, handler) {
  handler()
    .then((payload) => {
      sendResponse(payload);
    })
    .catch((error) => {
      sendResponse({
        ok: false,
        error: error?.message ?? "Unknown error"
      });
    });
}

function broadcastToViewer(message) {
  for (const client of viewerClients) {
    try {
      client.postMessage(message);
    } catch (_) {
      // Ignore stale ports; disconnect handler cleans them.
    }
  }
}
