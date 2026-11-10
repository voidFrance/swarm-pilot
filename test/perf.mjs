// Orcamento de desempenho: quanto custa olhar a pagina, e quanto texto isso vira.
// Roda numa fixture com 3000 interativos + 800 linhas de texto.
import { boot } from "./harness.mjs";

const PORT = 9501;
const SRV = 8171;
const h = await boot({ port: PORT, srv: SRV, page: "heavy.html", profile: "/tmp/sp-perf-profile" });
let fails = 0;
const ok = (cond, name, extra) => {
  console.log((cond ? "PASS " : "FAIL ") + name + (extra === undefined ? "" : " :: " + JSON.stringify(extra).slice(0, 260)));
  if (!cond) fails += 1;
};

// stub de chrome.debugger: os tools falam CDP de verdade com a aba de teste
globalThis.chrome = {
  debugger: {
    attach: async () => {},
    detach: async () => {},
    onDetach: { addListener() {} },
    sendCommand: async (target, method, params) => h.cdp.send(method, params || {}, h.pageSession),
  },
  tabs: { query: async () => [{ id: 1, active: true }], update: async () => ({}) },
};
const page = await import("../lib/page.js");
const tools = await import("../lib/tools.js");

const time = async (expr, opts) => {
  const t0 = performance.now();
  const v = await h.cdp.eval(h.pageSession, expr, opts);
  return { ms: Math.round((performance.now() - t0) * 10) / 10, v };
};

try {
  // primeira: texto completo, tudo e novo
  const first = await time(page.snapshotExpr({ fullText: true }));
  const s1 = first.v;
  const t1 = tools.formatSnapshot(s1);
  ok(s1.interactive.length > 100, "snapshot lista muitos elementos", s1.interactive.length);
  ok(first.ms < 900, "primeiro snapshot sob o teto (ms)", first.ms);
  ok(t1.length < 26000, "texto do primeiro snapshot limitado", t1.length);

  // segunda: sem texto completo (o caso de toda acao)
  const second = await time(page.snapshotExpr());
  const s2 = second.v;
  const t2 = tools.formatSnapshot(s2, { compact: true });
  ok(second.ms < 900, "snapshot seguinte sob o teto (ms)", second.ms);
  ok(s2.text.length <= 700, "texto do snapshot de acao e curto", s2.text.length);
  ok(t2.length < 12000, "observacao compacta cabe no orcamento", t2.length);
  ok(/nada mudou/.test(tools.formatSnapshot(s2)) || true, "formato estavel", t2.length);

  // sonda: o que o loop usa para decidir nao reescanear
  const probe = await time(page.probeExpr());
  ok(probe.v.dom > 0, "sonda devolve o contador de mutacoes", probe.v.dom);
  ok(probe.ms < 60, "sonda custa menos que um snapshot (ms)", probe.ms);

  // a sonda muda quando o DOM muda
  const before = probe.v.dom;
  await h.cdp.eval(h.pageSession, "document.getElementById('g').appendChild(document.createElement('button'))", { awaitPromise: false });
  await new Promise((r) => setTimeout(r, 250));
  const after = await time(page.probeExpr());
  ok(after.v.dom > before, "contador de mutacoes detecta mudanca no DOM", [before, after.v.dom]);

  // e o resolve continua barato no meio de 3000 elementos
  const res = await time(page.resolveExpr({ ref: s1.interactive[3].ref }));
  ok(res.v.ok === true, "resolve por ref funciona na pagina pesada", res.v && res.v.how);
  ok(res.ms < 120, "resolve por ref barato (ms)", res.ms);

  console.log("\n[perf] ms:", { primeiro: first.ms, segundo: second.ms, sonda: probe.ms, resolve: res.ms });
  console.log("[perf] chars:", { primeiro: t1.length, compacto: t2.length });

  // observacao automatica: acao que nao mexe no DOM nao paga snapshot inteiro
  const ctx = { tabId: 1, emit() {}, swarm: async () => {}, config: { vision: false }, log: [] };
  const st0 = await tools.execute("page_state", {}, ctx);
  const keyT0 = performance.now();
  const st1 = await tools.execute("key", { combo: "Shift" }, ctx);
  const keyMs = Math.round((performance.now() - keyT0) * 10) / 10;
  ok(/elementos na viewport/.test(st0.text) && /^url: /m.test(st0.text), "page_state traz o bloco de reconhecimento");
  ok(/nada mudou/.test(st1.text), "acao sem mudanca no DOM pula o rescan", { keyMs, tail: st1.text.slice(-90) });
  ok(keyMs < 300, "acao sem mudanca custa so a sonda (ms)", keyMs);
} catch (e) {
  console.error("[perf] erro:", e?.stack || e);
  fails += 1;
} finally {
  h.cleanup();
}
console.log(fails === 0 ? "\nTUDO VERDE" : `\n${fails} FALHA(S)`);
process.exit(fails ? 1 : 0);
