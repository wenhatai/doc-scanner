// 每次发布新版本，修改这个版本号，旧缓存会自动清除
var VERSION = 'v1.9.0';
var CACHE_APP = 'doc-scanner-app-' + VERSION;
var CACHE_CDN = 'doc-scanner-cdn-v1';  // CDN 库不随版本变，单独一个 cache

var APP_URLS = [
  '/doc-scanner/',
  '/doc-scanner/index.html',
  '/doc-scanner/app.js',
  '/doc-scanner/scanner.js',
  '/doc-scanner/manifest.json',
];

var CDN_URLS = [
  'https://cdn.bootcdn.net/ajax/libs/opencv.js/4.9.0/opencv.js',
  'https://cdn.bootcdn.net/ajax/libs/jszip/3.10.1/jszip.min.js',
];

// ── Install：预缓存 CDN 库（自有文件不预缓存，靠 network-first 动态缓存）──
self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_CDN).then(function (cache) {
      return Promise.allSettled(
        CDN_URLS.map(function (url) { return cache.add(url); })
      );
    })
  );
  // 立即激活，不等旧 SW 的标签页关闭
  self.skipWaiting();
});

// ── Activate：清除旧版本的 app cache ─────────────────────────────────────
self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (names) {
      return Promise.all(
        names.map(function (name) {
          // 删除所有旧版 app cache；CDN cache 保留
          if (name.startsWith('doc-scanner-app-') && name !== CACHE_APP) {
            return caches.delete(name);
          }
        })
      );
    })
  );
  // 立即接管所有已打开的客户端（包括 PWA 窗口）
  self.clients.claim();
});

// ── Fetch ─────────────────────────────────────────────────────────────────
self.addEventListener('fetch', function (event) {
  var url = event.request.url;

  // CDN 资源：cache-first（内容不变，优先读缓存）
  if (CDN_URLS.some(function (cdn) { return url.startsWith(cdn); })) {
    event.respondWith(cdnCacheFirst(event.request));
    return;
  }

  // 自有文件：network-first（优先拉最新，失败再用缓存）
  var isAppFile = APP_URLS.some(function (u) { return url.endsWith(u) || url === location.origin + u; });
  if (isAppFile || url.includes('/doc-scanner/')) {
    event.respondWith(appNetworkFirst(event.request));
    return;
  }
});

function appNetworkFirst(request) {
  return fetch(request).then(function (response) {
    if (response.ok) {
      var clone = response.clone();
      caches.open(CACHE_APP).then(function (cache) { cache.put(request, clone); });
    }
    return response;
  }).catch(function () {
    // 离线时降级到缓存
    return caches.match(request).then(function (cached) {
      return cached || new Response('Offline', { status: 503, statusText: 'Offline' });
    });
  });
}

function cdnCacheFirst(request) {
  return caches.match(request).then(function (cached) {
    if (cached) return cached;
    return fetch(request).then(function (response) {
      if (response.ok) {
        var clone = response.clone();
        caches.open(CACHE_CDN).then(function (cache) { cache.put(request, clone); });
      }
      return response;
    }).catch(function () {
      return new Response('', { status: 503 });
    });
  });
}
