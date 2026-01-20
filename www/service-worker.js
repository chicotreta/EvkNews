/* service-worker.js — EVK News (PWA) “máximo e completo”
   Estratégias:
   - HTML (navegação): network-first + fallback offline para index.html
   - JSON (news.json): stale-while-revalidate (cache rápido + update em background)
   - Assets (css/js/png/...): cache-first + revalidate em background
   - Separa CORE e RUNTIME caches
   - Mensagens: SKIP_WAITING, CLEAR_ALL_CACHES, CLEAR_RUNTIME
*/

(() => {
  const APP_PREFIX = "evknews";
  const VERSION = "v6"; // aumente a cada release (importante)
  const CORE_CACHE = `${APP_PREFIX}-core-${VERSION}`;
  const RUNTIME_CACHE = `${APP_PREFIX}-runtime-${VERSION}`;
  
  const CORE_ASSETS = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./news.json",
  "./manifest.json",
  "./evknews.png",
  "./icon-192.png",
  "./icon-512.png",
  "./vendor/swiper-bundle.min.css",
  "./vendor/swiper-bundle.min.js"
];
  
  const isSameOrigin = (url) => url.origin === self.location.origin;
  
  async function cachePut(cacheName, req, res) {
    if (req.method !== "GET") return;
    // Evita cachear opaque/erro
    if (!res || !res.ok) return;
    const cache = await caches.open(cacheName);
    await cache.put(req, res);
  }
  
  async function cleanupOldCaches() {
    const keys = await caches.keys();
    const keep = new Set([CORE_CACHE, RUNTIME_CACHE]);
    await Promise.all(keys.filter(k => !keep.has(k)).map(k => caches.delete(k)));
  }
  
  // ====== INSTALL ======
  self.addEventListener("install", (event) => {
    event.waitUntil((async () => {
      const cache = await caches.open(CORE_CACHE);
      await cache.addAll(CORE_ASSETS);
    })());
    // atualização imediata (você pediu “máximo”)
    self.skipWaiting();
  });
  
  // ====== ACTIVATE ======
  self.addEventListener("activate", (event) => {
    event.waitUntil((async () => {
      await cleanupOldCaches();
      await self.clients.claim();
    })());
  });
  
  // ====== MESSAGE ======
  self.addEventListener("message", (event) => {
    const data = event.data || {};
    if (data.type === "SKIP_WAITING") {
      self.skipWaiting();
      return;
    }
    
    if (data.type === "CLEAR_ALL_CACHES") {
      event.waitUntil((async () => {
        await caches.delete(CORE_CACHE);
        await caches.delete(RUNTIME_CACHE);
      })());
      return;
    }
    
    if (data.type === "CLEAR_RUNTIME") {
      event.waitUntil(caches.delete(RUNTIME_CACHE));
      return;
    }
  });
  
  // ====== FETCH ======
  self.addEventListener("fetch", (event) => {
    const req = event.request;
    const url = new URL(req.url);
    
    // Apenas GET e mesmo domínio
    if (req.method !== "GET") return;
    if (!isSameOrigin(url)) return;
    
    const accept = req.headers.get("accept") || "";
    const isHTML = req.mode === "navigate" || accept.includes("text/html");
    const isJSON = url.pathname.endsWith(".json");
    
    // 1) NAV/HTML: network-first
    if (isHTML) {
      event.respondWith((async () => {
        try {
          const res = await fetch(req);
          event.waitUntil(cachePut(CORE_CACHE, req, res.clone()));
          return res;
        } catch {
          // offline fallback
          return (await caches.match(req)) || (await caches.match("./index.html"));
        }
      })());
      return;
    }
    
    // 2) JSON: stale-while-revalidate (ótimo para news.json)
    if (isJSON) {
      event.respondWith((async () => {
        const cached = await caches.match(req);
        
        const fetchPromise = fetch(req)
          .then((res) => {
            event.waitUntil(cachePut(RUNTIME_CACHE, req, res.clone()));
            return res;
          })
          .catch(() => null);
        
        // Se tem cache, entrega já; atualiza em background
        if (cached) {
          event.waitUntil(fetchPromise);
          return cached;
        }
        
        // Sem cache: tenta rede, senão fallback JSON vazio
        const net = await fetchPromise;
        return net || new Response("[]", { headers: { "content-type": "application/json" } });
      })());
      return;
    }
    
    // 3) ASSETS: cache-first + revalidate em background
    event.respondWith((async () => {
      const cached = await caches.match(req);
      if (cached) {
        // atualiza em background
        event.waitUntil(
          fetch(req)
          .then(res => cachePut(RUNTIME_CACHE, req, res.clone()))
          .catch(() => null)
        );
        return cached;
      }
      
      try {
        const res = await fetch(req);
        event.waitUntil(cachePut(RUNTIME_CACHE, req, res.clone()));
        return res;
      } catch {
        return new Response("", { status: 504, statusText: "Offline" });
      }
    })());
  });
})();