(function () {
  'use strict';

  var VERSION = 'v1.6.0';

  var CONFIG = {
    FRAME_INTERVAL: 100,
    OVERLAY_INTERVAL: 500,
    STABLE_DURATION: 800,
    CHANGE_THRESHOLD: 0.15,
    STABLE_THRESHOLD: 0.04,
    DUPLICATE_THRESHOLD: 0.05,
    COMPARE_SIZE: 100,
    OPENCV_LOAD_TIMEOUT: 30000,
  };

  // 固定标准档位列表（按像素数从高到低），启动时用 ideal 就近匹配
  // 会在 probeResolutions 里过滤掉超过摄像头最大值的档位
  var RES_PRESETS = [
    { w: 4032, h: 3024, tag: '4:3' },
    { w: 4032, h: 2268, tag: '16:9' },
    { w: 3840, h: 2160, tag: '4K 16:9' },
    { w: 3264, h: 2448, tag: '4:3' },
    { w: 2560, h: 1920, tag: '4:3' },
    { w: 2560, h: 1440, tag: '2K 16:9' },
    { w: 1920, h: 1440, tag: '4:3' },
    { w: 1920, h: 1080, tag: '1080p 16:9' },
    { w: 1280, h: 960,  tag: '4:3' },
    { w: 1280, h: 720,  tag: '720p 16:9' },
    { w: 640,  h: 480,  tag: '4:3' },
  ];

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
  var selectedRes = null;    // { w, h, label } 用户选择的分辨率，null = 原生默认
  var currentStream = null;

  var video        = document.getElementById('video');
  var overlayCanvas= document.getElementById('overlayCanvas');
  var overlayCtx   = overlayCanvas.getContext('2d', { willReadFrequently: true });
  var processCanvas= document.createElement('canvas');
  var processCtx   = processCanvas.getContext('2d', { willReadFrequently: true });
  var captureCanvas= document.createElement('canvas');
  var captureCtx   = captureCanvas.getContext('2d');

  var $startScreen = document.getElementById('startScreen');
  var $loading     = document.getElementById('loadingOverlay');
  var $loadingText = document.getElementById('loadingText');
  var $flash       = document.getElementById('flashOverlay');
  var $statusDot   = document.getElementById('statusDot');
  var $statusText  = document.getElementById('statusText');
  var $captureCount= document.getElementById('captureCount');
  var $btnManual   = document.getElementById('btnManual');
  var $btnPause    = document.getElementById('btnPause');
  var $btnExport   = document.getElementById('btnExport');
  var $btnClear    = document.getElementById('btnClear');
  var $thumbBar    = document.getElementById('thumbBar');
  var $thumbEmpty  = document.getElementById('thumbEmpty');

  document.getElementById('btnStart').addEventListener('click', startApp);
  $btnManual.addEventListener('click', manualCapture);
  $btnPause.addEventListener('click', togglePause);
  $btnExport.addEventListener('click', exportImages);
  $btnClear.addEventListener('click', clearAll);
  document.getElementById('btnSettings').addEventListener('click', toggleSettings);
  initSliders();

  // 页面加载后立即探测支持的分辨率
  probeResolutions();

  // ── 分辨率检测（用 getCapabilities，无需逐个探测）────────

  async function probeResolutions() {
    var resLoading = document.getElementById('resLoading');
    var resGrid    = document.getElementById('resGrid');
    var resHint    = document.getElementById('resHint');
    var btnStart   = document.getElementById('btnStart');

    // 请求一次摄像头权限，读取 getCapabilities()，然后立即关掉
    var stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } },
        audio: false,
      });
    } catch (e) {
      resLoading.textContent = '摄像头权限被拒绝：' + e.message;
      return;
    }

    var track    = stream.getVideoTracks()[0];
    var caps     = track.getCapabilities ? track.getCapabilities() : {};
    var settings = track.getSettings    ? track.getSettings()     : {};
    var camLabel = (track.label || '').substring(0, 36);
    stream.getTracks().forEach(function (t) { t.stop(); });

    // 摄像头支持的最大分辨率（优先 capabilities，fallback settings）
    var maxW = (caps.width  && caps.width.max)  || settings.width  || 9999;
    var maxH = (caps.height && caps.height.max) || settings.height || 9999;

    resLoading.style.display = 'none';
    resGrid.style.display = 'grid';

    // 过滤标准档位：不超过摄像头最大值，去重
    var seen = {};
    var list = [];

    // 最顶部加"摄像头原生最大"（只在能拿到有效 max 时显示）
    if (maxW < 9999 && maxH < 9999) {
      var nativeKey = maxW + 'x' + maxH;
      seen[nativeKey] = true;
      list.push({ w: maxW, h: maxH, tag: '原生最大' });
    }

    RES_PRESETS.forEach(function (r) {
      if (r.w > maxW || r.h > maxH) return;
      var key = r.w + 'x' + r.h;
      if (seen[key]) return;
      seen[key] = true;
      list.push({ w: r.w, h: r.h, tag: r.tag });
    });

    // 从高到低排序（原生最大已在最前，但以防万一）
    list.sort(function (a, b) { return (b.w * b.h) - (a.w * a.h); });

    if (list.length === 0) {
      resHint.textContent = '将使用摄像头默认分辨率';
      selectedRes = null;
      btnStart.disabled = false;
      return;
    }

    list.forEach(function (r, idx) {
      var lbl = document.createElement('label');
      lbl.className = 'res-opt';

      var input = document.createElement('input');
      input.type = 'radio'; input.name = 'res'; input.value = idx;
      if (idx === 0) { input.checked = true; selectedRes = r; }

      var span = document.createElement('span');
      span.innerHTML = r.w + '×' + r.h + '<small>' + r.tag + '</small>';

      input.addEventListener('change', function () {
        if (this.checked) {
          selectedRes = r;
          resHint.textContent = r.w + '×' + r.h + ' ' + r.tag;
        }
      });

      lbl.appendChild(input);
      lbl.appendChild(span);
      resGrid.appendChild(lbl);
    });

    var firstRes = list[0];
    resHint.textContent = (camLabel ? camLabel + '  ' : '') +
                          firstRes.w + '×' + firstRes.h + ' ' + firstRes.tag;
    btnStart.disabled = false;
  }

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
    // 停掉旧流
    if (currentStream) {
      currentStream.getTracks().forEach(function (t) { t.stop(); });
      currentStream = null;
    }

    var videoConstraints = { facingMode: { ideal: 'environment' } };

    if (selectedRes) {
      // 用 ideal 让浏览器就近匹配，避免 exact 在不支持该分辨率时抛出 OverconstrainedError
      videoConstraints.width  = { ideal: selectedRes.w };
      videoConstraints.height = { ideal: selectedRes.h };
    }

    var stream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints, audio: false });
    currentStream = stream;
    var track = stream.getVideoTracks()[0];

    // 持续对焦（iOS Safari 17+ 自动处理微距，Android 看厂商）
    try {
      var caps = track.getCapabilities ? track.getCapabilities() : {};
      if (caps.focusMode && caps.focusMode.indexOf('continuous') !== -1) {
        await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] });
      }
    } catch (_) {}

    video.srcObject = stream;
    await new Promise(function (resolve, reject) {
      video.onloadedmetadata = function () { video.play().then(resolve).catch(reject); };
      video.onerror = reject;
    });

    // 显示实际分辨率
    var st = track.getSettings ? track.getSettings() : {};
    var w = st.width  || video.videoWidth;
    var h = st.height || video.videoHeight;
    var lbl = (track.label || '').substring(0, 28);
    var camInfo = document.getElementById('camInfo');
    if (camInfo) camInfo.textContent = w + '×' + h + (lbl ? '  ' + lbl : '');
  }

  // ── OpenCV 异步加载 ───────────────────────────────────

  function loadOpenCVAsync() {
    if (typeof cv !== 'undefined' && cv.Mat) { cvReady = true; updateStatusUI('idle', '智能矫正已就绪'); return; }
    if (cvLoading) return;
    cvLoading = true;

    loadScriptFromMirrors(OPENCV_MIRRORS)
      .then(function () { return waitForOpenCVReady(); })
      .then(function () { cvReady = true; cvLoading = false; updateStatusUI('idle', '智能矫正已就绪'); })
      .catch(function (e) { cvLoading = false; console.warn('OpenCV 加载失败:', e); updateStatusUI('idle', '基础模式（无自动矫正）'); });
  }

  function loadScriptFromMirrors(urls) {
    return new Promise(function (resolve, reject) {
      var idx = 0;
      function tryNext() {
        if (idx >= urls.length) { reject(new Error('所有镜像均失败')); return; }
        var url = urls[idx++];
        var s = document.createElement('script');
        s.src = url; s.async = true;
        var timer = setTimeout(function () { cleanup(); tryNext(); }, CONFIG.OPENCV_LOAD_TIMEOUT);
        function cleanup() { clearTimeout(timer); s.onload = s.onerror = null; if (s.parentNode) s.parentNode.removeChild(s); }
        s.onload = function () { cleanup(); resolve(); };
        s.onerror = function () { cleanup(); tryNext(); };
        document.head.appendChild(s);
      }
      tryNext();
    });
  }

  function waitForOpenCVReady() {
    return new Promise(function (resolve, reject) {
      if (typeof cv !== 'undefined' && cv.Mat) { resolve(); return; }
      var done = false;
      var timeout = setTimeout(function () { if (!done) { done = true; clearInterval(poll); reject(new Error('超时')); } }, 60000);
      var poll = setInterval(function () {
        if (typeof cv !== 'undefined' && cv.Mat) { if (!done) { done = true; clearInterval(poll); clearTimeout(timeout); resolve(); } }
      }, 200);
      if (typeof cv !== 'undefined') {
        var orig = cv.onRuntimeInitialized;
        cv.onRuntimeInitialized = function () { if (orig) orig(); if (!done) { done = true; clearInterval(poll); clearTimeout(timeout); resolve(); } };
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
    var vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) return;

    if (processCanvas.width !== vw || processCanvas.height !== vh) {
      processCanvas.width = vw; processCanvas.height = vh;
      overlayCanvas.width = vw; overlayCanvas.height = vh;
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
        if (!stableStart) stableStart = performance.now();
        else if (performance.now() - stableStart >= CONFIG.STABLE_DURATION) {
          performCapture(currentFrame, vw, vh);
          currentState = STATE.IDLE;
          stableStart = 0;
        }
      } else {
        stableStart = 0;
      }
    } else {
      currentState = STATE.IDLE;
      updateStatusUI('idle', cvLoading ? '矫正引擎加载中...' : '等待翻页...');
    }

    if (cvReady && timestamp - lastOverlayTime >= CONFIG.OVERLAY_INTERVAL) {
      lastOverlayTime = timestamp;
      drawDocumentOverlay();
    }
  }

  // ── 帧差分 ────────────────────────────────────────────

  function computeChange(current, previous) {
    if (!previous || current.length !== previous.length) return 0;
    var step = 32, diff = 0, total = 0;
    for (var i = 0; i < current.length; i += step) {
      var g1 = current[i] * 0.299 + current[i+1] * 0.587 + current[i+2] * 0.114;
      var g2 = previous[i] * 0.299 + previous[i+1] * 0.587 + previous[i+2] * 0.114;
      if (Math.abs(g1 - g2) > 30) diff++;
      total++;
    }
    return total > 0 ? diff / total : 0;
  }

  // ── 抓拍 ─────────────────────────────────────────────

  function performCapture(frameData, w, h) {
    captureCanvas.width = w;
    captureCanvas.height = h;
    captureCtx.putImageData(frameData, 0, 0);

    var sourceCanvas = captureCanvas;
    if (cvReady) {
      try {
        var corrected = DocScanner.detectAndCorrectCanvas(captureCanvas);
        if (corrected) sourceCanvas = corrected;
      } catch (e) { console.warn('矫正失败:', e); }
    }

    if (isDuplicate(sourceCanvas)) { updateStatusUI('idle', '重复页面，已跳过'); return; }

    addCapture(sourceCanvas.toDataURL('image/jpeg', 0.92));
    flashEffect();
    updateStatusUI('idle', '已抓拍！');
  }

  // ── 去重 ──────────────────────────────────────────────

  function isDuplicate(srcCanvas) {
    var sz = CONFIG.COMPARE_SIZE;
    var tmp = document.createElement('canvas');
    tmp.width = sz; tmp.height = sz;
    tmp.getContext('2d').drawImage(srcCanvas, 0, 0, sz, sz);
    var data = tmp.getContext('2d').getImageData(0, 0, sz, sz).data;

    if (!lastCapturedData) { lastCapturedData = new Uint8ClampedArray(data); return false; }

    var diff = 0, total = sz * sz;
    for (var i = 0; i < data.length; i += 4) {
      var g1 = data[i]*0.299 + data[i+1]*0.587 + data[i+2]*0.114;
      var g2 = lastCapturedData[i]*0.299 + lastCapturedData[i+1]*0.587 + lastCapturedData[i+2]*0.114;
      if (Math.abs(g1 - g2) > 25) diff++;
    }
    lastCapturedData = new Uint8ClampedArray(data);
    return (diff / total) < CONFIG.DUPLICATE_THRESHOLD;
  }

  // ── 手动拍照 ──────────────────────────────────────────

  function manualCapture() {
    if (video.readyState < 2) return;
    var vw = video.videoWidth, vh = video.videoHeight;
    processCtx.drawImage(video, 0, 0, vw, vh);
    performCapture(processCtx.getImageData(0, 0, vw, vh), vw, vh);
  }

  // ── 缩略图 ────────────────────────────────────────────

  function addCapture(dataUrl) {
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
    del.className = 'thumb-del';
    del.textContent = '✕';
    del.addEventListener('click', function (e) {
      e.stopPropagation();
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

  // ── UI ───────────────────────────────────────────────

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
      $btnPause.classList.replace('secondary', 'primary');
      updateStatusUI('idle', '已暂停');
    } else {
      currentState = STATE.IDLE;
      lastFrameData = null;
      $btnPause.textContent = '⏸ 暂停';
      $btnPause.classList.replace('primary', 'secondary');
      updateStatusUI('idle', '等待翻页...');
    }
  }

  function toggleSettings() {
    var panel = document.getElementById('settingsPanel');
    var btn = document.getElementById('btnSettings');
    var open = panel.classList.toggle('open');
    btn.style.background = open ? 'rgba(0,212,255,0.2)' : '';
  }

  function initSliders() {
    var sc = document.getElementById('sliderChange');
    var vc = document.getElementById('valChange');
    sc.addEventListener('input', function () { CONFIG.CHANGE_THRESHOLD = this.value / 100; vc.textContent = this.value + '%'; });

    var ss = document.getElementById('sliderStable');
    var vs = document.getElementById('valStable');
    ss.addEventListener('input', function () { CONFIG.STABLE_DURATION = +this.value; vs.textContent = (+this.value / 1000).toFixed(1) + 's'; });

    var sd = document.getElementById('sliderDup');
    var vd = document.getElementById('valDup');
    sd.addEventListener('input', function () { CONFIG.DUPLICATE_THRESHOLD = this.value / 100; vd.textContent = this.value + '%'; });
  }

  // ── 导出 ──────────────────────────────────────────────

  async function exportImages() {
    if (!captures.length) return;
    $btnExport.disabled = true;
    $btnExport.textContent = '⏳ 打包中...';
    try {
      if (typeof JSZip !== 'undefined') {
        var zip = new JSZip();
        var folder = zip.folder('scanned_docs');
        captures.forEach(function (d, i) {
          folder.file('page_' + String(i + 1).padStart(3, '0') + '.jpg', d.split(',')[1], { base64: true });
        });
        var blob = await zip.generateAsync({ type: 'blob' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = '扫描文档_' + new Date().toISOString().slice(0, 10) + '.zip';
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        URL.revokeObjectURL(url);
      } else {
        captures.forEach(function (d, i) {
          var a = document.createElement('a');
          a.href = d; a.download = 'page_' + String(i + 1).padStart(3, '0') + '.jpg';
          document.body.appendChild(a); a.click(); document.body.removeChild(a);
        });
      }
    } catch (e) { alert('导出失败: ' + e.message); }
    $btnExport.disabled = false;
    $btnExport.textContent = '📥 导出';
  }

  function clearAll() {
    if (!confirm('确定清空所有抓拍？')) return;
    captures = []; lastCapturedData = null;
    $captureCount.textContent = '0';
    $btnExport.disabled = true; $btnClear.disabled = true;
    $thumbBar.querySelectorAll('.thumb-item').forEach(function (el) { el.remove(); });
    $thumbEmpty.style.display = '';
  }

  // ── Overlay ───────────────────────────────────────────

  function drawDocumentOverlay() {
    try {
      var corners = DocScanner.detectCorners(processCanvas);
      if (!corners || corners.length !== 4) return;
      overlayCtx.strokeStyle = 'rgba(0,212,255,0.75)';
      overlayCtx.lineWidth = 3;
      overlayCtx.setLineDash([8, 4]);
      overlayCtx.beginPath();
      overlayCtx.moveTo(corners[0].x, corners[0].y);
      for (var i = 1; i < 4; i++) overlayCtx.lineTo(corners[i].x, corners[i].y);
      overlayCtx.closePath();
      overlayCtx.stroke();
      overlayCtx.setLineDash([]);
      corners.forEach(function (c) {
        overlayCtx.fillStyle = 'rgba(0,212,255,0.9)';
        overlayCtx.beginPath();
        overlayCtx.arc(c.x, c.y, 6, 0, Math.PI * 2);
        overlayCtx.fill();
      });
    } catch (_) {}
  }

  // ── SW 更新提示 ───────────────────────────────────────

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && running) requestWakeLock();
  });

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').then(function (reg) {
      reg.addEventListener('updatefound', function () {
        var nw = reg.installing;
        nw.addEventListener('statechange', function () {
          if (nw.state === 'activated' && navigator.serviceWorker.controller) showUpdateBanner();
        });
      });
    }).catch(function () {});
    navigator.serviceWorker.addEventListener('controllerchange', function () { showUpdateBanner(); });
  }

  function showUpdateBanner() {
    if (document.getElementById('updateBanner')) return;
    var b = document.createElement('div');
    b.id = 'updateBanner';
    b.style.cssText = 'position:fixed;bottom:90px;left:50%;transform:translateX(-50%);background:#00d4ff;color:#0f0f1a;padding:10px 20px;border-radius:50px;font-size:13px;font-weight:600;z-index:999;cursor:pointer;box-shadow:0 4px 16px rgba(0,212,255,0.4);white-space:nowrap';
    b.textContent = '有新版本，点击刷新';
    b.addEventListener('click', function () { location.reload(); });
    document.body.appendChild(b);
  }

})();
