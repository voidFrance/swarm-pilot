// Prova do grounding: refs estaveis, delta, oclusao, nome acessivel, leitura
// estruturada, e o ponteiro neon unico pousando no alvo. Sem modelo, sem API.
import { spawn } from "node:child_process";
import net from "node:net";
import { rmSync } from "node:fs";
rmSync("/tmp/sp-ground-profile", { recursive: true, force: true });
import * as page from "../lib/page.js";

const EXT = "/home/teteu/Projects/swarm-pilot";
const PROFILE = "/tmp/sp-ground-profile";
const PORT = 9481;
const SRV = 8131;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let fails = 0;
const ok = (cond, name, extra) => {
  console.log((cond ? "PASS " : "FAIL ") + name + (extra === undefined ? "" : " :: " + JSON.stringify(extra).slice(0, 400)));
  if (!cond) fails++;
};

async function waitPort(port, timeout = 15000) {
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

class Cdp {
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
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error("timeout " + method)); } }, 30000);
    });
  }
  async eval(sessionId, expression, opts = {}) {
    const r = await this.send("Runtime.evaluate", {
      expression, returnByValue: true, awaitPromise: opts.awaitPromise !== false, userGesture: true,
    }, sessionId);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result?.value;
  }
}

const server = spawn("python3", ["-m", "http.server", String(SRV), "--bind", "127.0.0.1"], {
  cwd: EXT + "/test", stdio: "ignore",
});
const chrome = spawn("/usr/bin/chromium", [
  "--headless=new", "--user-data-dir=" + PROFILE,
  "--load-extension=" + EXT, "--disable-extensions-except=" + EXT,
  "--remote-debugging-port=" + PORT, "--no-first-run", "--no-default-browser-check",
  "--disable-gpu", "--window-size=1280,900",
  "http://127.0.0.1:" + SRV + "/ground.html",
], { stdio: "ignore" });

const cleanup = () => {
  try { chrome.kill("SIGKILL"); } catch (e) {}
  try { server.kill("SIGKILL"); } catch (e) {}
};

