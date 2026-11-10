// Camada visual do agente: um ponteiro neon unico, num shadow root fechado, no top
// layer. Nao tem UI de chat (o chat agora e o painel lateral nativo do Chrome).
(() => {
  if (window.__swarmPointerLoaded) return;
  window.__swarmPointerLoaded = true;

  const HOST_ID = "__swarm_pilot__";
  if (document.getElementById(HOST_ID)) return;

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .layer { position: fixed; inset: 0; pointer-events: none; overflow: visible; }
    .ptr {
      position: absolute; left: 0; top: 0; width: 30px; height: 30px; margin: -2px 0 0 -2px;
      opacity: 0; will-change: transform; transition: opacity .1s linear; --neon: #22d3ee;
    }
    .ptr.on { opacity: 1; }
    .ptr svg { width: 30px; height: 30px; overflow: visible;
      filter: drop-shadow(0 0 1.5px var(--neon)) drop-shadow(0 0 6px var(--neon)); }
    .ptr path.body { fill: rgba(6,10,14,.78); stroke: var(--neon); stroke-width: 1.6; stroke-linejoin: round; }
    .ptr path.core { fill: var(--neon); }
    .ptr .tip {
      position: absolute; left: 0; top: 0; width: 5px; height: 5px; margin: -2.5px 0 0 -2.5px;
      border-radius: 50%; background: #fff; box-shadow: 0 0 4px var(--neon), 0 0 10px var(--neon);
    }
    .ptr .halo {
      position: absolute; left: 0; top: 0; width: 54px; height: 54px; margin: -27px 0 0 -27px;
      border-radius: 50%; background: radial-gradient(circle, var(--neon) 0%, transparent 62%);
      opacity: .22;
    }
    .ptr .tag {
      position: absolute; left: 20px; top: 20px; padding: 1px 6px; border-radius: 5px;
      background: rgba(6,10,14,.88); color: var(--neon); border: 1px solid var(--neon);
      font: 10px/1.3 ui-monospace, monospace; white-space: nowrap; max-width: 260px; overflow: hidden;
      text-overflow: ellipsis; text-shadow: 0 0 6px var(--neon); box-shadow: 0 0 9px rgba(34,211,238,.3);
      opacity: 0; transition: opacity .14s linear;
    }
    .ptr .tag.on { opacity: .95; }
    .streak {
      position: absolute; left: 0; top: 0; height: 2px; width: 62px; transform-origin: 0 50%;
      background: linear-gradient(90deg, transparent 0%, var(--neon) 85%, #fff 100%);
      filter: blur(.6px) drop-shadow(0 0 6px var(--neon)); opacity: 0; --neon: #22d3ee;
    }
    .pulse {
      position: absolute; width: 14px; height: 14px; margin: -7px 0 0 -7px; border-radius: 50%;
      border: 2px solid var(--neon); box-shadow: 0 0 10px var(--neon), inset 0 0 7px var(--neon);
      animation: pulse .5s ease-out forwards;
    }
    @keyframes pulse { from { transform: scale(.5); opacity: 1; } to { transform: scale(4.2); opacity: 0; } }
  `;

  const host = document.createElement("div");
  host.id = HOST_ID;
  // popover manual = top layer: ganha de <dialog>.showModal(), fullscreen, z-index
  // absurdo e de ancestral com transform (que quebra position: fixed).
  host.setAttribute("popover", "manual");
  host.style.cssText =
    "position:fixed;left:0;top:0;width:0;height:0;margin:0;padding:0;border:0;" +
    "background:transparent;overflow:visible;z-index:2147483646;display:block;pointer-events:none;";
  (document.documentElement || document.body).appendChild(host);

  function toTopLayer() {
    try {
      if (!host.showPopover || host.matches(":popover-open")) return false;
      try { host.hidePopover(); } catch (e) {}
      host.showPopover();
      return true;
    } catch (e) { return false; }
  }
  toTopLayer();

  const shadow = host.attachShadow({ mode: "closed" });
  const wrap = document.createElement("div");
  wrap.innerHTML = `<style>${CSS}</style><div class="layer"></div>`;
  shadow.appendChild(wrap);
  const layer = shadow.querySelector(".layer");

  const ptr = document.createElement("div");
  ptr.className = "ptr";
  ptr.innerHTML = `<span class="halo"></span>
    <svg viewBox="0 0 28 28"><path class="body" d="M5.2 2.8 L23.2 15.4 L15.1 16.9 L11.6 25.1 Z"/><path class="core" d="M8.6 7.4 L17.2 13.2 L12.9 14.1 L11.1 18.4 Z"/></svg>
    <span class="tip"></span><span class="tag"></span>`;
  layer.appendChild(ptr);
  host.dataset.ptrs = String(layer.querySelectorAll(".ptr").length);
  const streak = document.createElement("div");
  streak.className = "streak";
  layer.appendChild(streak);
  const tagEl = ptr.querySelector(".tag");

  let cfg = { pointerMs: 320, neon: "#22d3ee" };
  let pos = { x: Math.round(innerWidth * 0.5), y: Math.round(innerHeight * 0.62) };

  try {
    chrome.storage.sync.get("sp_config").then((got) => {
      const c = got?.sp_config || {};
      if (Number(c.pointerMs)) cfg.pointerMs = Number(c.pointerMs);
      if (/^#[0-9a-f]{6}$/i.test(c.neon || "")) cfg.neon = c.neon;
      paint();
    }).catch(() => {});
  } catch (e) {}

  function paint() {
    ptr.style.setProperty("--neon", cfg.neon);
    streak.style.setProperty("--neon", cfg.neon);
  }
  paint();

  const place = (x, y) => { ptr.style.transform = `translate(${x}px, ${y}px)`; };
  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

  function flash(x, y) {
    const p = document.createElement("div");
    p.className = "pulse";
    p.style.left = x + "px";
    p.style.top = y + "px";
    p.style.setProperty("--neon", cfg.neon);
    layer.appendChild(p);
    setTimeout(() => p.remove(), 520);
  }

  let tagTimer = 0;

  async function pointerTo(x, y, label, press) {
    const dur = Math.max(120, Math.min(900, Number(cfg.pointerMs) || 320));
    // aba oculta nao roda requestAnimationFrame: sem este atalho a animacao nunca
    // termina e o clique (que espera o ponteiro) nunca acontece.
    if (document.visibilityState === "hidden") {
      pos = { x, y };
      place(x, y);
      host.dataset.ptr = Math.round(x) + "," + Math.round(y);
      host.dataset.swarming = "1";
      setTimeout(() => { host.dataset.swarming = "0"; }, 30);
      if (press) flash(x, y);
      return true;
    }
    host.dataset.swarming = "1";
    if (label) {
      tagEl.textContent = String(label).slice(0, 26);
      tagEl.classList.add("on");
    } else {
      tagEl.classList.remove("on");
    }
    const sx = pos.x, sy = pos.y;
    const dist = Math.hypot(x - sx, y - sy);
    const ux = dist ? -(y - sy) / dist : 0;
    const uy = dist ? (x - sx) / dist : 0;
    const bow = Math.min(64, dist * 0.13);
    const ang = Math.atan2(y - sy, x - sx);
    const t0 = performance.now();
    await new Promise((resolve) => {
      const tick = () => {
        const t = Math.min(1, (performance.now() - t0) / dur);
        const e = ease(t);
        const cx = sx + (x - sx) * e + ux * Math.sin(e * Math.PI) * bow;
        const cy = sy + (y - sy) * e + uy * Math.sin(e * Math.PI) * bow;
        place(cx, cy);
        ptr.classList.add("on");
        streak.style.transform = `translate(${cx}px, ${cy - 1}px) rotate(${ang}rad)`;
        streak.style.opacity = String(Math.min(0.85, dist / 240) * Math.max(0, 1 - Math.abs(0.5 - t) * 1.5));
        if (t >= 1) resolve();
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    streak.style.opacity = "0";
    pos = { x, y };
    host.dataset.ptr = Math.round(x) + "," + Math.round(y);
    if (press) flash(x, y);
    host.dataset.swarming = "0";
    clearTimeout(tagTimer);
    tagTimer = setTimeout(() => tagEl.classList.remove("on"), 1100);
    return true;
  }

  // SPA troca o body inteiro: se o host sair do documento, ele volta com o mesmo
  // shadow root e o mesmo estado.
  const keeper = new MutationObserver(() => {
    if (!host.isConnected) {
      (document.documentElement || document.body).appendChild(host);
      toTopLayer();
    }
  });
  keeper.observe(document.documentElement, { childList: true });
  if (document.body) keeper.observe(document.body, { childList: true });

  // dialogo modal deixa o resto inerte e pinta acima: entrar nele mantem o ponteiro
  // visivel e no top layer certo.
  function ensureTop() {
    const modal = document.querySelector("dialog[open]");
    const parent = modal || document.documentElement;
    if (host.parentElement !== parent) parent.appendChild(host);
    toTopLayer();
  }
  window.addEventListener("resize", ensureTop);
  document.addEventListener("fullscreenchange", ensureTop);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) ensureTop(); });
  setInterval(ensureTop, 1500);
  ensureTop();

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === "pointer" || msg.type === "swarm") {
      pointerTo(msg.x, msg.y, msg.label, msg.press !== false).then(() => sendResponse({ done: true }));
      return true;
    }
    if (msg.type === "ping-pointer") {
      sendResponse({ ok: true, ptrs: host.dataset.ptrs });
      return false;
    }
    return false;
  });

  chrome.storage.onChanged.addListener((changes) => {
    if (!changes.sp_config) return;
    const c = changes.sp_config.newValue || {};
    if (Number(c.pointerMs)) cfg.pointerMs = Number(c.pointerMs);
    if (/^#[0-9a-f]{6}$/i.test(c.neon || "")) cfg.neon = c.neon;
    paint();
  });
})();
