// Background service worker: receive capture requests from content script, capture visible tab, and send image back

const MSG = {
  REQUEST_CAPTURE: 'REQUEST_CAPTURE',
  CAPTURE_RESULT: 'CAPTURE_RESULT'
};

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || msg.type !== MSG.REQUEST_CAPTURE) return;

  const tabId = sender.tab && sender.tab.id;
  if (!tabId) {
    console.error('REQUEST_CAPTURE: no sender.tab.id');
    return;
  }

  // Capture the visible area of the current window
  chrome.tabs.captureVisibleTab(null, { format: 'png', quality: 100 }, (dataUrl) => {
    if (chrome.runtime.lastError) {
      console.error('captureVisibleTab failed:', chrome.runtime.lastError.message);
      chrome.tabs.sendMessage(tabId, {
        type: MSG.CAPTURE_RESULT,
        requestId: msg.requestId,
        errorCode: 'CAPTURE_FAILED',
        error: chrome.runtime.lastError.message
      });
      return;
    }

    // Send captured data back to the content script that requested it
    chrome.tabs.sendMessage(tabId, {
      type: MSG.CAPTURE_RESULT,
      requestId: msg.requestId,
      image: dataUrl,
      bounds: msg.bounds
    });
  });
});
