// Tela de opcoes de ponta a ponta: o botao de engrenagem do painel abre a pagina
// (mensagem open-options -> runtime.openOptionsPage), os campos hidratam do storage,
// salvar persiste, reset volta aos padroes. Sem teto de passos na configuracao.
import { boot, sleep } from "./harness.mjs";

const PORT = 9475;
let pass = 0, fail = 0;
const ok = (cond, name, extra) => {
  if (cond) { pass++; console.log("PASS", name, extra === undefined ? "" : ":: " + extra); }
  else { fail++; console.log("FAIL", name, extra === undefined ? "" : ":: " + extra); }
};

const b = await boot({ port: PORT, srv: 9477, page: "page.html", profile: "/tmp/sp-opt" });
try {
  const panel = await b.openPanel();
  const extId = b.extId();

  // 1. o que o operador clica: a engrenagem do painel
  await b.cdp.eval(panel.session, `document.querySelector('[data-act="settings"]').click(), "click"`);

  let optTarget = null;
  for (let i = 0; i < 60 && !optTarget; i++) {
    const { targetInfos } = await b.cdp.send("Target.getTargets");
    optTarget = targetInfos.find((t) => t.type === "page" && t.url === `chrome-extension://${extId}/options.html`);
    if (!optTarget) await sleep(200);
  }
  ok(!!optTarget, "engrenagem abre a pagina de opcoes", optTarget ? "aba criada" : "nada abriu");
  if (!optTarget) throw new Error("sem pagina de opcoes: nada mais a provar");

  const { sessionId } = await b.cdp.send("Target.attachToTarget", { targetId: optTarget.targetId, flatten: true });
  await b.cdp.send("Runtime.enable", {}, sessionId).catch(() => {});

  let ready = null;
  for (let i = 0; i < 50 && !ready; i++) {
    ready = await b.cdp
      .eval(sessionId, `(() => { const a = document.getElementById("agent"); return a && a.options.length > 1 ? "ok" : ""; })()`, { awaitPromise: false })
      .catch(() => "");
    if (!ready) await sleep(200);
  }
  ok(ready === "ok", "options.html hidratou o seletor de agente");

  const dom = await b.cdp.eval(sessionId, `JSON.stringify({
    titulo: document.title,
    agentes: document.getElementById("agent").options.length,
    agente: document.getElementById("agent").value,
    protocolo: document.getElementById("protocol").value,
    modelo: document.getElementById("p_model").value,
    baseUrl: document.getElementById("p_baseUrl").value,
    chave: !!document.getElementById("p_key").value,
    neon: document.getElementById("neon").value,
    ponteiro: document.getElementById("pointerMs").value,
    effort: document.getElementById("reasoningEffort").value,
    semCampoPassos: !document.getElementById("maxSteps"),
    inputs: document.querySelectorAll("input").length,
  })`);
  const d = JSON.parse(dom);
  ok(d.agentes >= 8, "presets de provedor no seletor", d.agentes);
  ok(d.baseUrl.startsWith("https://") && d.modelo.length > 0, "perfil hidratado", d.modelo + " @ " + d.baseUrl);
  ok(d.chave === false, "nenhuma chave embutida no perfil novo", String(d.chave));
  ok(d.effort === "low", "effort low e o padrao da tela", d.effort);
  ok(d.semCampoPassos, "sem campo de limite de passos", d.inputs + " inputs");

  // 2. salvar de verdade: muda a cor do ponteiro e le do storage
  const saved = await b.cdp.eval(sessionId, `(async () => {
    const neon = document.getElementById("neon");
    neon.value = "#ff00aa";
    document.getElementById("save").click();
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const st = (await chrome.storage.sync.get("sp_config")).sp_config || {};
      if (st.neon === "#ff00aa") return JSON.stringify({ neon: st.neon, effort: st.reasoningEffort, passos: "maxSteps" in st, status: document.getElementById("status").textContent });
    }
    const st = (await chrome.storage.sync.get("sp_config")).sp_config || {};
    return JSON.stringify({ neon: st.neon || "", effort: st.reasoningEffort, passos: "maxSteps" in st, status: document.getElementById("status").textContent, erro: true });
  })()`);
  const s = JSON.parse(saved);
  ok(s.neon === "#ff00aa", "salvar persiste no storage", s.status || "?");
  ok(s.effort === "low", "effort low gravado", s.effort);
  ok(!s.passos, "config salva sem maxSteps", s.passos ? "ainda tem" : "limpo");

  // 3. reset
  const after = await b.cdp.eval(sessionId, `(async () => {
    document.getElementById("reset").click();
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const st = (await chrome.storage.sync.get("sp_config")).sp_config || {};
      if (st.neon === "#22d3ee") return JSON.stringify({ neon: st.neon, agente: document.getElementById("agent").value });
    }
    return JSON.stringify({ neon: "", agente: "" });
  })()`);
  const a = JSON.parse(after);
  ok(a.neon === "#22d3ee", "reset volta ao padrao", a.neon);

  // 4. o SW responde a mensagem direto (o teste nao depende do clique)
  const ping = await b.cdp.eval(sessionId, `new Promise((r) => chrome.runtime.sendMessage({ type: "ping" }, (x) => r(JSON.stringify(x || { erro: "sem resposta" }))))`);
  ok(JSON.parse(ping).ok === true, "SW responde mensagem avulsa", ping);
} finally {
  b.cleanup();
  await sleep(200);
}
console.log(fail ? `FALHAS: ${fail}` : "TUDO VERDE", `(${pass} ok)`);
if (fail) process.exitCode = 1;
