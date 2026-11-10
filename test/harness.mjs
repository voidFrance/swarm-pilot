// Bancada comum: sobe chromium com a extensao, serve test/, anexa no service worker
// e no painel lateral, e expoe eval por sessao. Cada teste cuida so das assercoes.
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import net from "node:net";

export const EXT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function waitPort(port, timeout = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const up = await new Promise((resolve) => {
      const s = net.connect(port, "127.0.0.1");
      s.on("connect", () => { s.destroy(); resolve(true); });
      s.on("error", () => resolve(false));
    });
    if (up) return true;
    await sleep(150);
  }
  return false;
}

export class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
      }
    };
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error("timeout " + method)); } }, 45000);
    });
  }
  async eval(sessionId, expression, opts = {}) {
    const r = await this.send("Runtime.evaluate", {
      expression, returnByValue: true, awaitPromise: opts.awaitPromise !== false, userGesture: true,
    }, sessionId);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result?.value;
  }
  async type(sessionId, text) {
    for (const ch of text) {
      const upper = ch.toUpperCase();
      const base = {
        key: ch,
        code: /[a-z]/i.test(ch) ? "Key" + upper : ch === " " ? "Space" : "Digit" + ch,
        windowsVirtualKeyCode: /[a-z0-9]/i.test(ch) ? upper.charCodeAt(0) : ch.charCodeAt(0),
        text: ch, unmodifiedText: ch,
      };
      await this.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base }, sessionId);
      await this.send("Input.dispatchKeyEvent", { type: "char", ...base }, sessionId);
      await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...base }, sessionId);
      await sleep(30);
    }
  }
}

export async function boot({ port, srv, page, profile }) {
  rmSync(profile, { recursive: true, force: true });
  const server = spawn("python3", ["-m", "http.server", String(srv), "--bind", "127.0.0.1"], { cwd: EXT + "/test", stdio: "ignore" });
  const chrome = spawn("/usr/bin/chromium", [
    "--headless=new", "--user-data-dir=" + profile,
    "--load-extension=" + EXT, "--disable-extensions-except=" + EXT,
    "--remote-debugging-port=" + port, "--no-first-run", "--no-default-browser-check",
    "--disable-gpu", "--window-size=1280,900",
    "http://127.0.0.1:" + srv + "/" + page,
  ], { stdio: "ignore" });

  const cleanup = () => {
    try { chrome.kill("SIGKILL"); } catch (e) {}
    try { server.kill("SIGKILL"); } catch (e) {}
  };

  if (!(await waitPort(port))) { cleanup(); throw new Error("chromium nao abriu a porta de debug"); }
  if (!(await waitPort(srv, 6000))) { cleanup(); throw new Error("servidor de teste nao subiu"); }

  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  const cdp = new Cdp(ws);

  let pageSession = null;
  let pageTargetId = null;
  for (let i = 0; i < 60 && !pageSession; i++) {
    const { targetInfos } = await cdp.send("Target.getTargets");
    const t = targetInfos.find((x) => x.type === "page" && x.url.includes(page));
    if (t) {
      pageTargetId = t.targetId;
      const r = await cdp.send("Target.attachToTarget", { targetId: t.targetId, flatten: true });
      pageSession = r.sessionId;
    } else await sleep(250);
  }
  if (!pageSession) { cleanup(); throw new Error("aba de teste nao encontrada"); }
  await cdp.send("Page.enable", {}, pageSession);

  let extId = null;
  // o service worker do MV3 morre por ociosidade: anexar de novo a cada chamada.
  const swEval = async (expression) => {
    let lastErr = null;
    for (let i = 0; i < 40; i++) {
      try {
        const { targetInfos } = await cdp.send("Target.getTargets");
        const t = targetInfos.find((x) => x.type === "service_worker" && x.url.startsWith("chrome-extension://"));
        if (t) {
          extId = new URL(t.url).host;
          const r = await cdp.send("Target.attachToTarget", { targetId: t.targetId, flatten: true });
          await cdp.send("Runtime.enable", {}, r.sessionId).catch(() => {});
          if (!(await cdp.eval(r.sessionId, "typeof chrome"))) { await sleep(200); continue; }
          return await cdp.eval(r.sessionId, expression);
        }
      } catch (e) { lastErr = e; }
      await sleep(250);
    }
    throw lastErr || new Error("service worker nao respondeu");
  };

  for (let i = 0; i < 40; i++) {
    if (await cdp.eval(pageSession, "!!document.getElementById('__swarm_pilot__')", { awaitPromise: false })) break;
    await sleep(200);
  }

  const tabs = async () => swEval("chrome.tabs.query({}).then(ts => ts.map(t => ({ id: t.id, url: t.url, title: t.title })))");
  const pageTab = async () => (await tabs()).find((t) => String(t.url || "").includes(page));

  const setConfig = (cfg) => swEval(`chrome.storage.sync.set({ sp_config: ${JSON.stringify(cfg)} }).then(() => "ok")`);
  const setLocal = (obj) => swEval(`chrome.storage.local.set(${JSON.stringify(obj)}).then(() => "ok")`);

  // Abre o painel lateral como aba (o chrome://sidepanel real nao e acessivel no
  // headless) e devolve a sessao dele. Depois reativa a aba alvo, senao o
  // background resolveria "aba ativa" para o proprio painel.
  const openPanel = async () => {
    for (let i = 0; i < 40 && !extId; i++) {
      const { targetInfos } = await cdp.send("Target.getTargets");
      const t = targetInfos.find((x) => x.type === "service_worker" && x.url.startsWith("chrome-extension://"));
      if (t) extId = new URL(t.url).host;
      else await sleep(200);
    }
    if (!extId) throw new Error("id da extensao desconhecido");
    const { targetId } = await cdp.send("Target.createTarget", { url: `chrome-extension://${extId}/sidepanel.html` });
    let session = null;
    for (let i = 0; i < 40 && !session; i++) {
      try {
        const r = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
        await cdp.send("Runtime.enable", {}, r.sessionId).catch(() => {});
        if (await cdp.eval(r.sessionId, "document.readyState", { awaitPromise: false })) session = r.sessionId;
      } catch (e) { await sleep(200); }
    }
    await sleep(600);
    const tab = await pageTab();
    if (tab) await swEval(`chrome.tabs.update(${tab.id}, { active: true }).then(() => "ok")`);
    return { session, targetId, extId };
  };

  const runTurn = async (panelSession, text) => {
    await cdp.eval(panelSession, `(() => {
      const ta = document.getElementById('ta');
      ta.value = ${JSON.stringify(text)};
      ta.dispatchEvent(new Event('input'));
      document.getElementById('send').click();
      return 'sent';
    })()`);
  };

  const waitFinal = async (panelSession, timeoutMs = 180000) => {
    const t0 = Date.now();
    let last = "";
    while (Date.now() - t0 < timeoutMs) {
      last = await cdp.eval(panelSession, "document.body.dataset.lastFinal || ''", { awaitPromise: false });
      if (last) return last;
      await sleep(300);
    }
    return last;
  };

  return {
    cdp, pageSession, pageTargetId, swEval, tabs, pageTab, setConfig, setLocal,
    openPanel, runTurn, waitFinal, cleanup, extId: () => extId,
  };
}
