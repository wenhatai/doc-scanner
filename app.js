(function () {
  'use strict';

  var VERSION = 'v1.10.0';

  // ── 持久化存储 ─────────────────────────────────────────
  // captures 用 IndexedDB（图片 blob 可能较大）
  // 设置用 localStorage（小数据，同步读写方便）

  var DB_NAME = 'doc-scanner-db';
  var DB_STORE = 'captures';
  var SETTINGS_KEY = 'doc-scanner-settings-v1';

  var dbPromise = null;
  function getDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(DB_STORE)) {
          db.createObjectStore(DB_STORE, { keyPath: 'id', autoIncrement: true });
        }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
    return dbPromise;
  }

  async function dbAddCapture(dataUrl) {
    var db = await getDB();
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(DB_STORE, 'readwrite');
      var req = tx.objectStore(DB_STORE).add({ data: dataUrl, ts: Date.now() });
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  async function dbDeleteCapture(id) {
    var db = await getDB();
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(DB_STORE, 'readwrite');
      var req = tx.objectStore(DB_STORE).delete(id);
      req.onsuccess = function () { resolve(); };
      req.onerror = function () { reject(req.error); };
    });
  }

  async function dbClearCaptures() {
    var db = await getDB();
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(DB_STORE, 'readwrite');
      var req = tx.objectStore(DB_STORE).clear();
      req.onsuccess = function () { resolve(); };
      req.onerror = function () { reject(req.error); };
    });
  }

  async function dbLoadAllCaptures() {
    try {
      var db = await getDB();
      return await new Promise(function (resolve, reject) {
        var tx = db.transaction(DB_STORE, 'readonly');
        var req = tx.objectStore(DB_STORE).getAll();
        req.onsuccess = function () { resolve(req.result || []); };
        req.onerror = function () { reject(req.error); };
      });
    } catch (e) { return []; }
  }

  function loadSettings() {
    try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; }
    catch (e) { return {}; }
  }
  function saveSettings(patch) {
    try {
      var cur = loadSettings();
      Object.keys(patch).forEach(function (k) { cur[k] = patch[k]; });
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(cur));
    } catch (e) {}
  }

  var CONFIG = {
    FRAME_INTERVAL: 100,
    OVERLAY_INTERVAL: 500,
    STABLE_DURATION: 800,
    CHANGE_THRESHOLD: 0.15,
    STABLE_THRESHOLD: 0.04,
    DUPLICATE_THRESHOLD: 0.05,
    COMPARE_SIZE: 100,

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

  var currentState = STATE.IDLE;
  var stableStart = 0;
  var lastFrameData = null;
  var lastCapturedData = null;
  var captures = [];
  var paused = false;
  var running = false;
  var wakeLock = null;
  var lastProcessTime = 0;
  var selectedRes = null;    // { w, h, label } 用户选择的分辨率，null = 原生默认
  var selectedDeviceId = null; // 用户选择的摄像头 deviceId
  var availableCameras = []; // 所有后置摄像头列表 [{deviceId, label}]
  var currentTrack = null;
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
  document.getElementById('btnDiag').addEventListener('click', openDiagnostic);
  document.getElementById('btnDiagClose').addEventListener('click', closeDiagnostic);
  initSliders();

  // 页面加载后先加载已有 captures（恢复上次未导出的），再初始化摄像头/分辨率
  initStartScreen();

  async function initStartScreen() {
    await restoreCaptures();
    await probeCameras();
    await probeResolutions();
  }

  async function restoreCaptures() {
    var saved = await dbLoadAllCaptures();
    if (!saved.length) return;
    captures = saved.map(function (r) { return { id: r.id, data: r.data }; });
    // 渲染缩略图
    saved.forEach(function (r) { renderThumb({ id: r.id, data: r.data }); });
    $captureCount.textContent = captures.length;
    $btnExport.disabled = false;
    $btnClear.disabled = false;
    $thumbEmpty.style.display = 'none';
    // 提示用户有上次的记录
    var tip = document.createElement('div');
    tip.style.cssText = 'background:rgba(46,213,115,0.15);color:#2ed573;padding:8px 14px;border-radius:8px;font-size:12px;margin-bottom:12px;max-width:340px;text-align:center;';
    tip.textContent = '✓ 已恢复上次未导出的 ' + captures.length + ' 张图片';
    var startScreen = document.getElementById('startScreen');
    var firstChild = startScreen.querySelector('.logo');
    startScreen.insertBefore(tip, firstChild);
  }

  // ── 摄像头列表检测 ────────────────────────────────────

  async function probeCameras() {
    var camLoading = document.getElementById('camLoading');
    var camListEl  = document.getElementById('camList');

    // 必须先 getUserMedia 拿到权限，否则 enumerateDevices 不返回 label
    try {
      var tmpStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } },
        audio: false,
      });
      tmpStream.getTracks().forEach(function (t) { t.stop(); });
    } catch (e) {
      camLoading.textContent = '摄像头权限被拒绝：' + e.message;
      return;
    }

    var devices;
    try {
      devices = await navigator.mediaDevices.enumerateDevices();
    } catch (e) {
      camLoading.textContent = '枚举设备失败：' + e.message;
      return;
    }
    var cams = devices.filter(function (d) { return d.kind === 'videoinput'; });

    // 过滤后置摄像头（排除明显的前置：含 "front"/"user"/"自拍" 等）
    var backCams = cams.filter(function (c) {
      var l = (c.label || '').toLowerCase();
      if (!l) return true; // 无 label 时保留（iOS Safari 常见）
      return !/front|user|face|facetime|自拍|前置/.test(l);
    });
    if (backCams.length === 0) backCams = cams;

    availableCameras = backCams;

    if (backCams.length <= 1) {
      // 只有 1 个摄像头时不展示选择器（避免占空间）
      camLoading.style.display = 'none';
      document.getElementById('camPicker').style.display = 'none';
      if (backCams.length === 1) selectedDeviceId = backCams[0].deviceId;
      return;
    }

    // 优先：用户上次保存的 → 含 wide/广角 → 第一个
    var savedDeviceId = (loadSettings() || {}).deviceId;
    var defaultIdx = -1;
    if (savedDeviceId) {
      for (var k = 0; k < backCams.length; k++) {
        if (backCams[k].deviceId === savedDeviceId) { defaultIdx = k; break; }
      }
    }
    if (defaultIdx === -1) {
      for (var i = 0; i < backCams.length; i++) {
        var lbl = (backCams[i].label || '').toLowerCase();
        if (/ultra.?wide|wide|超广|广角/.test(lbl)) { defaultIdx = i; break; }
      }
    }
    if (defaultIdx === -1) defaultIdx = 0;
    selectedDeviceId = backCams[defaultIdx].deviceId;

    camLoading.style.display = 'none';
    camListEl.style.display = 'flex';
    camListEl.innerHTML = '';

    backCams.forEach(function (cam, idx) {
      var div = document.createElement('div');
      div.className = 'cam-opt' + (idx === defaultIdx ? ' active' : '');
      var lbl = cam.label || ('摄像头 ' + (idx + 1));
      // 自动识别类型标签
      var lblLow = lbl.toLowerCase();
      var tag = '';
      if (/ultra.?wide|超广/.test(lblLow))      tag = '超广角';
      else if (/wide|广角/.test(lblLow))         tag = '广角';
      else if (/tele|长焦/.test(lblLow))         tag = '长焦';
      else if (/macro|微距/.test(lblLow))        tag = '微距';
      else if (/depth|深度/.test(lblLow))        tag = '深度';
      div.innerHTML = '<span>📷 ' + lbl + '</span>' +
                      (tag ? '<span class="cam-tag">[' + tag + ' · 推荐]</span>' : '');
      div.addEventListener('click', function () {
        selectedDeviceId = cam.deviceId;
        saveSettings({ deviceId: cam.deviceId });
        document.querySelectorAll('.cam-opt').forEach(function (x) { x.classList.remove('active'); });
        div.classList.add('active');
        // 切换摄像头后重新探测分辨率
        var resGrid = document.getElementById('resGrid');
        var resLoading = document.getElementById('resLoading');
        resGrid.innerHTML = '';
        resGrid.style.display = 'none';
        resLoading.style.display = '';
        resLoading.textContent = '正在重新检测分辨率...';
        probeResolutions();
      });
      camListEl.appendChild(div);
    });
  }

  // ── 分辨率检测（基于已选 deviceId）────────────────────────

  async function probeResolutions() {
    var resLoading = document.getElementById('resLoading');
    var resGrid    = document.getElementById('resGrid');
    var resHint    = document.getElementById('resHint');
    var btnStart   = document.getElementById('btnStart');

    // 用已选 deviceId 拿权限，读 capabilities
    var vc = selectedDeviceId
      ? { deviceId: { exact: selectedDeviceId } }
      : { facingMode: { ideal: 'environment' } };
    var stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: vc, audio: false });
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

    // 优先恢复上次选择的分辨率
    var savedRes = (loadSettings() || {}).res; // {w,h}
    var defaultResIdx = 0;
    if (savedRes) {
      for (var k = 0; k < list.length; k++) {
        if (list[k].w === savedRes.w && list[k].h === savedRes.h) { defaultResIdx = k; break; }
      }
    }

    list.forEach(function (r, idx) {
      var lbl = document.createElement('label');
      lbl.className = 'res-opt';

      var input = document.createElement('input');
      input.type = 'radio'; input.name = 'res'; input.value = idx;
      if (idx === defaultResIdx) { input.checked = true; selectedRes = r; }

      var span = document.createElement('span');
      span.innerHTML = r.w + '×' + r.h + '<small>' + r.tag + '</small>';

      input.addEventListener('change', function () {
        if (this.checked) {
          selectedRes = r;
          resHint.textContent = r.w + '×' + r.h + ' ' + r.tag;
          saveSettings({ res: { w: r.w, h: r.h } });
        }
      });

      lbl.appendChild(input);
      lbl.appendChild(span);
      resGrid.appendChild(lbl);
    });

    var firstRes = list[defaultResIdx];
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
      currentTrack = null;
    }

    var videoConstraints;
    if (selectedDeviceId) {
      // 优先用 deviceId（精确指定摄像头）
      videoConstraints = { deviceId: { exact: selectedDeviceId } };
    } else {
      videoConstraints = { facingMode: { ideal: 'environment' } };
    }

    if (selectedRes) {
      videoConstraints.width  = { ideal: selectedRes.w };
      videoConstraints.height = { ideal: selectedRes.h };
    }

    var stream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints, audio: false });
    currentStream = stream;
    var track = stream.getVideoTracks()[0];
    currentTrack = track;

    // 持续对焦 + 重置 zoom 到最小值（解决"看起来焦距大"问题的关键）
    try {
      var caps = track.getCapabilities ? track.getCapabilities() : {};
      var advanced = [];
      if (caps.focusMode && caps.focusMode.indexOf('continuous') !== -1) {
        advanced.push({ focusMode: 'continuous' });
      }
      // 关键：把 zoom 强制重置为最小值（很多手机默认 zoom > 1）
      if (caps.zoom && typeof caps.zoom.min === 'number') {
        advanced.push({ zoom: caps.zoom.min });
      }
      if (advanced.length > 0) {
        await track.applyConstraints({ advanced: advanced });
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

  // ── 诊断面板 ──────────────────────────────────────────

  async function openDiagnostic() {
    var panel = document.getElementById('diagPanel');
    panel.style.display = 'block';
    await renderDiagnostic();
  }

  function closeDiagnostic() {
    document.getElementById('diagPanel').style.display = 'none';
  }

  async function renderDiagnostic() {
    var camList = document.getElementById('diagCamList');
    var diagText = document.getElementById('diagText');
    var zoomRow = document.getElementById('diagZoomRow');
    var zoomNone = document.getElementById('diagZoomNone');
    var zoomSlider = document.getElementById('diagZoomSlider');
    var zoomVal = document.getElementById('diagZoomVal');
    var zoomRange = document.getElementById('diagZoomRange');

    // 1. 列出所有摄像头
    camList.innerHTML = '正在枚举设备...';
    try {
      var devices = await navigator.mediaDevices.enumerateDevices();
      availableCameras = devices.filter(function (d) { return d.kind === 'videoinput'; });
    } catch (e) {
      availableCameras = [];
    }

    camList.innerHTML = '';
    var currentDeviceId = '';
    if (currentTrack) {
      var s = currentTrack.getSettings ? currentTrack.getSettings() : {};
      currentDeviceId = s.deviceId || '';
    }
    if (availableCameras.length === 0) {
      camList.innerHTML = '<div style="color:#f99;font-size:12px;">未检测到摄像头（可能需要先授权）</div>';
    } else {
      availableCameras.forEach(function (cam, idx) {
        var btn = document.createElement('button');
        var isActive = cam.deviceId === currentDeviceId;
        btn.style.cssText = 'text-align:left;padding:10px 12px;border-radius:8px;border:1.5px solid ' +
          (isActive ? 'var(--accent)' : 'var(--border)') +
          ';background:' + (isActive ? 'rgba(0,212,255,0.1)' : 'rgba(255,255,255,0.04)') +
          ';color:#fff;font-size:12px;cursor:pointer;';
        btn.innerHTML = '<div style="font-weight:600;">📷 摄像头 #' + (idx + 1) +
          (isActive ? ' <span style="color:var(--accent);">[当前]</span>' : '') + '</div>' +
          '<div style="font-size:11px;color:#aaa;margin-top:2px;word-break:break-all;">' +
          (cam.label || '(无标签，需先授权)') + '</div>' +
          '<div style="font-size:10px;color:#666;margin-top:2px;">' + cam.deviceId.substring(0, 24) + '...</div>';
        btn.addEventListener('click', async function () {
          if (cam.deviceId === currentDeviceId) return;
          selectedDeviceId = cam.deviceId;
          try {
            await startCamera();
            await renderDiagnostic(); // 重新渲染
          } catch (err) {
            alert('切换摄像头失败: ' + err.message);
          }
        });
        camList.appendChild(btn);
      });
    }

    // 2. zoom 控制
    var caps = currentTrack && currentTrack.getCapabilities ? currentTrack.getCapabilities() : {};
    var settings = currentTrack && currentTrack.getSettings ? currentTrack.getSettings() : {};
    if (caps.zoom && typeof caps.zoom.min === 'number') {
      zoomRow.style.display = 'block';
      zoomNone.style.display = 'none';
      zoomSlider.min = caps.zoom.min;
      zoomSlider.max = caps.zoom.max;
      zoomSlider.step = caps.zoom.step || 0.1;
      zoomSlider.value = settings.zoom || caps.zoom.min;
      zoomVal.textContent = (settings.zoom || caps.zoom.min).toFixed(1);
      zoomRange.textContent = 'min: ' + caps.zoom.min + ' / max: ' + caps.zoom.max;
      zoomSlider.oninput = async function () {
        zoomVal.textContent = parseFloat(this.value).toFixed(1);
        try {
          await currentTrack.applyConstraints({ advanced: [{ zoom: parseFloat(this.value) }] });
        } catch (e) {}
      };
    } else {
      zoomRow.style.display = 'none';
      zoomNone.style.display = 'block';
    }

    // 3. 完整诊断文本
    var ua = navigator.userAgent;
    var screenInfo = screen.width + '×' + screen.height + ' DPR=' + (window.devicePixelRatio || 1);
    var videoElInfo = video.videoWidth + '×' + video.videoHeight +
      ' (CSS渲染: ' + Math.round(video.clientWidth) + '×' + Math.round(video.clientHeight) + ')';

    var lines = [];
    lines.push('═══ 环境 ═══');
    lines.push('UA: ' + ua);
    lines.push('屏幕: ' + screenInfo);
    lines.push('');
    lines.push('═══ 当前摄像头 ═══');
    lines.push('label: ' + (currentTrack ? currentTrack.label : '(未启动)'));
    lines.push('');
    lines.push('═══ getSettings() ═══');
    lines.push(JSON.stringify(settings, null, 2));
    lines.push('');
    lines.push('═══ getCapabilities() ═══');
    lines.push(JSON.stringify(caps, null, 2));
    lines.push('');
    lines.push('═══ video 元素 ═══');
    lines.push('videoWidth × videoHeight: ' + videoElInfo);
    lines.push('object-fit: ' + (window.getComputedStyle(video).objectFit));
    lines.push('');
    lines.push('═══ 🚨 关键检查 ═══');
    var sw = settings.width, sh = settings.height;
    var vw = video.videoWidth, vh = video.videoHeight;
    if (sw && vw && sw !== vw) {
      lines.push('⚠️ settings.width(' + sw + ') ≠ videoWidth(' + vw + ')，画面可能被裁切');
    } else {
      lines.push('✅ settings 和 video 元素分辨率一致');
    }
    if (settings.zoom && settings.zoom > 1) {
      lines.push('⚠️ 当前 zoom = ' + settings.zoom + '（>1 会有变焦效果，试试设为 1）');
    } else if (settings.zoom) {
      lines.push('✅ zoom = ' + settings.zoom);
    } else {
      lines.push('ℹ️ 摄像头不报告 zoom 字段');
    }
    if (caps.zoom) {
      lines.push('   可调范围: ' + caps.zoom.min + ' ~ ' + caps.zoom.max);
    }

    diagText.textContent = lines.join('\n');
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
      updateStatusUI('idle', '等待翻页...');
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

    if (isDuplicate(captureCanvas)) { updateStatusUI('idle', '重复页面，已跳过'); return; }

    addCapture(captureCanvas.toDataURL('image/jpeg', 0.92));
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

  async function addCapture(dataUrl) {
    var id;
    try { id = await dbAddCapture(dataUrl); }
    catch (e) { id = Date.now() + Math.random(); /* fallback: 仍内存中保留 */ }
    var entry = { id: id, data: dataUrl };
    captures.push(entry);
    renderThumb(entry);
    $captureCount.textContent = captures.length;
    $btnExport.disabled = false;
    $btnClear.disabled = false;
    $thumbEmpty.style.display = 'none';
  }

  function renderThumb(entry) {
    var item = document.createElement('div');
    item.className = 'thumb-item';
    item.dataset.captureId = entry.id;

    var img = document.createElement('img');
    img.src = entry.data;
    item.appendChild(img);

    var del = document.createElement('button');
    del.className = 'thumb-del';
    del.textContent = '✕';
    del.addEventListener('click', async function (e) {
      e.stopPropagation();
      var idx = captures.findIndex(function (c) { return String(c.id) === String(entry.id); });
      if (idx !== -1) captures.splice(idx, 1);
      try { await dbDeleteCapture(entry.id); } catch (_) {}
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
    var s = loadSettings();

    var sc = document.getElementById('sliderChange');
    var vc = document.getElementById('valChange');
    if (typeof s.changePct === 'number') { sc.value = s.changePct; CONFIG.CHANGE_THRESHOLD = s.changePct / 100; }
    vc.textContent = sc.value + '%';
    sc.addEventListener('input', function () {
      CONFIG.CHANGE_THRESHOLD = this.value / 100;
      vc.textContent = this.value + '%';
      saveSettings({ changePct: +this.value });
    });

    var ss = document.getElementById('sliderStable');
    var vs = document.getElementById('valStable');
    if (typeof s.stableMs === 'number') { ss.value = s.stableMs; CONFIG.STABLE_DURATION = s.stableMs; }
    vs.textContent = (+ss.value / 1000).toFixed(1) + 's';
    ss.addEventListener('input', function () {
      CONFIG.STABLE_DURATION = +this.value;
      vs.textContent = (+this.value / 1000).toFixed(1) + 's';
      saveSettings({ stableMs: +this.value });
    });

    var sd = document.getElementById('sliderDup');
    var vd = document.getElementById('valDup');
    if (typeof s.dupPct === 'number') { sd.value = s.dupPct; CONFIG.DUPLICATE_THRESHOLD = s.dupPct / 100; }
    vd.textContent = sd.value + '%';
    sd.addEventListener('input', function () {
      CONFIG.DUPLICATE_THRESHOLD = this.value / 100;
      vd.textContent = this.value + '%';
      saveSettings({ dupPct: +this.value });
    });
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
        captures.forEach(function (c, i) {
          folder.file('page_' + String(i + 1).padStart(3, '0') + '.jpg', c.data.split(',')[1], { base64: true });
        });
        var blob = await zip.generateAsync({ type: 'blob' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = '扫描文档_' + new Date().toISOString().slice(0, 10) + '.zip';
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        URL.revokeObjectURL(url);
      } else {
        captures.forEach(function (c, i) {
          var a = document.createElement('a');
          a.href = c.data; a.download = 'page_' + String(i + 1).padStart(3, '0') + '.jpg';
          document.body.appendChild(a); a.click(); document.body.removeChild(a);
        });
      }
    } catch (e) { alert('导出失败: ' + e.message); }
    $btnExport.disabled = false;
    $btnExport.textContent = '📥 导出';
  }

  async function clearAll() {
    if (!confirm('确定清空所有抓拍？')) return;
    captures = []; lastCapturedData = null;
    try { await dbClearCaptures(); } catch (_) {}
    $captureCount.textContent = '0';
    $btnExport.disabled = true; $btnClear.disabled = true;
    $thumbBar.querySelectorAll('.thumb-item').forEach(function (el) { el.remove(); });
    $thumbEmpty.style.display = '';
  }

  // ── SW 更新提示 ───────────────────────────────────────

  document.addEventListener('visibilitychange', async function () {
    if (document.visibilityState !== 'visible' || !running) return;
    requestWakeLock();
    // 检查摄像头流是否还活着，若已断则重启
    var needRestart = false;
    if (!currentStream) {
      needRestart = true;
    } else {
      var tracks = currentStream.getVideoTracks ? currentStream.getVideoTracks() : [];
      if (tracks.length === 0 || tracks[0].readyState === 'ended') {
        needRestart = true;
      }
    }
    if (needRestart) {
      try {
        updateStatusUI('idle', '恢复摄像头...');
        await startCamera();
        updateStatusUI('idle', '已恢复');
      } catch (e) {
        updateStatusUI('idle', '摄像头恢复失败：' + e.message);
      }
    }
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