try {
  if (!(await waitPort(PORT))) throw new Error("chromium nao abriu a porta de debug");
  if (!(await waitPort(SRV, 5000))) throw new Error("servidor de teste nao subiu");
  const version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
  console.log("[ground] browser:", version.Browser);

  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  const cdp = new Cdp(ws);

  let pageSession = null;
  let swSession = null;
  let extId = null;
  for (let i = 0; i < 40 && !(pageSession && swSession); i++) {
    const { targetInfos } = await cdp.send("Target.getTargets");
    for (const t of targetInfos) {
      if (t.type === "page" && t.url.includes("ground.html") && !pageSession) {
        const r = await cdp.send("Target.attachToTarget", { targetId: t.targetId, flatten: true });
        pageSession = r.sessionId;
      }
      if (t.type === "service_worker" && t.url.startsWith("chrome-extension://") && !swSession) {
        extId = new URL(t.url).host;
        const r = await cdp.send("Target.attachToTarget", { targetId: t.targetId, flatten: true });
        try {
          const probe = await cdp.eval(r.sessionId, "typeof chrome");
          if (probe === "object") swSession = r.sessionId;
        } catch (e) {}
      }
    }
    if (!pageSession || !swSession) await sleep(250);
  }
  if (!pageSession) throw new Error("aba de teste nao encontrada");
  if (!swSession) throw new Error("service worker da extensao nao encontrado");
  console.log("[ground] ext id:", extId);
  await cdp.send("Page.enable", {}, pageSession);
  await sleep(600);

  // 0. o texto exato que o modelo recebe
  globalThis.chrome = { debugger: { onDetach: { addListener() {} } } };
  const tools = await import("../lib/tools.js");

  // 1. snapshot inicial
  const s1 = await cdp.eval(pageSession, page.snapshotExpr());
  const refs = s1.interactive.map((it) => it.ref);
  ok(new Set(refs).size === refs.length, "refs unicas", new Set(refs).size + "/" + refs.length);
  ok(s1.delta.first === true, "primeiro snapshot marca delta.first");

  const byName = (n) => s1.interactive.find((it) => (it.name || "").includes(n));
  const nome = byName("Nome completo");
  ok(!!nome && nome.role === "textbox" && nome.required === true, "label[for] resolve nome e required", nome && { name: nome.name, role: nome.role, req: nome.required });
  const mail = byName("E-mail de contato");
  ok(!!mail, "aria-labelledby resolve nome", mail && mail.name);
  const aceite = s1.interactive.find((it) => it.ref && it.role === "checkbox" && it.checked === true);
  ok(!!aceite, "checkbox marcado expoe checked", aceite && aceite.name);
  const desab = s1.interactive.find((it) => it.role === "checkbox" && it.disabled === true);
  ok(!!desab, "checkbox desabilitado expoe disabled", desab && desab.name);
  const plano = s1.interactive.find((it) => it.role === "combobox");
  ok(!!plano && plano.value === "pro", "select expoe valor selecionado", plano && plano.value);

  const covered = s1.interactive.find((it) => (it.name || "").includes("Botao coberto"));
  ok(!!covered && covered.occluded === true, "elemento sob overlay marcado occludido", covered && covered.onTop);
  const far = s1.interactive.find((it) => (it.name || "").includes("longe"));
  ok(!!far && far.inView === false, "elemento fora da viewport marcado", far && far.inView);

  // 2. delta: clique programatico cria <button id=novo1>
  await cdp.eval(pageSession, "document.getElementById('btn').click()");
  const s2 = await cdp.eval(pageSession, page.snapshotExpr());
  ok(s2.delta.added.length >= 1, "delta detecta elemento novo", s2.delta.added);
  ok(s1.interactive.some((it) => (it.name || "").includes("Enviar agora")), "botao Enviar presente");
  const btn1 = s1.interactive.find((it) => (it.name || "").includes("Enviar agora"));
  const btn2 = s2.interactive.find((it) => it.ref === btn1.ref);
  ok(!!btn2, "ref do botao sobrevive ao snapshot seguinte", btn1.ref);
  const alerta = s2.alerts || [];
  ok(alerta.some((a) => a.includes("enviado")), "regiao role=alert capturada", alerta);

  // 3. resolve por ref -> ponto que realmente acerta o elemento
  const r1 = await cdp.eval(pageSession, page.resolveExpr({ ref: btn1.ref }));
  const hit = await cdp.eval(pageSession, page.pointExpr(r1.x, r1.y));
  ok(r1.ok === true, "resolve por ref", r1);
  ok(hit.ref === btn1.ref, "ponto devolvido acerta o proprio elemento", { hit: hit.ref, want: btn1.ref });

  const r2 = await cdp.eval(pageSession, page.resolveExpr({ text: "Enviar agora" }));
  ok(r2.ok === true && r2.ref === btn1.ref, "resolve por texto chega na mesma ref", r2 && r2.ref);

  const r3 = await cdp.eval(pageSession, page.resolveExpr({ ref: "e99999" }));
  ok(r3.ok === false && Array.isArray(r3.candidates), "ref inexistente devolve candidatos", r3.reason);

  const r4 = await cdp.eval(pageSession, page.resolveExpr({ text: "Botao coberto" }));
  ok(r4.ok === false && /por cima esta/.test(r4.reason || ""), "coberto por inteiro falha dizendo quem esta por cima", r4.reason);
  const r5 = await cdp.eval(pageSession, page.resolveExpr({ text: "Meio coberto" }));
  const hit5 = r5.ok ? await cdp.eval(pageSession, page.pointExpr(r5.x, r5.y)) : null;
  ok(r5.ok === true && hit5 && hit5.ref === r5.ref, "meio coberto: resolve acha ponto livre fora do overlay", { r5, hit: hit5 && hit5.ref });

  // 4. find e read
  const f1 = await cdp.eval(pageSession, page.findExpr({ role: "button", max: 10 }));
  ok(f1.count >= 3, "find por papel devolve botoes", f1.count);
  const rd = await cdp.eval(pageSession, page.readExpr({ selector: "table", max: 600 }));
  ok(/\| starter \| 59 \|/.test(rd.text), "read extrai tabela em markdown", rd.text.slice(0, 120));

  // 5. estado de carregamento
  await cdp.eval(pageSession, "document.body.setAttribute('aria-busy','true')");
  const w1 = await cdp.eval(pageSession, page.waitExpr({ mode: "loaded" }));
  ok(w1.ok === false && w1.busy === true, "wait(loaded) reprova com aria-busy", w1);
  await cdp.eval(pageSession, "document.body.removeAttribute('aria-busy')");
  const w2 = await cdp.eval(pageSession, page.waitExpr({ mode: "loaded" }));
  ok(w2.ok === true, "wait(loaded) aprova sem busy", w2);

  // 6. ponteiro neon: um so, e pousa onde mandaram
  const ptr = await cdp.eval(swSession, `(async () => {
    const tabs = await chrome.tabs.query({});
    const t = tabs.find((x) => String(x.url || '').includes('ground.html'));
    if (!t) return { err: 'aba nao encontrada' };
    const r = await chrome.tabs.sendMessage(t.id, { type: 'swarm', x: 300, y: 200, label: 'alvo' }, { frameId: 0 });
    return { done: !!r?.done, tab: t.id };
  })()`);
  ok(ptr.done === true, "content script responde ao ponteiro", ptr);
  const ds = await cdp.eval(pageSession, `(() => { const h = document.getElementById('__swarm_pilot__'); return h ? { ptrs: h.dataset.ptrs, ptr: h.dataset.ptr } : null; })()`);
  ok(!!ds && ds.ptrs === "1", "exatamente um ponteiro no DOM", ds);
  ok(!!ds && ds.ptr === "300,200", "ponteiro pousou na coordenada pedida", ds && ds.ptr);

  const shot = await cdp.send("Page.captureScreenshot", { format: "png" }, pageSession);
  const { writeFile } = await import("node:fs/promises");
  await writeFile("/tmp/ptr-neon.png", Buffer.from(shot.data, "base64"));
  console.log("[ground] screenshot: /tmp/ptr-neon.png");

  const dump = tools.formatSnapshot(s1);
  const { writeFile: wf } = await import("node:fs/promises");
  await wf("/tmp/page-state.txt", dump);
  console.log("\n=== page_state que o modelo recebe (/tmp/page-state.txt) ===");
  console.log(dump.split("\n").slice(0, 34).join("\n"));

  console.log(fails === 0 ? "\nTUDO VERDE" : `\n${fails} FALHA(S)`);
} catch (e) {
  console.error("[ground] erro:", e?.stack || e);
  fails += 1;
} finally {
  cleanup();
}
process.exit(fails ? 1 : 0);
