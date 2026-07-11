const CACHE_NAME = 'catnon-helper-v3';
const PRECACHE = [
  './',
  './index.html',
  './manifest.json',
  './icon.png',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
  'https://unpkg.com/peerjs@1.5.2/dist/peerjs.min.js',
  'https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600&family=DM+Mono:wght@400;500&display=swap',
];

// ── SHARE TARGET ──
function openInboxDB() {
  return new Promise((resolve, reject) => {
    // Must match app DB version and schema exactly
    const req = indexedDB.open('CatNonHelperDB', 5);
    req.onupgradeneeded = e => {
      const d = e.target.result;
      if (!d.objectStoreNames.contains('photos')) {
        const ps = d.createObjectStore('photos', { keyPath:'id', autoIncrement:true });
        ps.createIndex('albumId', 'albumId', { unique:false });
      }
      if (!d.objectStoreNames.contains('albums'))
        d.createObjectStore('albums', { keyPath:'id', autoIncrement:true });
      if (!d.objectStoreNames.contains('notes'))
        d.createObjectStore('notes', { keyPath:'id', autoIncrement:true });
      if (!d.objectStoreNames.contains('inbox'))
        d.createObjectStore('inbox', { keyPath:'id', autoIncrement:true });
    };
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = () => reject(req.error);
  });
}

async function handleShareTarget(event) {
  const url = new URL(event.request.url);
  if (event.request.method !== 'POST' || !url.pathname.endsWith('/index.html')) return;

  // Parse form data and save files BEFORE redirecting
  // (clone the request first — formData() consumes the body)
  const formData = await event.request.formData();
  const files = formData.getAll('file');

  if (files.length) {
    try {
      const db = await openInboxDB();
      for (const file of files) {
        const buf = await file.arrayBuffer();
        await new Promise((res, rej) => {
          const tx = db.transaction('inbox', 'readwrite');
          const req = tx.objectStore('inbox').add({
            name:     file.name,
            mime:     file.type || 'application/octet-stream',
            size:     file.size,
            data:     buf,
            received: Date.now(),
          });
          req.onsuccess = res;
          req.onerror   = () => rej(req.error);
        });
      }
    } catch(err) {
      console.error('[SW] Failed to save shared file:', err);
    }
  }

  // Try to message any open app window to navigate to receiver
  // This avoids the broken-redirect issue on Android
  const clientList = await clients.matchAll({ type:'window', includeUncontrolled:true });
  for (const client of clientList) {
    client.postMessage({ type:'SHARE_RECEIVED' });
  }

  // Use absolute URL for redirect — relative URLs are unreliable in SW context
  const redirectUrl = url.origin + url.pathname + '?shared=1';
  return Response.redirect(redirectUrl, 303);
}

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(c => c.addAll(PRECACHE)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
      .then(() => clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if (e.request.method === 'POST') {
    e.respondWith(handleShareTarget(e));
    return;
  }

  if (e.request.method !== 'GET' || !e.request.url.startsWith('http')) return;

  // Network-first for navigation — always get fresh index.html when online
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request)
        .then(res => {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
          return res;
        })
        .catch(() => caches.match('./index.html'))
    );
    return;
  }

  // Cache-first for assets
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(res => {
        if (res && res.status === 200) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
        }
        return res;
      });
    })
  );
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(clients.matchAll({ type:'window' }).then(list => {
    if (list.length) return list[0].focus();
    return clients.openWindow('/');
  }));
});
