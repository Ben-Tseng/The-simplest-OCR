// Content script: drag-select area, request capture, run OCR, and show result panel
console.log('selection.js loaded');

(() => {
  if (window.selectionLoaded) {
    console.log('selection.js already loaded, skipping initialization');
    return;
  }
  window.selectionLoaded = true;

  const MSG = {
    PING_SELECTION: 'PING_SELECTION',
    START_SELECTION: 'START_SELECTION',
    REQUEST_CAPTURE: 'REQUEST_CAPTURE',
    CAPTURE_RESULT: 'CAPTURE_RESULT'
  };

  const CONFIG = {
    CAPTURE_TIMEOUT_MS: 1800,
    CAPTURE_MAX_RETRY: 3,
    CAPTURE_RETRY_DELAY_MS: 120,
    MIN_SELECTION_SIZE: 2,
    TESSERACT_TIMEOUT_MS: 12000,
    RESULT_AUTO_CLOSE_MS: 15000,
    COPY_STATUS_MS: 2000,
    AUTO_COPY_STATUS_MS: 2500,
    TOAST_MS: 2600
  };

  const UI = {
    SELECTION_HINT: '拖动以选择区域，按 ESC 取消',
    PANEL_TITLE: '识别结果',
    RESULT_EMPTY: '未识别到内容',
    COPY_OK: '已成功复制',
    COPY_BUTTON: '复制',
    SHOW_DEBUG: '显示调试图',
    HIDE_DEBUG: '隐藏调试图',
    DEBUG_NOTE: '调试：引擎眼中的黑白二值图 (如果文字断裂或连结，请反馈给开发者)',
    ERROR_CAPTURE: '截图失败，请重试',
    ERROR_OCR: '识别失败，请重试',
    ERROR_COPY: '复制失败，请手动点击“复制”按钮',
    ERROR_TESSERACT: 'Tesseract 初始化失败，已回退本地引擎'
  };

  let overlay = null;
  let box = null;
  let startX = 0;
  let startY = 0;
  let isSelecting = false;
  let prevDocUserSelect = '';
  let prevBodyUserSelect = '';
  let pendingCapture = null;
  let tesseractWorker = null;
  let tesseractReadyPromise = null;

  function ensurePanelStyle() {
    if (document.getElementById('ocr-panel-style')) return;
    const style = document.createElement('style');
    style.id = 'ocr-panel-style';
    style.textContent = `
      @keyframes slideDown {
        from { transform: translate(-50%, -20px); opacity: 0; }
        to { transform: translate(-50%, 0); opacity: 1; }
      }
      .ocr-panel-btn:hover { background: #f0f0f0 !important; border-color: #1a73e8 !important; }
      .ocr-debug-canvas { border: 1px solid #ddd; margin-right: 4px; background: white; image-rendering: pixelated; }
      .ocr-toast {
        position: fixed;
        left: 50%;
        bottom: 24px;
        transform: translateX(-50%);
        z-index: 2147483647;
        padding: 10px 16px;
        border-radius: 999px;
        color: #fff;
        font-size: 13px;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        box-shadow: 0 6px 20px rgba(0, 0, 0, 0.28);
      }
      .ocr-toast-error { background: #d93025; }
      .ocr-toast-warning { background: #ea8600; }
    `;
    document.head.appendChild(style);
  }

  function showToast(level, text) {
    ensurePanelStyle();
    const toast = document.createElement('div');
    toast.className = `ocr-toast ${level === 'error' ? 'ocr-toast-error' : 'ocr-toast-warning'}`;
    toast.textContent = text;
    document.documentElement.appendChild(toast);
    setTimeout(() => {
      if (toast.parentNode) toast.remove();
    }, CONFIG.TOAST_MS);
  }

  function createRequestId() {
    return `cap_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }

  function withTimeout(promise, timeoutMs, errorMessage) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(errorMessage)), timeoutMs);
      promise
        .then((res) => {
          clearTimeout(timer);
          resolve(res);
        })
        .catch((err) => {
          clearTimeout(timer);
          reject(err);
        });
    });
  }

  function normalizeRecognizedText(text) {
    return String(text || '')
      .toUpperCase()
      .replace(/[^0-9A-Z]/g, '')
      .trim();
  }

  async function getTesseractWorker() {
    if (tesseractWorker) return tesseractWorker;
    if (tesseractReadyPromise) return tesseractReadyPromise;
    if (!window.Tesseract || !window.Tesseract.createWorker) {
      throw new Error('Tesseract runtime not loaded');
    }

    tesseractReadyPromise = (async () => {
      const worker = await window.Tesseract.createWorker('eng', 1, {
        workerPath: chrome.runtime.getURL('tesseract/worker.min.js'),
        corePath: chrome.runtime.getURL('tesseract/tesseract-core.wasm.js'),
        langPath: 'https://tessdata.projectnaptha.com/4.0.0'
      });

      await worker.setParameters({
        tessedit_char_whitelist: '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ',
        tessedit_pageseg_mode: '7',
        preserve_interword_spaces: '0'
      });
      tesseractWorker = worker;
      return worker;
    })();

    try {
      return await tesseractReadyPromise;
    } catch (err) {
      tesseractReadyPromise = null;
      throw err;
    }
  }

  async function recognizeWithTesseract(canvas) {
    const worker = await getTesseractWorker();
    const res = await withTimeout(worker.recognize(canvas), CONFIG.TESSERACT_TIMEOUT_MS, 'Tesseract timeout');
    return normalizeRecognizedText(res && res.data ? res.data.text : '');
  }

  function recognizeWithLightweight(canvas) {
    const ocr = typeof ocrEngine !== 'undefined' ? ocrEngine : (window.ocrEngine ? window.ocrEngine : null);
    if (!ocr) throw new Error('OCR engine not ready');
    return normalizeRecognizedText(ocr.recognize(canvas));
  }

  async function recognizeText(canvas) {
    try {
      const text = await recognizeWithTesseract(canvas);
      if (text) return { text, engine: 'tesseract' };
    } catch (err) {
      console.warn('Tesseract failed, fallback to lightweight OCR:', err);
      showToast('warning', UI.ERROR_TESSERACT);
    }

    const fallback = recognizeWithLightweight(canvas);
    return { text: fallback, engine: 'lightweight' };
  }

  function clearPendingCapture() {
    if (pendingCapture && pendingCapture.timerId) {
      clearTimeout(pendingCapture.timerId);
    }
    pendingCapture = null;
  }

  function createOverlay() {
    removeOverlay();

    overlay = document.createElement('div');
    overlay.className = 'ocr-selection-overlay';
    overlay.style.position = 'fixed';
    overlay.style.top = '0';
    overlay.style.left = '0';
    overlay.style.width = '100%';
    overlay.style.height = '100%';
    overlay.style.background = 'transparent';
    overlay.style.zIndex = '2147483647';
    overlay.style.cursor = 'crosshair';
    overlay.style.pointerEvents = 'auto';
    overlay.style.userSelect = 'none';

    prevDocUserSelect = document.documentElement.style.userSelect || '';
    prevBodyUserSelect = document.body.style.userSelect || '';
    try {
      document.documentElement.style.userSelect = 'none';
      document.body.style.userSelect = 'none';
    } catch (_e) {
      // ignore
    }

    box = document.createElement('div');
    box.className = 'ocr-selection-box';
    box.style.position = 'absolute';
    box.style.border = '2px solid #1a73e8';
    box.style.background = 'rgba(26, 115, 232, 0.08)';
    box.style.boxShadow = '0 0 0 1px rgba(255, 255, 255, 0.8)';
    box.style.pointerEvents = 'none';
    box.style.boxSizing = 'border-box';
    box.style.display = 'none';

    const info = document.createElement('div');
    info.className = 'ocr-selection-info';
    info.textContent = UI.SELECTION_HINT;
    info.style.position = 'fixed';
    info.style.bottom = '30px';
    info.style.left = '50%';
    info.style.transform = 'translateX(-50%)';
    info.style.background = 'rgba(0,0,0,0.85)';
    info.style.color = 'white';
    info.style.padding = '12px 28px';
    info.style.borderRadius = '40px';
    info.style.fontSize = '15px';
    info.style.zIndex = '2147483648';
    info.style.pointerEvents = 'none';
    info.style.fontFamily = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';

    const cancel = document.createElement('div');
    cancel.className = 'ocr-cancel-hint';
    cancel.style.position = 'fixed';
    cancel.style.top = '20px';
    cancel.style.right = '30px';
    cancel.style.background = 'rgba(0,0,0,0.7)';
    cancel.style.color = 'white';
    cancel.style.padding = '8px 16px';
    cancel.style.borderRadius = '30px';
    cancel.style.fontSize = '13px';
    cancel.style.zIndex = '2147483648';
    cancel.style.pointerEvents = 'none';

    overlay.appendChild(box);
    overlay.appendChild(info);
    overlay.appendChild(cancel);
    document.documentElement.appendChild(overlay);

    overlay.addEventListener('mousedown', onMouseDown);
    overlay.addEventListener('touchstart', onTouchStart, { passive: false });
  }

  function removeOverlay() {
    if (overlay) {
      overlay.removeEventListener('mousedown', onMouseDown);
      overlay.remove();
      overlay = null;
      box = null;
    }
    document.removeEventListener('keydown', onKeyDown);
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
    document.removeEventListener('touchmove', onTouchMove);
    document.removeEventListener('touchend', onTouchEnd);

    try {
      document.documentElement.style.userSelect = prevDocUserSelect;
      document.body.style.userSelect = prevBodyUserSelect;
    } catch (_e) {
      // ignore
    }
  }

  function onKeyDown(e) {
    if (e.key === 'Escape') removeOverlay();
  }

  function onMouseDown(e) {
    e.preventDefault();
    isSelecting = true;
    startX = e.clientX;
    startY = e.clientY;
    box.style.display = 'block';
    box.style.left = `${startX}px`;
    box.style.top = `${startY}px`;
    box.style.width = '0px';
    box.style.height = '0px';

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    document.addEventListener('keydown', onKeyDown);
  }

  function onMouseMove(e) {
    if (!isSelecting) return;
    const curX = e.clientX;
    const curY = e.clientY;
    const left = Math.min(startX, curX);
    const top = Math.min(startY, curY);
    const width = Math.abs(curX - startX);
    const height = Math.abs(curY - startY);

    box.style.left = `${left}px`;
    box.style.top = `${top}px`;
    box.style.width = `${width}px`;
    box.style.height = `${height}px`;
  }

  function onMouseUp(e) {
    if (!isSelecting) return;
    isSelecting = false;
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);

    const endX = e.clientX;
    const endY = e.clientY;
    const left = Math.min(startX, endX);
    const top = Math.min(startY, endY);
    const width = Math.abs(endX - startX);
    const height = Math.abs(endY - startY);

    removeOverlay();

    if (width < CONFIG.MIN_SELECTION_SIZE || height < CONFIG.MIN_SELECTION_SIZE) return;
    requestCapture({
      left: Math.round(left),
      top: Math.round(top),
      width: Math.round(width),
      height: Math.round(height),
      dpr: window.devicePixelRatio || 1
    });
  }

  function onTouchStart(e) {
    e.preventDefault();
    const t = e.touches[0];
    isSelecting = true;
    startX = t.clientX;
    startY = t.clientY;
    box.style.display = 'block';
    box.style.left = `${startX}px`;
    box.style.top = `${startY}px`;
    box.style.width = '0px';
    box.style.height = '0px';

    document.addEventListener('touchmove', onTouchMove, { passive: false });
    document.addEventListener('touchend', onTouchEnd);
    document.addEventListener('keydown', onKeyDown);
  }

  function onTouchMove(e) {
    if (!isSelecting) return;
    const t = e.touches[0];
    const curX = t.clientX;
    const curY = t.clientY;
    const left = Math.min(startX, curX);
    const top = Math.min(startY, curY);
    const width = Math.abs(curX - startX);
    const height = Math.abs(curY - startY);

    box.style.left = `${left}px`;
    box.style.top = `${top}px`;
    box.style.width = `${width}px`;
    box.style.height = `${height}px`;
  }

  function onTouchEnd() {
    if (!isSelecting) return;
    isSelecting = false;
    document.removeEventListener('touchmove', onTouchMove);
    document.removeEventListener('touchend', onTouchEnd);

    const rect = box.getBoundingClientRect();
    const left = rect.left;
    const top = rect.top;
    const width = rect.width;
    const height = rect.height;

    removeOverlay();

    if (width < CONFIG.MIN_SELECTION_SIZE || height < CONFIG.MIN_SELECTION_SIZE) return;
    requestCapture({
      left: Math.round(left),
      top: Math.round(top),
      width: Math.round(width),
      height: Math.round(height),
      dpr: window.devicePixelRatio || 1
    });
  }

  function scheduleCaptureTimeout() {
    if (!pendingCapture) return;
    if (pendingCapture.timerId) clearTimeout(pendingCapture.timerId);

    pendingCapture.timerId = setTimeout(() => {
      if (!pendingCapture || pendingCapture.completed) return;
      if (pendingCapture.attempt >= CONFIG.CAPTURE_MAX_RETRY) {
        const detail = `请求超时（${CONFIG.CAPTURE_MAX_RETRY}次）`;
        showToast('error', `${UI.ERROR_CAPTURE}：${detail}`);
        clearPendingCapture();
        return;
      }
      attemptCaptureRequest();
    }, CONFIG.CAPTURE_TIMEOUT_MS);
  }

  function attemptCaptureRequest() {
    if (!pendingCapture || pendingCapture.completed) return;
    pendingCapture.attempt += 1;

    chrome.runtime.sendMessage(
      {
        type: MSG.REQUEST_CAPTURE,
        requestId: pendingCapture.id,
        bounds: pendingCapture.bounds
      },
      () => {
        if (!pendingCapture || pendingCapture.completed) return;
        if (chrome.runtime.lastError) {
          const canRetry = pendingCapture.attempt < CONFIG.CAPTURE_MAX_RETRY;
          if (!canRetry) {
            showToast('error', `${UI.ERROR_CAPTURE}：${chrome.runtime.lastError.message || '消息发送失败'}`);
            clearPendingCapture();
            return;
          }
          setTimeout(attemptCaptureRequest, CONFIG.CAPTURE_RETRY_DELAY_MS);
          return;
        }
        scheduleCaptureTimeout();
      }
    );
  }

  function requestCapture(bounds) {
    clearPendingCapture();
    pendingCapture = {
      id: createRequestId(),
      bounds,
      attempt: 0,
      timerId: null,
      completed: false
    };
    attemptCaptureRequest();
  }

  function handleCaptureResult(message) {
    if (!pendingCapture) return;
    if (message.requestId && message.requestId !== pendingCapture.id) return;

    if (pendingCapture.timerId) clearTimeout(pendingCapture.timerId);

    if (message.error) {
      const canRetry = pendingCapture.attempt < CONFIG.CAPTURE_MAX_RETRY;
      if (canRetry) {
        setTimeout(attemptCaptureRequest, CONFIG.CAPTURE_RETRY_DELAY_MS);
        return;
      }
      showToast('error', `${UI.ERROR_CAPTURE}：${message.error}`);
      clearPendingCapture();
      return;
    }

    pendingCapture.completed = true;
    const bounds = pendingCapture.bounds;
    clearPendingCapture();
    processCapturedImage(message.image, bounds);
  }

  function processCapturedImage(imageDataUrl, bounds) {
    const img = new Image();

    img.onload = async () => {
      try {
        const dpr = bounds.dpr || 1;
        const sx = bounds.left * dpr;
        const sy = bounds.top * dpr;
        const sw = bounds.width * dpr;
        const sh = bounds.height * dpr;

        const cropCanvas = document.createElement('canvas');
        cropCanvas.width = bounds.width;
        cropCanvas.height = bounds.height;
        const cctx = cropCanvas.getContext('2d', { willReadFrequently: true });
        cctx.drawImage(img, sx, sy, sw, sh, 0, 0, bounds.width, bounds.height);

        const recognized = await recognizeText(cropCanvas);
        const result = recognized.text;
        const finalResult = (result && result.trim()) ? result : UI.RESULT_EMPTY;

        chrome.storage.local.set({ lastResult: finalResult, lastImage: cropCanvas.toDataURL() });

        if (result && result.trim()) {
          navigator.clipboard.writeText(result).catch((err) => {
            console.error('复制失败:', err);
            showToast('warning', UI.ERROR_COPY);
          });
        }

        showResultPanel(finalResult, Boolean(result && result.trim()));
      } catch (err) {
        console.error('OCR failed in page:', err);
        showToast('error', `${UI.ERROR_OCR}：${err && err.message ? err.message : '处理异常'}`);
      }
    };

    img.onerror = () => {
      showToast('error', `${UI.ERROR_CAPTURE}：图像加载失败`);
    };

    img.src = imageDataUrl;
  }

  function showResultPanel(finalResult, autoCopied) {
    ensurePanelStyle();

    const oldPanel = document.querySelector('.ocr-result-panel');
    if (oldPanel) oldPanel.remove();

    const resultPanel = document.createElement('div');
    resultPanel.className = 'ocr-result-panel';
    resultPanel.style.cssText = `
      position: fixed;
      left: 50%;
      top: 30px;
      transform: translateX(-50%);
      z-index: 2147483647;
      background: #ffffff;
      color: #202124;
      padding: 16px 24px;
      border-radius: 16px;
      font-size: 15px;
      box-shadow: 0 10px 40px rgba(0,0,0,0.2);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      display: flex;
      flex-direction: column;
      gap: 12px;
      min-width: 320px;
      max-width: 85vw;
      border: 1px solid rgba(0,0,0,0.08);
      animation: slideDown 0.3s cubic-bezier(0.18, 0.89, 0.32, 1.28);
    `;

    resultPanel.innerHTML = `
      <div style="display: flex; justify-content: space-between; align-items: center;">
        <span style="font-weight: 600; color: #1a73e8; display: flex; align-items: center; gap: 6px;">
          <span style="font-size: 18px;">🔍</span> ${UI.PANEL_TITLE}
        </span>
        <button id="ocr-panel-close" style="background: none; border: none; font-size: 20px; cursor: pointer; color: #5f6368; line-height: 1;">&times;</button>
      </div>
      <div id="ocr-result-text" style="background: #f8f9fa; padding: 14px; border-radius: 10px; font-family: 'Courier New', monospace; font-size: 22px; font-weight: 600; word-break: break-all; border: 1px solid #e8eaed; text-align: center; color: ${finalResult.includes('?') ? '#d93025' : '#202124'};">
        ${finalResult}
      </div>
      <div id="ocr-debug-area" style="display: none; padding-top: 8px; border-top: 1px dashed #ddd;">
        <div style="font-size: 11px; color: #70757a; margin-bottom: 6px;">${UI.DEBUG_NOTE}</div>
        <div id="ocr-debug-view" style="display: flex; overflow-x: auto; padding-bottom: 4px;"></div>
      </div>
      <div style="display: flex; gap: 8px; justify-content: flex-end; align-items: center;">
        <span id="ocr-copy-status" style="font-size: 12px; color: #1e8e3e; margin-right: auto; opacity: 0; transition: opacity 0.2s;">${UI.COPY_OK}</span>
        <button id="ocr-toggle-debug" style="background: none; border: none; color: #1a73e8; font-size: 11px; cursor: pointer; text-decoration: underline;">${UI.SHOW_DEBUG}</button>
        <button id="ocr-panel-copy" class="ocr-panel-btn" style="background: #fff; border: 1px solid #dadce0; padding: 6px 16px; border-radius: 8px; cursor: pointer; font-size: 13px; font-weight: 500; color: #1a73e8; transition: all 0.2s;">${UI.COPY_BUTTON}</button>
      </div>
    `;

    document.documentElement.appendChild(resultPanel);

    const debugArea = resultPanel.querySelector('#ocr-debug-area');
    const debugView = resultPanel.querySelector('#ocr-debug-view');
    const toggleBtn = resultPanel.querySelector('#ocr-toggle-debug');

    if (finalResult.includes('?')) {
      debugArea.style.display = 'block';
      toggleBtn.textContent = UI.HIDE_DEBUG;
    }

    toggleBtn.onclick = () => {
      const toShow = debugArea.style.display === 'none';
      debugArea.style.display = toShow ? 'block' : 'none';
      toggleBtn.textContent = toShow ? UI.HIDE_DEBUG : UI.SHOW_DEBUG;
    };

    if (typeof ocrEngine !== 'undefined') {
      const currentChars = ocrEngine.__lastChars || [];
      currentChars.forEach((char) => {
        const c = document.createElement('canvas');
        c.width = char.width;
        c.height = char.height;
        c.className = 'ocr-debug-canvas';
        c.style.height = '32px';
        c.style.width = 'auto';
        const cc = c.getContext('2d');
        const id = cc.createImageData(char.width, char.height);
        for (let j = 0; j < char.data.length; j++) {
          const val = char.data[j];
          id.data[j * 4] = val;
          id.data[j * 4 + 1] = val;
          id.data[j * 4 + 2] = val;
          id.data[j * 4 + 3] = 255;
        }
        cc.putImageData(id, 0, 0);
        debugView.appendChild(c);
      });
    }

    resultPanel.querySelector('#ocr-panel-close').onclick = () => resultPanel.remove();

    resultPanel.querySelector('#ocr-panel-copy').onclick = () => {
      navigator.clipboard.writeText(finalResult).then(() => {
        const status = resultPanel.querySelector('#ocr-copy-status');
        status.style.opacity = '1';
        setTimeout(() => {
          status.style.opacity = '0';
        }, CONFIG.COPY_STATUS_MS);
      }).catch((err) => {
        console.error('手动复制失败:', err);
        showToast('warning', UI.ERROR_COPY);
      });
    };

    if (autoCopied) {
      const status = resultPanel.querySelector('#ocr-copy-status');
      status.style.opacity = '1';
      setTimeout(() => {
        status.style.opacity = '0';
      }, CONFIG.AUTO_COPY_STATUS_MS);
    }

    if (!finalResult.includes('?')) {
      setTimeout(() => {
        if (resultPanel.parentNode) resultPanel.remove();
      }, CONFIG.RESULT_AUTO_CLOSE_MS);
    }
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || !message.type) return;

    if (message.type === MSG.PING_SELECTION) {
      sendResponse({ ready: true });
      return;
    }

    if (message.type === MSG.START_SELECTION) {
      try {
        createOverlay();
        sendResponse({ started: true });
      } catch (err) {
        console.error('selection.js failed to start selection:', err);
        sendResponse({ started: false, error: err && err.message ? err.message : 'START_FAILED' });
      }
      return;
    }

    if (message.type === MSG.CAPTURE_RESULT) {
      handleCaptureResult(message);
      sendResponse({ received: true });
    }
  });
})();
