(function () {
  'use strict';

  const CONFIG = {
    FRAME_INTERVAL: 100,
    STABLE_DURATION: 800,
    CHANGE_THRESHOLD: 0.15,
    STABLE_THRESHOLD: 0.05,
    DUPLICATE_THRESHOLD: 0.05,
    COMPARE_SIZE: 100,
    MAX_RESOLUTION: 1920,
    CAPTURE_WIDTH: 1920,
    CAPTURE_HEIGHT: 1080,
    OPENCV_LOAD_TIMEOUT: 30000,
  };

  const STATE = { IDLE: 'idle', TURNING: 'turning', STABLE: 'stable', PAUSED: 'paused' };

  const OPENCV_MIRRORS = [
    'https://docs.opencv.org/4.9.0/opencv.js',
    'https://cdn.bootcdn.net/ajax/libs/opencv.js/4.9.0/opencv.js',
    'https://cdn.staticfile.net/opencv.js/4.9.0/opencv.js',
  ];

  let currentState = STATE.IDLE;
  let stableStart = 0;
  let lastFrameData = null;
  let lastCapturedData = null;
  let captures = [];
  let paused = false;
  let running = false;
  let wakeLock = null;
  let cvReady = false;
  let cvLoading = false;
  let lastProcessTime = 0;

  const video = document.getElementById('video');
  const overlayCanvas = document.getElementById('overlayCanvas');
  const overlayCtx = overlayCanvas.getContext('2d', { willReadFrequently: true });

  const processCanvas = document.createElement('canvas');
  const processCtx = processCanvas.getContext('2d', { willReadFrequently: true });

  const captureCanvas = document.createElement('canvas');
  const captureCtx = captureCanvas.getContext('2d');

  const $startScreen = document.getElementById('startScreen');
  const $loading = document.getElementById('loadingOverlay');
  const $loadingText = document.getElementById('loadingText');
  const $flash = document.getElementById('flashOverlay');
  const $statusDot = document.getElementById('statusDot');
  const $statusText = document.getElementById('statusText');
  const $captureCount = document.getElementById('captureCount');
  const $btnManual = document.getElementById('btnManual');
  const $btnPause = document.getElementById('btnPause');
  const $btnExport = document.getElementById('btnExport');
  const $btnClear = document.getElementById('btnClear');
  const $thumbBar = document.getElementById('thumbBar');
  const $thumbEmpty = document.getElementById('thumbEmpty');

  document.getElementById('btnStart').addEventListener('click', startApp);
  $btnManual.addEventListener('click', manualCapture);
  $btnPause.addEventListener('click', togglePause);
  $btnExport.addEventListener('click', exportImages);
  $btnClear.addEventListener('click', clearAll);

  async function startApp() {
    document.getElementById('btnStart').disabled = true;
    $startScreen.style.display = 'none';
    $loading.classList.add('show');

    try {
      $loadingText.textContent = '正在启动摄像头...';
      await startCamera();
      $loading.classList.remove('show');

      requestWakeLock();
      startDetectionLoop();

      loadOpenCVAsync();
    } catch (err) {
      $loading.classList.remove('show');
      alert('启动失败: ' + err.message);
      document.getElementById('btnStart').disabled = false;
      $startScreen.style.display = '';
    }
  }

  async function startCamera() {
    var constraints = {
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: CONFIG.CAPTURE_WIDTH },
        height: { ideal: CONFIG.CAPTURE_HEIGHT },
      },
      audio: false,
    };

    var stream = await navigator.mediaDevices.getUserMedia(constraints);

    try {
      var track = stream.getVideoTracks()[0];
      var capabilities = track.getCapabilities ? track.getCapabilities() : {};
      var settings = {};
      if (capabilities.focusMode && capabilities.focusMode.includes('continuous')) {
        settings.focusMode = 'continuous';
      }
      if (Object.keys(settings).length > 0) {
        await track.applyConstraints({ advanced: [settings] });
      }
    } catch (_) {}

    video.srcObject = stream;
    await new Promise((resolve, reject) => {
      video.onloadedmetadata = () => {
        video.play().then(resolve).catch(reject);
      };
      video.onerror = reject;
    });
  }
      }

      if (!deviceId && backDevices.length > 0) {
        var testStream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment', width: { ideal: 640 }, height: { ideal: 480 } },
          audio: false,
        });
        var mainTrack = testStream.getVideoTracks()[0];
        var mainSettings = mainTrack.getSettings();
        var mainDeviceId = mainSettings.deviceId;
        testStream.getTracks().forEach(function (t) { t.stop(); });

        for (var i = 0; i < backDevices.length; i++) {
          if (backDevices[i].deviceId !== mainDeviceId) {
            deviceId = backDevices[i].deviceId;
            break;
          }
        }
      }
    }

    var constraints;
    if (deviceId) {
      constraints = {
        video: {
          deviceId: { exact: deviceId },
          width: { ideal: CONFIG.CAPTURE_WIDTH },
          height: { ideal: CONFIG.CAPTURE_HEIGHT },
        },
        audio: false,
      };
    } else {
      constraints = {
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: CONFIG.CAPTURE_WIDTH },
          height: { ideal: CONFIG.CAPTURE_HEIGHT },
        },
        audio: false,
      };
    }

    var stream = await navigator.mediaDevices.getUserMedia(constraints);

    try {
      var track = stream.getVideoTracks()[0];
      var capabilities = track.getCapabilities ? track.getCapabilities() : {};
      var settings = {};
      if (capabilities.focusMode && capabilities.focusMode.indexOf('continuous') !== -1) {
        settings.focusMode = 'continuous';
      }
      if (Object.keys(settings).length > 0) {
        await track.applyConstraints({ advanced: [settings] });
      }
    } catch (_) {}

    video.srcObject = stream;
    await new Promise(function (resolve, reject) {
      video.onloadedmetadata = function () {
        video.play().then(resolve).catch(reject);
      };
      video.onerror = reject;
    });
  }

  function loadOpenCVAsync() {
    if (typeof cv !== 'undefined' && cv.Mat) {
      cvReady = true;
      updateStatusUI('idle', '智能矫正已就绪');
      return;
    }

    if (cvLoading) return;
    cvLoading = true;

    loadScriptFromMirrors(OPENCV_MIRRORS)
      .then(() => waitForOpenCVReady())
      .then(() => {
        cvReady = true;
        cvLoading = false;
        updateStatusUI('idle', '智能矫正已就绪');
      })
      .catch((err) => {
        cvLoading = false;
        console.warn('OpenCV 加载失败，将使用无矫正模式:', err);
        updateStatusUI('idle', '基础模式（无自动矫正）');
      });
  }

  function loadScriptFromMirrors(urls) {
    return new Promise((resolve, reject) => {
      let idx = 0;

      function tryNext() {
        if (idx >= urls.length) {
          reject(new Error('所有镜像加载失败'));
          return;
        }

        const url = urls[idx++];
        const script = document.createElement('script');
        script.src = url;
        script.async = true;

        const timer = setTimeout(() => {
          cleanup();
          tryNext();
        }, CONFIG.OPENCV_LOAD_TIMEOUT);

        function cleanup() {
          clearTimeout(timer);
          script.onload = null;
          script.onerror = null;
          if (script.parentNode) script.parentNode.removeChild(script);
        }

        script.onload = () => {
          cleanup();
          resolve();
        };

        script.onerror = () => {
          cleanup();
          tryNext();
        };

        document.head.appendChild(script);
      }

      tryNext();
    });
  }

  function waitForOpenCVReady() {
    return new Promise((resolve, reject) => {
      if (typeof cv !== 'undefined' && cv.Mat) {
        resolve();
        return;
      }

      const timeout = setTimeout(() => {
        clearInterval(check);
        reject(new Error('OpenCV 初始化超时'));
      }, 60000);

      const check = setInterval(() => {
        if (typeof cv !== 'undefined' && cv.Mat) {
          clearInterval(check);
          clearTimeout(timeout);
          resolve();
        }
      }, 200);

      if (typeof cv !== 'undefined' && typeof cv.onRuntimeInitialized !== 'undefined') {
        const origCallback = cv.onRuntimeInitialized;
        cv.onRuntimeInitialized = function () {
          if (origCallback) origCallback();
          clearInterval(check);
          clearTimeout(timeout);
          resolve();
        };
      }
    });
  }

  async function requestWakeLock() {
    try {
      if ('wakeLock' in navigator) {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
      }
    } catch (_) {}
  }

  function startDetectionLoop() {
    running = true;
    requestAnimationFrame(detectionLoop);
  }

  function detectionLoop(timestamp) {
    if (!running) return;

    const elapsed = timestamp - lastProcessTime;
    if (elapsed >= CONFIG.FRAME_INTERVAL && !paused && video.readyState >= 2) {
      lastProcessTime = timestamp;
      processFrame();
    }

    requestAnimationFrame(detectionLoop);
  }

  function processFrame() {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return;

    if (processCanvas.width !== vw || processCanvas.height !== vh) {
      processCanvas.width = vw;
      processCanvas.height = vh;
      overlayCanvas.width = vw;
      overlayCanvas.height = vh;
    }

    processCtx.drawImage(video, 0, 0, vw, vh);
    const currentFrame = processCtx.getImageData(0, 0, vw, vh);

    if (currentState === STATE.PAUSED) return;

    const changeRatio = computeChange(currentFrame.data, lastFrameData, vw, vh);
    lastFrameData = new Uint8ClampedArray(currentFrame.data);

    overlayCtx.clearRect(0, 0, vw, vh);

    if (changeRatio > CONFIG.CHANGE_THRESHOLD) {
      currentState = STATE.TURNING;
      stableStart = 0;
      updateStatusUI('turning', '翻页检测中...');
    } else if (currentState === STATE.TURNING) {
      if (changeRatio < CONFIG.STABLE_THRESHOLD) {
        if (!stableStart) {
          stableStart = performance.now();
        } else if (performance.now() - stableStart >= CONFIG.STABLE_DURATION) {
          performCapture(currentFrame, vw, vh);
          currentState = STATE.IDLE;
          stableStart = 0;
        }
      } else {
        stableStart = 0;
      }
    } else {
      if (!cvReady && !cvLoading) {
        updateStatusUI('idle', '基础模式 · 等待翻页...');
      } else if (cvLoading) {
        updateStatusUI('idle', '矫正引擎加载中 · 等待翻页...');
      } else {
        updateStatusUI('idle', '等待翻页...');
      }
    }

    if (cvReady && (currentState === STATE.IDLE || currentState === STATE.TURNING)) {
      drawDocumentOverlay();
    }
  }

  function computeChange(current, previous, w, h) {
    if (!previous) return 0;

    const step = 4 * 8;
    const totalSamples = Math.floor((w * h * 4) / step);
    let diffCount = 0;

    for (let i = 0; i < current.length; i += step) {
      const g1 = current[i] * 0.299 + current[i + 1] * 0.587 + current[i + 2] * 0.114;
      const g2 = previous[i] * 0.299 + previous[i + 1] * 0.587 + previous[i + 2] * 0.114;
      if (Math.abs(g1 - g2) > 30) diffCount++;
    }

    return diffCount / totalSamples;
  }

  function performCapture(frameData, w, h) {
    captureCanvas.width = w;
    captureCanvas.height = h;
    captureCtx.putImageData(frameData, 0, 0);

    let finalDataUrl;

    if (cvReady) {
      try {
        const correctedDataUrl = DocScanner.detectAndCorrect(captureCanvas);
        if (correctedDataUrl) {
          finalDataUrl = correctedDataUrl;
        } else {
          finalDataUrl = captureCanvas.toDataURL('image/jpeg', 0.92);
        }
      } catch (e) {
        console.warn('透视矫正失败，保存原图', e);
        finalDataUrl = captureCanvas.toDataURL('image/jpeg', 0.92);
      }
    } else {
      finalDataUrl = captureCanvas.toDataURL('image/jpeg', 0.92);
    }

    if (isDuplicate(finalDataUrl)) {
      updateStatusUI('idle', '重复页面，跳过');
      return;
    }

    addCapture(finalDataUrl);
    flashEffect();
    updateStatusUI('idle', '已抓拍！');
  }

  function isDuplicate(dataUrl) {
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = CONFIG.COMPARE_SIZE;
    tempCanvas.height = CONFIG.COMPARE_SIZE;
    const tempCtx = tempCanvas.getContext('2d');

    tempCtx.drawImage(captureCanvas, 0, 0, CONFIG.COMPARE_SIZE, CONFIG.COMPARE_SIZE);
    const current = tempCtx.getImageData(0, 0, CONFIG.COMPARE_SIZE, CONFIG.COMPARE_SIZE);

    if (!lastCapturedData) {
      lastCapturedData = new Uint8ClampedArray(current.data);
      return false;
    }

    const data = current.data;
    let diffCount = 0;
    const totalPixels = CONFIG.COMPARE_SIZE * CONFIG.COMPARE_SIZE;

    for (let i = 0; i < data.length; i += 4) {
      const g1 = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
      const g2 = lastCapturedData[i] * 0.299 + lastCapturedData[i + 1] * 0.587 + lastCapturedData[i + 2] * 0.114;
      if (Math.abs(g1 - g2) > 25) diffCount++;
    }

    lastCapturedData = new Uint8ClampedArray(data);
    return (diffCount / totalPixels) < CONFIG.DUPLICATE_THRESHOLD;
  }

  function manualCapture() {
    if (video.readyState < 2) return;
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    processCtx.drawImage(video, 0, 0, vw, vh);
    const frameData = processCtx.getImageData(0, 0, vw, vh);
    performCapture(frameData, vw, vh);
  }

  function addCapture(dataUrl) {
    captures.push(dataUrl);
    $captureCount.textContent = captures.length;
    $btnExport.disabled = false;
    $btnClear.disabled = false;

    $thumbEmpty.style.display = 'none';

    const idx = captures.length - 1;
    const item = document.createElement('div');
    item.className = 'thumb-item';

    const img = document.createElement('img');
    img.src = dataUrl;
    item.appendChild(img);

    const del = document.createElement('button');
    del.className = 'thumb-delete';
    del.textContent = '✕';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      captures.splice(idx, 1);
      item.remove();
      $captureCount.textContent = captures.length;
      if (captures.length === 0) {
        $thumbEmpty.style.display = '';
        $btnExport.disabled = true;
        $btnClear.disabled = true;
        lastCapturedData = null;
      }
    });
    item.appendChild(del);

    $thumbBar.appendChild(item);
    $thumbBar.scrollLeft = $thumbBar.scrollWidth;
  }

  function flashEffect() {
    $flash.classList.add('flash');
    setTimeout(() => $flash.classList.remove('flash'), 120);
  }

  function updateStatusUI(state, text) {
    $statusDot.className = 'status-dot';
    if (state === 'idle') $statusDot.classList.add('active');
    else if (state === 'turning') $statusDot.classList.add('turning');
    $statusText.textContent = text;
  }

  function togglePause() {
    paused = !paused;
    if (paused) {
      currentState = STATE.PAUSED;
      $btnPause.textContent = '▶ 继续';
      $btnPause.classList.remove('secondary');
      $btnPause.classList.add('primary');
      updateStatusUI('idle', '已暂停');
    } else {
      currentState = STATE.IDLE;
      lastFrameData = null;
      $btnPause.textContent = '⏸ 暂停';
      $btnPause.classList.remove('primary');
      $btnPause.classList.add('secondary');
      updateStatusUI('idle', '等待翻页...');
    }
  }

  async function exportImages() {
    if (captures.length === 0) return;

    $btnExport.disabled = true;
    $btnExport.textContent = '⏳ 打包中...';

    try {
      if (typeof JSZip === 'undefined') {
        for (let i = 0; i < captures.length; i++) {
          const a = document.createElement('a');
          a.href = captures[i];
          a.download = `page_${String(i + 1).padStart(3, '0')}.jpg`;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
        }
      } else {
        const zip = new JSZip();
        const folder = zip.folder('scanned_docs');

        for (let i = 0; i < captures.length; i++) {
          const base64 = captures[i].split(',')[1];
          folder.file(`page_${String(i + 1).padStart(3, '0')}.jpg`, base64, { base64: true });
        }

        const blob = await zip.generateAsync({ type: 'blob' });
        const url = URL.createObjectURL(blob);

        const a = document.createElement('a');
        a.href = url;
        a.download = `扫描文档_${new Date().toISOString().slice(0, 10)}.zip`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }
    } catch (e) {
      alert('导出失败: ' + e.message);
    }

    $btnExport.disabled = false;
    $btnExport.textContent = '📥 导出';
  }

  function clearAll() {
    if (!confirm('确定清空所有抓拍？')) return;
    captures = [];
    lastCapturedData = null;
    $captureCount.textContent = '0';
    $btnExport.disabled = true;
    $btnClear.disabled = true;
    $thumbBar.querySelectorAll('.thumb-item').forEach(el => el.remove());
    $thumbEmpty.style.display = '';
  }

  function drawDocumentOverlay() {
    try {
      const corners = DocScanner.detectCorners(processCanvas);
      if (corners && corners.length === 4) {
        overlayCtx.strokeStyle = 'rgba(0, 212, 255, 0.7)';
        overlayCtx.lineWidth = 3;
        overlayCtx.setLineDash([8, 4]);
        overlayCtx.beginPath();
        overlayCtx.moveTo(corners[0].x, corners[0].y);
        for (let i = 1; i < 4; i++) {
          overlayCtx.lineTo(corners[i].x, corners[i].y);
        }
        overlayCtx.closePath();
        overlayCtx.stroke();
        overlayCtx.setLineDash([]);

        corners.forEach(c => {
          overlayCtx.fillStyle = 'rgba(0, 212, 255, 0.9)';
          overlayCtx.beginPath();
          overlayCtx.arc(c.x, c.y, 6, 0, Math.PI * 2);
          overlayCtx.fill();
        });
      }
    } catch (_) {}
  }

  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'visible' && running) {
      await requestWakeLock();
    }
  });

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
