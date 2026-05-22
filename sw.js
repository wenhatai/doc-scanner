var CACHE_NAME = 'doc-scanner-v2';
var CACHE_URLS = [
  '/index.html',
  '/app.js',
  '/scanner.js',
  '/manifest.json',
];

var CDN_URLS = [
  'https://cdn.bootcdn.net/ajax/libs/opencv.js/4.9.0/opencv.js',
  'https://cdn.bootcdn.net/ajax/libs/jszip/3.10.1/jszip.min.js',
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      return cache.addAll(CACHE_URLS).then(function () {
        return Promise.allSettled(
          CDN_URLS.map(function (url) {
            return cache.add(url);
          })
        );
      });
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (names) {
      return Promise.all(
        names.filter(function (n) { return n !== CACHE_NAME; }).map(function (n) { return caches.delete(n); })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', function (event) {
  var url = new URL(event.request.url);

  if (CDN_URLS.some(function (cdn) { return url.href.startsWith(cdn.split('?')[0]); })) {
    event.respondWith(
      caches.match(event.request).then(function (cached) {
        if (cached) return cached;
        return fetch(event.request).then(function (response) {
          if (response.ok) {
            var clone = response.clone();
            caches.open(CACHE_NAME).then(function (cache) { cache.put(event.request, clone); });
          }
          return response;
        }).catch(function () {
          return new Response('Offline', { status: 503 });
        });
      })
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then(function (cached) {
      var fetchPromise = fetch(event.request).then(function (response) {
        if (response.ok) {
          var clone = response.clone();
          caches.open(CACHE_NAME).then(function (cache) { cache.put(event.request, clone); });
        }
        return response;
      }).catch(function () {
        return cached;
      });
      return cached || fetchPromise;
    })
  );
});
