const MSG = {
  PING_SELECTION: 'PING_SELECTION',
  START_SELECTION: 'START_SELECTION'
};

const UI = {
  READY: '✨ 就绪 (识别后自动复印并显示在页面)',
  PREPARING: '⏳ 正在准备框选环境...',
  SELECTING: '🖱️ 在页面上拖动鼠标选择区域...',
  FAIL_NOTAB: '❌ 启动失败：未找到活动选项卡',
  FAIL_INJECT: '❌ 启动失败：注入识别脚本失败',
  FAIL_TIMEOUT: '❌ 启动失败：消息超时，请重试',
  FAIL_START: '❌ 启动失败：内容脚本未响应'
};

const CONFIG = {
  MESSAGE_TIMEOUT_MS: 1200,
  START_SELECTION_MAX_RETRY: 2,
  START_SELECTION_RETRY_DELAY_MS: 120,
  CLOSE_DELAY_MS: 200
};

let ocrEngine = null;

function setStatus(statusDiv, text) {
  statusDiv.textContent = text;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function loadOCR() {
  if (ocrEngine) return ocrEngine;
  const mod = await import(chrome.runtime.getURL('ocr.js'));
  if (mod && mod.ocrEngine) {
    ocrEngine = mod.ocrEngine;
  } else if (mod && mod.LightweightOCR) {
    ocrEngine = new mod.LightweightOCR();
  } else if (window && window.ocrEngine) {
    ocrEngine = window.ocrEngine;
  } else if (window && window.LightweightOCR) {
    ocrEngine = new window.LightweightOCR();
  } else {
    throw new Error('LightweightOCR is not available after importing ocr.js');
  }
  return ocrEngine;
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) throw new Error(UI.FAIL_NOTAB);
  return tab;
}

function sendTabMessageWithTimeout(tabId, message, timeoutMs) {
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      reject(new Error('MESSAGE_TIMEOUT'));
    }, timeoutMs);

    chrome.tabs.sendMessage(tabId, message, (resp) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message || 'MESSAGE_FAILED'));
        return;
      }
      resolve(resp);
    });
  });
}

async function isSelectionReady(tabId) {
  try {
    const resp = await sendTabMessageWithTimeout(tabId, { type: MSG.PING_SELECTION }, CONFIG.MESSAGE_TIMEOUT_MS);
    return Boolean(resp && resp.ready);
  } catch (_e) {
    return false;
  }
}

async function ensureInjected(tabId) {
  if (await isSelectionReady(tabId)) return;
  try {
    await chrome.scripting.insertCSS({ target: { tabId }, files: ['selection.css'] });
  } catch (_e) {
    // CSS 注入失败不阻断，脚本内有关键样式兜底
  }

  await chrome.scripting.executeScript({ target: { tabId }, files: ['tesseract/tesseract.min.js'] });
  await chrome.scripting.executeScript({ target: { tabId }, files: ['ocr.js'] });
  await chrome.scripting.executeScript({ target: { tabId }, files: ['selection.js'] });

  const ready = await isSelectionReady(tabId);
  if (!ready) throw new Error('SELECTION_NOT_READY');
}

async function startSelectionWithRetry(tabId) {
  let lastError = null;
  for (let i = 0; i < CONFIG.START_SELECTION_MAX_RETRY; i++) {
    try {
      const resp = await sendTabMessageWithTimeout(tabId, { type: MSG.START_SELECTION }, CONFIG.MESSAGE_TIMEOUT_MS);
      if (resp && resp.started) return;
      lastError = new Error((resp && resp.error) || 'START_REJECTED');
    } catch (e) {
      lastError = e;
    }
    if (i < CONFIG.START_SELECTION_MAX_RETRY - 1) await wait(CONFIG.START_SELECTION_RETRY_DELAY_MS);
  }
  throw lastError || new Error('START_FAILED');
}

function mapStartupError(error) {
  const msg = String((error && error.message) || error || '');
  if (msg.includes('未找到活动选项卡')) return UI.FAIL_NOTAB;
  if (msg.includes('MESSAGE_TIMEOUT')) return UI.FAIL_TIMEOUT;
  if (msg.includes('Cannot access') || msg.includes('SELECTION_NOT_READY')) return UI.FAIL_INJECT;
  return UI.FAIL_START;
}

document.addEventListener('DOMContentLoaded', async () => {
  const captureBtn = document.getElementById('captureBtn');
  const statusDiv = document.getElementById('status');

  setStatus(statusDiv, UI.READY);
  await loadOCR().catch((e) => console.warn('OCR preload warning:', e));

  captureBtn.addEventListener('click', async () => {
    captureBtn.disabled = true;
    setStatus(statusDiv, UI.PREPARING);

    try {
      const tab = await getActiveTab();
      await ensureInjected(tab.id);
      setStatus(statusDiv, UI.SELECTING);
      await startSelectionWithRetry(tab.id);
      setTimeout(() => window.close(), CONFIG.CLOSE_DELAY_MS);
    } catch (error) {
      console.error('启动失败:', error);
      setStatus(statusDiv, mapStartupError(error));
      captureBtn.disabled = false;
    }
  });
});
