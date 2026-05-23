(function () {
  'use strict';

  var CONFIG = {
    FRAME_INTERVAL: 100,
    OVERLAY_INTERVAL: 500,   // overlay 检测降频，每 500ms 跑一次
    STABLE_DURATION: 800,
    CHANGE_THRESHOLD: 0.15,
    STABLE_THRESHOLD: 0.05,
    DUPLICATE_THRESHOLD: 0.05,
    COMPARE_SIZE: 100,
    CAPTURE_WIDTH: 1440,
    CAPTURE_HEIGHT: 1920,
    OPENCV_LOAD_TIMEOUT: 30000,
  };

  var STATE = { IDLE: 'idle', TURNING: 'turning', PAUSED: 'paused' };

  var OPENCV_MIRRORS = [
    'https://docs.opencv.org/4.9.0/opencv.js',
    'https://cdn.bootcdn.net/ajax/libs/opencv.js/4.9.0/opencv.js',
    'https://cdn.staticfile.net/opencv.js/4.9.0/opencv.js',
  ];

  var currentState = STATE.IDLE;
  var stableStart = 0;
  var lastFrameData = null;
  var lastCapturedData = null;
  var captures = [];
  var paused = false;
  var running = false;
  var wakeLock = null;
  var cvReady = false;
  var cvLoading = false;
  var lastProcessTime = 0;
  var lastOverlayTime = 0;

  var video = document.getElementById('video');
  var overlayCanvas = document.getElementById('overlayCanvas');
  var overlayCtx = overlayCanvas.getContext('2d', { willReadFrequently: true });

  var processCanvas = document.createElement('canvas');
  var processCtx = processCanvas.getContext('2d', { willReadFrequently: true });

  var captureCanvas = document.createElement('canvas');
  var captureCtx = captureCanvas.getContext('2d');

  var $startScreen = document.getElementById('startScreen');
  var $loading = document.getElementById('loadingOverlay');
  var $loadingText = document.getElementById('loadingText');
  var $flash = document.getElementById('flashOverlay');
  var $statusDot = document.getElementById('statusDot');
  var $statusText = document.getElementById('statusText');
  var $captureCount = document.getElementById('captureCount');
  var $btnManual = document.getElementById('btnManual');
  var $btnPause = document.getElementById('btnPause');
  var $btnExport = document.getElementById('btnExport');
  var $btnClear = document.getElementById('btnClear');
  var $thumbBar = document.getElementById('thumbBar');
  var $thumbEmpty = document.getElementById('thumbEmpty');

  document.getElementById('btnStart').addEventListener('click', startApp);
  $btnManual.addEventListener('click', manualCapture);
  $btnPause.addEventListener('click', togglePause);
  $btnExport.addEventListener('click', exportImages);
  $btnClear.addEventListener('click', clearAll);

  // ── 启动 ──────────────────────────────────────────────

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
      alert('摄像头启动失败: ' + err.message);
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

    // 开启持续对焦（不支持则静默忽略）
    try {
      var track = stream.getVideoTracks()[0];
      var caps = track.getCapabilities ? track.getCapabilities() : {};
      if (caps.focusMode && caps.focusMode.indexOf('continuous') !== -1) {
        await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] });
      }
    } catch (_) {}

    video.srcObject = stream;
    await new Promise(function (resolve, reject) {
      video.onloadedmetadata = function () {
        video.play().then(resolve).catch(reject);
      };
      video.onerror = reject;
    });

    // 显示摄像头实际分辨率，方便调试
    var track = stream.getVideoTracks()[0];
    var settings = track.getSettings ? track.getSettings() : {};
    var label = track.label || '';
    var w = settings.width || video.videoWidth;
    var h = settings.height || video.videoHeight;
    var camInfo = document.getElementById('camInfo');
    if (camInfo) {
      camInfo.textContent = w + 'x' + h + (label ? '  ' + label.substring(0, 20) : '');
    }
  }

  // ── OpenCV 异步加载 ───────────────────────────────────

  function loadOpenCVAsync() {
    if (typeof cv !== 'undefined' && cv.Mat) {
      cvReady = true;
      updateStatusUI('idle', '智能矫正已就绪');
      return;
    }
    if (cvLoading) return;
    cvLoading = true;

    loadScriptFromMirrors(OPENCV_MIRRORS)
      .then(function () { return waitForOpenCVReady(); })
      .then(function () {
        cvReady = true;
        cvLoading = false;
        updateStatusUI('idle', '智能矫正已就绪');
      })
      .catch(function (err) {
        cvLoading = false;
        console.warn('OpenCV 加载失败，使用无矫正模式:', err);
        updateStatusUI('idle', '基础模式（无自动矫正）');
      });
  }

  function loadScriptFromMirrors(urls) {
    return new Promise(function (resolve, reject) {
      var idx = 0;

      function tryNext() {
        if (idx >= urls.length) { reject(new Error('所有镜像均加载失败')); return; }

        var url = urls[idx++];
        var script = document.createElement('script');
        script.src = url;
        script.async = true;

        var timer = setTimeout(function () { cleanup(); tryNext(); }, CONFIG.OPENCV_LOAD_TIMEOUT);

        function cleanup() {
          clearTimeout(timer);
          script.onload = null;
          script.onerror = null;
          if (script.parentNode) script.parentNode.removeChild(script);
        }

        script.onload = function () { cleanup(); resolve(); };
        script.onerror = function () { cleanup(); tryNext(); };
        document.head.appendChild(script);
      }

      tryNext();
    });
  }

  function waitForOpenCVReady() {
    return new Promise(function (resolve, reject) {
      if (typeof cv !== 'undefined' && cv.Mat) { resolve(); return; }

      var done = false;
      var timeout = setTimeout(function () {
        if (!done) { done = true; clearInterval(poll); reject(new Error('OpenCV 初始化超时')); }
      }, 60000);

      var poll = setInterval(function () {
        if (typeof cv !== 'undefined' && cv.Mat) {
          if (!done) { done = true; clearInterval(poll); clearTimeout(timeout); resolve(); }
        }
      }, 200);

      // 同时挂 onRuntimeInitialized 回调
      if (typeof cv !== 'undefined') {
        var orig = cv.onRuntimeInitialized;
        cv.onRuntimeInitialized = function () {
          if (orig) orig();
          if (!done) { done = true; clearInterval(poll); clearTimeout(timeout); resolve(); }
        };
      }
    });
  }

  // ── 防息屏 ────────────────────────────────────────────

  async function requestWakeLock() {
    try {
      if ('wakeLock' in navigator) {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', function () { wakeLock = null; });
      }
    } catch (_) {}
  }

  // ── 检测主循环 ────────────────────────────────────────

  function startDetectionLoop() {
    running = true;
    requestAnimationFrame(detectionLoop);
  }

  function detectionLoop(timestamp) {
    if (!running) return;

    if (!paused && video.readyState >= 2 && timestamp - lastProcessTime >= CONFIG.FRAME_INTERVAL) {
      lastProcessTime = timestamp;
      processFrame(timestamp);
    }

    requestAnimationFrame(detectionLoop);
  }

  function processFrame(timestamp) {
    var vw = video.videoWidth;
    var vh = video.videoHeight;
    if (!vw || !vh) return;

    if (processCanvas.width !== vw || processCanvas.height !== vh) {
      processCanvas.width = vw;
      processCanvas.height = vh;
      overlayCanvas.width = vw;
      overlayCanvas.height = vh;
    }

    processCtx.drawImage(video, 0, 0, vw, vh);
    var currentFrame = processCtx.getImageData(0, 0, vw, vh);

    var changeRatio = computeChange(currentFrame.data, lastFrameData);
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
      currentState = STATE.IDLE;
      if (cvLoading) {
        updateStatusUI('idle', '矫正引擎加载中...');
      } else {
        updateStatusUI('idle', '等待翻页...');
      }
    }

    // overlay 检测降频：每 OVERLAY_INTERVAL ms 跑一次，避免每帧都跑 OpenCV
    if (cvReady && timestamp - lastOverlayTime >= CONFIG.OVERLAY_INTERVAL) {
      lastOverlayTime = timestamp;
      drawDocumentOverlay();
    }
  }

  // ── 帧差分 ────────────────────────────────────────────

  function computeChange(current, previous) {
    if (!previous || current.length !== previous.length) return 0;

    var step = 4 * 8;   // 每 8 像素采样一次，够精度又快
    var total = 0;
    var diff = 0;

    for (var i = 0; i < current.length; i += step) {
      var g1 = current[i] * 0.299 + current[i + 1] * 0.587 + current[i + 2] * 0.114;
      var g2 = previous[i] * 0.299 + previous[i + 1] * 0.587 + previous[i + 2] * 0.114;
      if (Math.abs(g1 - g2) > 30) diff++;
      total++;
    }

    return total > 0 ? diff / total : 0;
  }

  // ── 抓拍与裁剪 ────────────────────────────────────────

  function performCapture(frameData, w, h) {
    captureCanvas.width = w;
    captureCanvas.height = h;
    captureCtx.putImageData(frameData, 0, 0);

    // 透视矫正：detectAndCorrect 直接返回已绘制好的 canvas，无需走 Image 异步加载
    var sourceCanvas = captureCanvas;
    if (cvReady) {
      try {
        var corrected = DocScanner.detectAndCorrectCanvas(captureCanvas);
        if (corrected) sourceCanvas = corrected;
      } catch (e) {
        console.warn('透视矫正失败，保存原图:', e);
      }
    }

    sourceCanvas = cropToTargetRatio(sourceCanvas);

    if (isDuplicate(sourceCanvas)) {
      updateStatusUI('idle', '重复页面，已跳过');
      return;
    }

    var finalDataUrl = sourceCanvas.toDataURL('image/jpeg', 0.92);
    addCapture(finalDataUrl);
    flashEffect();
    updateStatusUI('idle', '已抓拍！');
  }

  function cropToTargetRatio(src) {
    var sw = src.width;
    var sh = src.height;
    // 3:4 竖向（宽:高），与 A4 纸比例接近
    var targetW = 3, targetH = 4;
    var targetRatio = targetW / targetH;
    var currentRatio = sw / sh;

    var cropW, cropH, cropX, cropY;

    if (Math.abs(currentRatio - targetRatio) < 0.04) {
      // 已经接近 3:4，直接限制最大尺寸
      cropW = sw; cropH = sh; cropX = 0; cropY = 0;
    } else if (currentRatio > targetRatio) {
      // 原图太宽（如 4:3、16:9、1:1），左右居中裁
      cropH = sh;
      cropW = Math.round(sh * targetRatio);
      cropX = Math.round((sw - cropW) / 2);
      cropY = 0;
    } else {
      // 原图太高，上下居中裁
      cropW = sw;
      cropH = Math.round(sw / targetRatio);
      // 确保裁剪高度不超过原图
      cropH = Math.min(cropH, sh);
      cropX = 0;
      cropY = Math.round((sh - cropH) / 2);
    }

    // 限制最大输出尺寸：高度不超过 2560
    var outH = Math.min(cropH, 2560);
    var outW = Math.round(outH * targetRatio);

    var out = document.createElement('canvas');
    out.width = outW;
    out.height = outH;
    out.getContext('2d').drawImage(src, cropX, cropY, cropW, cropH, 0, 0, outW, outH);
    return out;
  }

  // ── 去重 ──────────────────────────────────────────────

  function isDuplicate(srcCanvas) {
    var sz = CONFIG.COMPARE_SIZE;
    var tmp = document.createElement('canvas');
    tmp.width = sz;
    tmp.height = sz;
    tmp.getContext('2d').drawImage(srcCanvas, 0, 0, sz, sz);
    var data = tmp.getContext('2d').getImageData(0, 0, sz, sz).data;

    if (!lastCapturedData) {
      lastCapturedData = new Uint8ClampedArray(data);
      return false;
    }

    var diff = 0;
    var total = sz * sz;
    for (var i = 0; i < data.length; i += 4) {
      var g1 = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
      var g2 = lastCapturedData[i] * 0.299 + lastCapturedData[i + 1] * 0.587 + lastCapturedData[i + 2] * 0.114;
      if (Math.abs(g1 - g2) > 25) diff++;
    }

    lastCapturedData = new Uint8ClampedArray(data);
    return (diff / total) < CONFIG.DUPLICATE_THRESHOLD;
  }

  // ── 手动拍照 ──────────────────────────────────────────

  function manualCapture() {
    if (video.readyState < 2) return;
    var vw = video.videoWidth;
    var vh = video.videoHeight;
    processCtx.drawImage(video, 0, 0, vw, vh);
    var frameData = processCtx.getImageData(0, 0, vw, vh);
    performCapture(frameData, vw, vh);
  }

  // ── 缩略图管理 ────────────────────────────────────────

  function addCapture(dataUrl) {
    var idx = captures.length;
    captures.push(dataUrl);

    $captureCount.textContent = captures.length;
    $btnExport.disabled = false;
    $btnClear.disabled = false;
    $thumbEmpty.style.display = 'none';

    var item = document.createElement('div');
    item.className = 'thumb-item';

    var img = document.createElement('img');
    img.src = dataUrl;
    item.appendChild(img);

    var del = document.createElement('button');
    del.className = 'thumb-delete';
    del.textContent = '✕';
    del.addEventListener('click', function (e) {
      e.stopPropagation();
      // 用 item 在 DOM 中的位置倒推实际索引，避免闭包 idx 错位
      var items = $thumbBar.querySelectorAll('.thumb-item');
      var domIdx = Array.prototype.indexOf.call(items, item);
      if (domIdx !== -1) captures.splice(domIdx, 1);
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

  // ── UI 工具 ───────────────────────────────────────────

  function flashEffect() {
    $flash.classList.add('flash');
    setTimeout(function () { $flash.classList.remove('flash'); }, 120);
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

  // ── 导出 ──────────────────────────────────────────────

  async function exportImages() {
    if (captures.length === 0) return;

    $btnExport.disabled = true;
    $btnExport.textContent = '⏳ 打包中...';

    try {
      if (typeof JSZip !== 'undefined') {
        var zip = new JSZip();
        var folder = zip.folder('scanned_docs');
        for (var i = 0; i < captures.length; i++) {
          var base64 = captures[i].split(',')[1];
          folder.file('page_' + String(i + 1).padStart(3, '0') + '.jpg', base64, { base64: true });
        }
        var blob = await zip.generateAsync({ type: 'blob' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = '扫描文档_' + new Date().toISOString().slice(0, 10) + '.zip';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      } else {
        // JSZip 未加载则逐张下载
        for (var i = 0; i < captures.length; i++) {
          var a = document.createElement('a');
          a.href = captures[i];
          a.download = 'page_' + String(i + 1).padStart(3, '0') + '.jpg';
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
        }
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
    $thumbBar.querySelectorAll('.thumb-item').forEach(function (el) { el.remove(); });
    $thumbEmpty.style.display = '';
  }

  // ── 文档边框 overlay ─────────────────────────────────

  function drawDocumentOverlay() {
    try {
      var corners = DocScanner.detectCorners(processCanvas);
      if (!corners || corners.length !== 4) return;

      overlayCtx.strokeStyle = 'rgba(0, 212, 255, 0.75)';
      overlayCtx.lineWidth = 3;
      overlayCtx.setLineDash([8, 4]);
      overlayCtx.beginPath();
      overlayCtx.moveTo(corners[0].x, corners[0].y);
      for (var i = 1; i < 4; i++) overlayCtx.lineTo(corners[i].x, corners[i].y);
      overlayCtx.closePath();
      overlayCtx.stroke();
      overlayCtx.setLineDash([]);

      for (var i = 0; i < 4; i++) {
        overlayCtx.fillStyle = 'rgba(0, 212, 255, 0.9)';
        overlayCtx.beginPath();
        overlayCtx.arc(corners[i].x, corners[i].y, 6, 0, Math.PI * 2);
        overlayCtx.fill();
      }
    } catch (_) {}
  }

  // ── 页面可见性 / SW ───────────────────────────────────

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && running) requestWakeLock();
  });

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(function () {});
  }

})();
