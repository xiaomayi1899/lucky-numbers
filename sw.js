/* 数字彩助手 Service Worker：应用壳离线可用，开奖数据网络优先 */
const VERSION = "2026.11.09.3";
const SHELL_CACHE = `shell-${VERSION}`;
const DATA_CACHE = `data-${VERSION}`;

const SHELL_ASSETS = [
  "./",
  "./index.html",
  "./assets/style.css",
  "./assets/engine.js",
  "./assets/ensemble.js",
  "./assets/app.js",
  "./manifest.webmanifest",
  "./icons/icon-32.png",
  "./icons/icon-180.png",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/apple-touch-icon.png",
];

async function openCache(name) {
  try {
    return await caches.open(name);
  } catch (err) {
    console.warn("[sw] cache unavailable:", err);
    return null;
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await openCache(SHELL_CACHE);
      if (cache) {
        // 单个资源失败不应导致整个 Service Worker 安装失败
        await Promise.all(
          SHELL_ASSETS.map((url) =>
            cache.add(url).catch((err) => console.warn("[sw] skip", url, err))
          )
        );
      }
      await self.skipWaiting();
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      try {
        const keys = await caches.keys();
        await Promise.all(
          keys
            .filter((key) => key !== SHELL_CACHE && key !== DATA_CACHE)
            .map((key) => caches.delete(key).catch(() => false))
        );
      } catch (err) {
        console.warn("[sw] cleanup failed:", err);
      }
      await self.clients.claim();
    })()
  );
});

function isDataRequest(url) {
  return url.pathname.endsWith("/data/lottery.json") || url.pathname.endsWith("/data/snapshot.json");
}

async function networkFirst(request, cacheName, cacheKey) {
  let response = null;
  try {
    response = await fetch(request, { cache: "no-store" });
    if (response && response.ok) {
      const cache = await openCache(cacheName);
      if (cache) cache.put(cacheKey, response.clone()).catch(() => {});
    }
    return response;
  } catch (err) {
    const cache = await openCache(cacheName);
    const cached = cache ? await cache.match(cacheKey) : null;
    if (cached) {
      // 告诉前端这是离线缓存，便于显示“离线”状态
      const headers = new Headers(cached.headers);
      headers.set("X-Lottery-Cache", "1");
      return new Response(cached.body, {
        status: cached.status,
        statusText: cached.statusText,
        headers: headers,
      });
    }
    throw err;
  }
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await openCache(cacheName);
  const cached = cache ? await cache.match(request) : null;
  const network = fetch(request)
    .then((response) => {
      if (response && response.ok && cache) cache.put(request, response.clone()).catch(() => {});
      return response;
    })
    .catch(() => null);
  return cached || network || Response.error();
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (isDataRequest(url)) {
    const dataKey = new URL("./data/lottery.json", self.registration.scope).href;
    event.respondWith(networkFirst(request, DATA_CACHE, dataKey));
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response && response.ok) {
            const copy = response.clone();
            openCache(SHELL_CACHE).then((cache) => {
              if (cache) cache.put("./index.html", copy).catch(() => {});
            });
          }
          return response;
        })
        .catch(async () => {
          const cache = await openCache(SHELL_CACHE);
          if (cache) {
            const hit = (await cache.match("./index.html")) || (await cache.match("./"));
            if (hit) return hit;
          }
          return Response.error();
        })
    );
    return;
  }

  event.respondWith(staleWhileRevalidate(request, SHELL_CACHE));
});
