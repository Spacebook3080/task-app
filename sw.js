// オフラインでもアプリを開けるようにするための Service Worker
const CACHE = 'dtm-v3';
const SUPABASE_LIB = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js';
const SHELL = ['./', 'index.html', 'app.js', 'config.js', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/apple-touch-icon.png', SUPABASE_LIB];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // ライブラリはバージョン固定なのでキャッシュ優先
  if (req.url === SUPABASE_LIB) {
    e.respondWith(caches.match(req).then(r => r || fetch(req)));
    return;
  }
  // 自分のファイルはネット優先（更新がすぐ反映されるように）、つながらなければキャッシュ
  if (url.origin === location.origin) {
    e.respondWith(
      fetch(req)
        .then(res => {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy));
          return res;
        })
        .catch(() => caches.match(req, { ignoreSearch: true }))
    );
  }
  // それ以外（Supabase の通信など）は Service Worker を通さない
});

// 毎朝の通知（Edge Function「push」から届く）
self.addEventListener('push', e => {
  let msg = {};
  try { msg = e.data ? e.data.json() : {}; } catch (err) { msg = { body: e.data.text() }; }
  e.waitUntil(self.registration.showNotification(msg.title || '毎日のタスク', {
    body: msg.body || '',
    icon: 'icons/icon-192.png',
    tag: msg.tag || 'morning',
    data: { url: msg.url || './' }
  }));
});

// 通知を押したらアプリを開く（開いていればそれを前に出す）
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      const win = list.find(c => 'focus' in c);
      return win ? win.focus() : self.clients.openWindow(e.notification.data.url);
    })
  );
});
