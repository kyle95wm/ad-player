/*
 * Service worker: lets the player open with no connection.
 *
 * The page's own files are saved on the first visit. After that, every
 * request goes to the network first, so an online visit always gets the
 * latest version (and refreshes the saved copy). The saved copy is used only
 * when the network fails or takes longer than NETWORK_TIMEOUT_MS.
 *
 * Audio files are never fetched or stored here: the player reads them from
 * the device through blob: URLs, which don't pass through a service worker.
 *
 * When adding, renaming or removing a file the page loads, update FILES.
 */

const CACHE = 'ad-player-v1';
const FILES = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './playlist.js',
  './tooltip.js',
  './dsp-processor.js',
];
const NETWORK_TIMEOUT_MS = 5000;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(FILES.map((url) => new Request(url, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('ad-player-') && k !== CACHE)
        .map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  event.respondWith(networkFirst(request));
});

async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  const network = fetch(request).then((response) => {
    if (response.ok && response.type === 'basic') {
      cache.put(request, response.clone()).catch(() => {});
    }
    return response;
  });

  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(resolve, NETWORK_TIMEOUT_MS); });
  try {
    const response = await Promise.race([network, timeout]);
    if (response) return response;
  } catch {
    // Offline or the request failed: fall through to the saved copy.
  } finally {
    clearTimeout(timer);
  }

  const saved = await savedCopy(cache, request);
  if (saved) return saved;
  return network; // nothing saved: wait for the network, or fail as normal
}

function savedCopy(cache, request) {
  return cache.match(request, { ignoreSearch: true }).then((hit) => {
    if (hit || request.mode !== 'navigate') return hit;
    // Any page address in the player's folder opens the saved player.
    return cache.match('./');
  });
}
