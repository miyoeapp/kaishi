const APP_VERSION = "2.7.0";
const CACHE_NAME = `kaishi-v${APP_VERSION}`;
const INDEX_URL = new URL("./index.html", self.location).href;
const ICON_URL = new URL("./kaishi-icon.png", self.location).href;
const APP_SHELL = [INDEX_URL, ICON_URL];
const KAISHI_CACHE_PREFIXES = ["kaishi-v", "kaishi-shell-"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(
      APP_SHELL.map((url) => new Request(url, { cache: "reload" }))
    ))
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME && KAISHI_CACHE_PREFIXES.some((prefix) => key.startsWith(prefix)))
          .map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  if (event.request.mode === "navigate") {
    event.respondWith(networkFirstIndex(event.request));
    return;
  }

  if (url.href === ICON_URL) {
    event.respondWith(cacheFirstIcon(event.request));
  }
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") {
    event.waitUntil(self.skipWaiting());
  }
});

async function networkFirstIndex(request) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const response = await fetch(request, { cache: "no-store" });
    if (response.ok) await cache.put(INDEX_URL, response.clone());
    return response;
  } catch {
    const cached = await cache.match(INDEX_URL);
    if (cached) return cached;
    return new Response("懐紙をオフラインで開く準備がまだ完了していません。通信できる状態でもう一度開いてください。", {
      status: 503,
      headers: { "Content-Type": "text/plain; charset=utf-8" }
    });
  }
}

async function cacheFirstIcon(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) await cache.put(request, response.clone());
  return response;
}
