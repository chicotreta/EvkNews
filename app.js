/* app.js — EVK News (PWA) “máximo e completo”
   + Swipe Hint (seta)
   + Fallback Offline
   + GA4 events (gtag): view_item, select_content, share, outbound_click

   Requisitos no HTML:
   - #slides, #topicChips, #newsSwiper, #topProgress
   - Sheet: #sheet, #sheetBackdrop, #sheetClose, #sheetMeta, #sheetTitle, #sheetDesc, #sheetOpen
   - FAB: #fabMenu
   Opcional (se existirem):
   - #appToast, #offlineBanner, #updateBar, #btnUpdateNow, #btnUpdateLater
   - Swipe hint: #swipeHint (se não existir, o app cria automaticamente)
*/

(() => {
  // =========================
  // CONFIG
  // =========================
  const APP = {
    NAME: "evknews",
    VERSION: "3.0.2",
    BUILD_TIME: "2026-01-19 00:00",
    NEWS_URL: "./news.json",

    LS_NEWS_KEY: "evknews:last_json",
    LS_NEWS_ETAG: "evknews:last_etag",
    LS_NEWS_HASH: "evknews:last_hash",
    LS_LAST_OK: "evknews:last_ok",

    MAX_LOCAL_NEWS_BYTES: 2_000_000,

    LS_HINT_SEEN: "evknews:swipe_hint_seen",
    HINT_MS: 3200,

    // GA: evita spam quando slideChange dispara repetido
    GA_VIEW_DEBOUNCE_MS: 450
  };

  // =========================
  // STATE
  // =========================
  const state = {
    all: [],
    filtered: [],
    activeTag: null,
    swiper: null,
    current: null,
    sw: { reg: null, hasUpdate: false, waiting: null },

    ga: {
      lastViewId: null,
      lastViewTs: 0
    }
  };

  // =========================
  // GA4 (gtag) helpers
  // =========================
  function gaEvent(name, params) {
    if (typeof window.gtag !== "function") return;
    window.gtag("event", name, params || {});
  }

  function isFallbackItem(n) {
    return !!n && String(n.id || "").startsWith("fallback-");
  }

  function gaNewsParams(n) {
    return {
      item_id: n?.id || "",
      item_name: n?.title || "",
      item_brand: n?.source || "",
      item_category: (n?.tags && n.tags[0]) ? n.tags[0] : "",
      item_category2: (n?.tags && n.tags[1]) ? n.tags[1] : "",
      content_type: "news",
      source: n?.source || "",
      url: n?.url || ""
    };
  }

  function gaViewItem(n) {
    if (!n || isFallbackItem(n)) return;

    const now = Date.now();
    const id = String(n.id || "");

    // debounce + dedupe
    if (state.ga.lastViewId === id && (now - state.ga.lastViewTs) < APP.GA_VIEW_DEBOUNCE_MS) return;

    state.ga.lastViewId = id;
    state.ga.lastViewTs = now;

    gaEvent("view_item", { items: [gaNewsParams(n)] });
  }

  // =========================
  // DOM
  // =========================
  const elSlides = document.getElementById("slides");
  const elChips = document.getElementById("topicChips");

  const sheet = document.getElementById("sheet");
  const sheetBackdrop = document.getElementById("sheetBackdrop");
  const sheetClose = document.getElementById("sheetClose");
  const sheetMeta = document.getElementById("sheetMeta");
  const sheetTitle = document.getElementById("sheetTitle");
  const sheetDesc = document.getElementById("sheetDesc");
  const sheetOpen = document.getElementById("sheetOpen");

  const elFabMenu = document.getElementById("fabMenu");

  // opcionais
  const elToast = document.getElementById("appToast");
  const elOfflineBanner = document.getElementById("offlineBanner");
  const elUpdateBar = document.getElementById("updateBar");
  const btnUpdateNow = document.getElementById("btnUpdateNow");
  const btnUpdateLater = document.getElementById("btnUpdateLater");

  // =========================
  // UTILS
  // =========================
  function escapeHtml(str = "") {
    return String(str).replace(/[&<>"']/g, (m) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;"
    }[m]));
  }

  function safeText(s, max = 5000) {
    const x = String(s ?? "");
    return x.length > max ? x.slice(0, max) + "…" : x;
  }

  function cssEscape(x) {
    try { return CSS.escape(x); }
    catch { return String(x).replace(/"/g, '\\"'); }
  }

  function isStandalone() {
    return (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) ||
      (navigator.standalone === true);
  }

  function toast(msg) {
    const text = String(msg ?? "");
    if (!text) return;

    if (elToast) {
      elToast.textContent = text;
      elToast.style.opacity = "1";
      clearTimeout(toast._t);
      toast._t = setTimeout(() => (elToast.style.opacity = "0"), 1800);
      return;
    }
    console.log("[toast]", text);
  }

  function dbg(msg, data) {
    window.__debugLog?.(msg, data);
  }

  async function sha1(str) {
    const buf = new TextEncoder().encode(str);
    const digest = await crypto.subtle.digest("SHA-1", buf);
    const arr = Array.from(new Uint8Array(digest));
    return arr.map(b => b.toString(16).padStart(2, "0")).join("");
  }

  function normalizeItem(n, idx) {
    const id = (n && (n.id ?? n.url ?? n.title)) ?? String(idx);
    const tags = Array.isArray(n?.tags)
      ? n.tags.map(t => String(t).trim()).filter(Boolean)
      : [];

    const rawImg = String(n?.image ?? "");
    const imgOk =
      rawImg.startsWith("http://") ||
      rawImg.startsWith("https://") ||
      rawImg.startsWith("./") ||
      rawImg.startsWith("/") ||
      rawImg.startsWith("data:");

    // fallback seguro: PNG (SVG costuma falhar por MIME/caching em hostings)
    const image = imgOk ? rawImg : "./evknews.png";

    return {
      id: String(id),
      title: safeText(n?.title ?? "Sem título", 200),
      desc: safeText(n?.desc ?? "", 5000),
      source: safeText(n?.source ?? "", 80),
      credit: safeText(n?.credit ?? "", 120),
      image: safeText(image ?? "", 800),
      img_credit: safeText(n?.img_credit ?? "", 200),
      url: safeText(n?.url ?? "", 800),
      tags,
      date: safeText(n?.date ?? "", 40)
    };
  }

  function uniqueTags(items) {
    const set = new Set();
    items.forEach(n => (n.tags || []).forEach(t => set.add(t)));
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }

  function setOfflineBanner() {
    if (!elOfflineBanner) return;
    elOfflineBanner.style.display = navigator.onLine ? "none" : "block";
  }

  // =========================
  // FALLBACK (sem notícias / offline)
  // =========================
  function getFallbackItems(reason = "offline") {
    const title =
      reason === "offline"
        ? "Offline — sem cache disponível"
        : "Erro ao carregar o feed";

    const desc =
      reason === "offline"
        ? "Conecte-se à internet ao menos uma vez para salvar o feed em cache. Depois disso, o app abre offline."
        : "Falha ao buscar o arquivo news.json. Verifique se ele existe em /news/ e tente novamente.";

    return [
      normalizeItem({
        id: `fallback-${reason}`,
        source: "EVK News",
        title,
        desc,
        image: "./evknews.png",
        credit: "EVK",
        tags: ["Status", "Ajuda"],
        url: "./"
      }, 0)
    ];
  }

  // =========================
  // SWIPE HINT (seta)
  // =========================
  function ensureSwipeHintElement() {
    let el = document.getElementById("swipeHint");
    if (el) return el;

    el = document.createElement("div");
    el.id = "swipeHint";
    el.className = "swipeHint";
    el.setAttribute("aria-hidden", "true");
    el.innerHTML = `
      <span class="swipeHint__arrow">⌃</span>
      <span class="swipeHint__text">Deslize</span>
    `;
    document.body.appendChild(el);

    const style = document.createElement("style");
    style.textContent = `
      .swipeHint{
        position: fixed;
        left: 50%;
        bottom: calc(140px + env(safe-area-inset-bottom, 0px));
        transform: translateX(-50%) translateY(10px);
        z-index: 85;
        pointer-events: none;
        display: grid;
        place-items: center;
        gap: 6px;
        opacity: 0;
        transition: opacity .25s ease, transform .25s ease;
      }
      .swipeHint.is-on{
        opacity: .55;
        transform: translateX(-50%) translateY(0);
      }
      .swipeHint__arrow{
        font-size: 28px;
        line-height: 1;
        color: #fff;
        text-shadow: 0 10px 24px rgba(0,0,0,.55);
        animation: swipeHintBounce 1.1s ease-in-out infinite;
      }
      .swipeHint__text{
        font-size: 12px;
        font-weight: 700;
        letter-spacing: .08em;
        text-transform: uppercase;
        color: rgba(255,255,255,.85);
        text-shadow: 0 10px 24px rgba(0,0,0,.55);
      }
      @keyframes swipeHintBounce{
        0%   { transform: translateY(6px); opacity: .65; }
        50%  { transform: translateY(-6px); opacity: 1; }
        100% { transform: translateY(6px); opacity: .65; }
      }
    `;
    document.head.appendChild(style);

    return el;
  }

  function showSwipeHintOnce() {
    if (localStorage.getItem(APP.LS_HINT_SEEN) === "1") return;

    const el = ensureSwipeHintElement();
    el.classList.add("is-on");

    const t = setTimeout(() => {
      el.classList.remove("is-on");
      localStorage.setItem(APP.LS_HINT_SEEN, "1");
    }, APP.HINT_MS);

    const hideNow = () => {
      clearTimeout(t);
      el.classList.remove("is-on");
      localStorage.setItem(APP.LS_HINT_SEEN, "1");
      if (state.swiper) {
        state.swiper.off("touchMove", hideNow);
        state.swiper.off("slideChange", hideNow);
        state.swiper.off("wheel", hideNow);
      }
    };

    if (state.swiper) {
      state.swiper.on("touchMove", hideNow);
      state.swiper.on("slideChange", hideNow);
      state.swiper.on("wheel", hideNow);
    }
  }

  // =========================
  // RENDER: CHIPS
  // =========================
  function makeChip(label, tag) {
    const b = document.createElement("button");
    b.className = "chip";
    b.type = "button";
    b.textContent = label;
    b.dataset.tag = tag ?? "__all__";
    return b;
  }

  function syncChipActive() {
    const chips = elChips?.querySelectorAll(".chip");
    if (!chips) return;
    chips.forEach(c => c.classList.remove("active"));
    const key = state.activeTag ?? "__all__";
    const active = elChips.querySelector(`.chip[data-tag="${cssEscape(key)}"]`);
    if (active) active.classList.add("active");
  }

  function renderChips() {
    if (!elChips) return;
    const tags = uniqueTags(state.all);
    elChips.innerHTML = "";
    elChips.appendChild(makeChip("Todos", null));
    tags.forEach(t => elChips.appendChild(makeChip(t, t)));
    syncChipActive();
  }

  function applyFilter(tagOrNull) {
    state.activeTag = tagOrNull;
    syncChipActive();

    if (!state.activeTag) state.filtered = [...state.all];
    else state.filtered = state.all.filter(n => (n.tags || []).includes(state.activeTag));

    rebuildSlides();
  }

  // =========================
  // RENDER: SLIDES
  // =========================
  function slideTemplate(n) {
    const img = escapeHtml(n.image || "");
    const source = escapeHtml(n.source || "");
    const title = escapeHtml(n.title || "");
    const credit = escapeHtml(n.credit || "");
    const mediaStyle = img ? `style="background-image:url('${img}')"` : "";

    return `
      <article class="swiper-slide slide" data-id="${escapeHtml(n.id)}" role="article" aria-label="${title}">
        <div class="slide__media" ${mediaStyle}></div>
        <div class="slide__overlay"></div>

        <footer class="slide__bottom" style="z-index:20; left:14px; right:14px;">
          <div class="kicker">
            <span class="kicker__bar"></span>
            <span class="kicker__source">${source}</span>
          </div>
          <h1 class="title">${title}</h1>
        </footer>

        ${credit ? `<div class="credit">${credit}</div>` : ""}
      </article>
    `;
  }

  function destroySwiper() {
    if (state.swiper) {
      try { state.swiper.destroy(true, true); } catch {}
      state.swiper = null;
    }
  }

  function rebuildSlides() {
    if (!elSlides) return;

    destroySwiper();
    elSlides.innerHTML = (state.filtered.length ? state.filtered : [])
      .map(slideTemplate)
      .join("");

    if (typeof Swiper === "undefined") {
      toast("Swiper não carregou");
      return;
    }

    state.swiper = new Swiper("#newsSwiper", {
      direction: "vertical",
      slidesPerView: 1,
      speed: 420,
      mousewheel: true,
      pagination: { el: "#topProgress", clickable: true }
    });

    state.current = state.filtered[0] || null;

    // GA: primeira visualização
    gaViewItem(state.current);

    state.swiper.on("slideChange", () => {
      state.current = state.filtered[state.swiper.activeIndex] || null;
      gaViewItem(state.current);
    });

    showSwipeHintOnce();
    dbg("slides: rebuilt", { total: state.filtered.length, activeTag: state.activeTag });
  }

  // =========================
  // SHEET
  // =========================
  function openSheet(n) {
    if (!n || !sheet) return;

    // GA
    if (!isFallbackItem(n)) {
      gaEvent("select_content", {
        content_type: "news_sheet",
        ...gaNewsParams(n)
      });
    }

    sheetMeta.textContent = n.source || "";
    sheetTitle.textContent = n.title || "";
    sheetDesc.textContent = n.desc || "";
    sheetOpen.href = n.url || "#";
    sheetOpen.rel = "noopener noreferrer";
    sheetOpen.target = "_blank";
sheetDesc.textContent = (n.desc || "") + (n.img_credit ? `\n\n${n.img_credit}` : "");
    sheet.setAttribute("aria-hidden", "false");
    dbg("sheet: open", { id: n.id });
  }

  function closeSheet() {
    if (!sheet) return;
    sheet.setAttribute("aria-hidden", "true");
  }

  // =========================
  // EVENTS (delegados)
  // =========================
  function onSlidesClick(e) {
    const slide = e.target.closest(".swiper-slide[data-id]");
    if (!slide) return;

    const id = slide.getAttribute("data-id");
    const n =
      state.filtered.find(x => x.id === String(id)) ||
      state.all.find(x => x.id === String(id));
    if (!n) return;

    // se for fallback, tenta recarregar
    if (isFallbackItem(n)) {
      loadNews();
      return;
    }

    state.current = n;
    openSheet(n);
  }

  function onChipsClick(e) {
    const chip = e.target.closest(".chip[data-tag]");
    if (!chip) return;

    const tag = chip.dataset.tag;
    applyFilter(tag === "__all__" ? null : tag);
  }

  async function shareNews(n) {
    if (!n || isFallbackItem(n)) return;

    // GA (antes do share para capturar mesmo se cancelar)
    gaEvent("share", {
      method: navigator.share ? "native" : "copy",
      content_type: "news",
      ...gaNewsParams(n)
    });

    const payload = { title: n.title, text: n.desc || n.title, url: n.url };
    try {
      if (navigator.share) {
        await navigator.share(payload);
      } else if (navigator.clipboard && n.url) {
        await navigator.clipboard.writeText(n.url);
        toast("Link copiado");
      } else {
        toast("Sem share/clipboard");
      }
      dbg("share: ok", { id: n.id });
    } catch (err) {
      dbg("share: fail", { error: String(err) });
    }
  }

  // =========================
  // NEWS LOAD (robusto)
  // =========================
  function loadLocalNews() {
    const raw = localStorage.getItem(APP.LS_NEWS_KEY);
    if (!raw) return null;
    try {
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return null;
      return arr.map(normalizeItem);
    } catch {
      return null;
    }
  }

  function saveLocalNews(items) {
    try {
      const raw = JSON.stringify(items);
      if (raw.length > APP.MAX_LOCAL_NEWS_BYTES) return;
      localStorage.setItem(APP.LS_NEWS_KEY, raw);
      localStorage.setItem(APP.LS_LAST_OK, new Date().toISOString());
    } catch {
      // ignore
    }
  }

  async function fetchNewsNetwork() {
    const headers = {};
    const etag = localStorage.getItem(APP.LS_NEWS_ETAG);
    if (etag) headers["If-None-Match"] = etag;

    const res = await fetch(APP.NEWS_URL, { headers });
    if (res.status === 304) return { notModified: true, items: null, etag };
    if (!res.ok) throw new Error(`news fetch status ${res.status}`);

    const newEtag = res.headers.get("ETag") || "";
    const txt = await res.text();
    const hash = await sha1(txt);

    const lastHash = localStorage.getItem(APP.LS_NEWS_HASH);
    if (lastHash && lastHash === hash) {
      if (newEtag) localStorage.setItem(APP.LS_NEWS_ETAG, newEtag);
      return { notModified: true, items: null, etag: newEtag || etag };
    }

    const json = JSON.parse(txt);
    if (!Array.isArray(json)) throw new Error("news.json não é array");

    const items = json.map(normalizeItem);
    if (newEtag) localStorage.setItem(APP.LS_NEWS_ETAG, newEtag);
    localStorage.setItem(APP.LS_NEWS_HASH, hash);

    return { notModified: false, items, etag: newEtag };
  }

  async function loadNews() {
    const local = loadLocalNews();

    // 1) render rápido do local (se existir)
    if (local && local.length) {
      state.all = local;
      state.filtered = state.activeTag
        ? local.filter(n => (n.tags || []).includes(state.activeTag))
        : [...local];

      renderChips();
      rebuildSlides();
      dbg("news: loaded local", { n: local.length });
    }

    // 2) tenta rede para atualizar
    try {
      const net = await fetchNewsNetwork();
      if (net.notModified) return;

      if (net.items && net.items.length) {
        state.all = net.items;
        state.filtered = state.activeTag
          ? net.items.filter(n => (n.tags || []).includes(state.activeTag))
          : [...net.items];

        saveLocalNews(net.items);
        renderChips();
        rebuildSlides();
        toast("Feed atualizado");
        dbg("news: updated from network", { n: net.items.length });
      }
    } catch (err) {
      dbg("news: network fail", { error: String(err) });

      // 3) se não existe local, entra o fallback
      if (!local || !local.length) {
        const reason = navigator.onLine ? "error" : "offline";
        const fallback = getFallbackItems(reason);

        state.all = fallback;
        state.filtered = [...fallback];
        state.activeTag = null;

        renderChips();
        rebuildSlides();
        toast(reason === "offline" ? "Offline" : "Erro ao carregar feed");
      }
    }
  }

  // =========================
  // SERVICE WORKER (registro + update UX)
  // =========================
  function showUpdateBar(show) {
    if (!elUpdateBar) return;
    elUpdateBar.style.display = show ? "block" : "none";
  }

  async function registerSW() {
    if (!("serviceWorker" in navigator)) return;

    try {
      const reg = await navigator.serviceWorker.register("./service-worker.js");
      state.sw.reg = reg;

      if (reg.waiting) showUpdateBar(true);

      reg.addEventListener("updatefound", () => {
        const newWorker = reg.installing;
        if (!newWorker) return;

        newWorker.addEventListener("statechange", () => {
          if (newWorker.state === "installed" && navigator.serviceWorker.controller) {
            showUpdateBar(true);
          }
        });
      });

      navigator.serviceWorker.addEventListener("controllerchange", () => {
        location.reload();
      });
    } catch (err) {
      dbg("sw: register fail", { error: String(err) });
    }
  }

  function requestSkipWaiting() {
    const w = state.sw.reg?.waiting;
    if (w) {
      w.postMessage({ type: "SKIP_WAITING" });
      return;
    }
    navigator.serviceWorker?.controller?.postMessage({ type: "SKIP_WAITING" });
  }

  // =========================
  // INIT + WIRES
  // =========================
  function wireEvents() {
    if (elSlides) elSlides.addEventListener("click", onSlidesClick, { passive: true });
    if (elChips) elChips.addEventListener("click", onChipsClick, { passive: true });

    if (sheetBackdrop) sheetBackdrop.addEventListener("click", closeSheet);
    if (sheetClose) sheetClose.addEventListener("click", closeSheet);

    // GA: clique “Abrir fonte” (outbound)
    if (sheetOpen) {
      sheetOpen.addEventListener("click", () => {
        if (!state.current || isFallbackItem(state.current)) return;
        gaEvent("outbound_click", {
          link_url: state.current.url || "",
          ...gaNewsParams(state.current)
        });
      });
    }

    if (elFabMenu) {
      elFabMenu.addEventListener("click", () => {
        if (state.current && !isFallbackItem(state.current)) openSheet(state.current);
      });
    }

    document.addEventListener("click", (e) => {
      const fixedShare = e.target.closest("[data-action='shareFixed']");
      if (fixedShare && state.current) shareNews(state.current);
    });

    if (btnUpdateNow) btnUpdateNow.addEventListener("click", requestSkipWaiting);
    if (btnUpdateLater) btnUpdateLater.addEventListener("click", () => showUpdateBar(false));

    window.addEventListener("online", () => { setOfflineBanner(); loadNews(); });
    window.addEventListener("offline", setOfflineBanner);
  }

  async function init() {
    dbg("app: init", { version: APP.VERSION, build: APP.BUILD_TIME, standalone: isStandalone() });
    setOfflineBanner();
    wireEvents();
    await registerSW();
    await loadNews();
  }

  init().catch(err => console.error(err));
})();