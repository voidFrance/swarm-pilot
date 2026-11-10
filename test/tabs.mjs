// Aba restrita (New Tab, chrome://settings) nao aceita chrome.debugger. O agente
// tem que trocar de alvo e continuar, nao morrer no attach.
import { readFile } from "node:fs/promises";
import { boot, sleep } from "./harness.mjs";

const PORT = 9511;
const SRV = 8181;
const auth = JSON.parse(await readFile("/home/teteu/.nodecode/auth.json", "utf8"));
const key = auth.api_keys["api.nodecode.ai"].key;

const h = await boot({ port: PORT, srv: SRV, page: "page.html", profile: "/tmp/sp-tabs-profile" });
let fails = 0;
const ok = (cond, name, extra) => {
  console.log((cond ? "PASS " : "FAIL ") + name + (extra === undefined ? "" : " :: " + JSON.stringify(extra).slice(0, 260)));
  if (!cond) fails += 1;
};
const pick = async () => JSON.parse(await h.swEval("__pickTab().then(t => JSON.stringify({ id: t.tab?.id, url: t.tab?.url, title: t.tab?.title, note: t.note }))"));

try {
  await h.setConfig({
    baseUrl: "https://api.nodecode.ai/v1", key, model: "nodecode-cyber-v1",
    agent: "nodecode", advisor: "nodecode",
    profiles: { nodecode: { baseUrl: "https://api.nodecode.ai/v1", key, model: "nodecode-cyber-v1" } },
    temperature: 0.2, maxSteps: 8, pointerMs: 200, neon: "#22d3ee", vision: false, reasoningEffort: "low",
  });

  // 1. New Tab ativa: vira about:blank, attach funciona
  const nt = await h.swEval("chrome.tabs.create({ url: 'chrome://newtab/', active: true }).then(t => t.id)");
  await sleep(600);
  const p1 = await pick();
  ok(/^about:blank/.test(p1.url || ""), "New Tab vira about:blank", p1);
  ok(/about:blank/.test(p1.note || ""), "troca de alvo explicada", p1.note);

  // 2. chrome://settings ativa com uma pagina normal aberta: usa a pagina normal
  const set = await h.swEval("chrome.tabs.create({ url: 'chrome://settings/', active: true }).then(t => t.id)");
  await sleep(800);
  const p2 = await pick();
  ok(/page\.html/.test(p2.url || ""), "aba restrita cede lugar para a pagina normal", p2);
  ok(/troca/.test(p2.note || "") || /settings/.test(p2.note || ""), "troca de alvo explicada", p2.note);

  // 3. turno real com aba restrita ativa: o clique acontece na pagina normal
  const pageTab = await h.pageTab();
  await h.swEval(`chrome.tabs.update(${pageTab.id}, { url: '${"http://127.0.0.1:" + SRV}/page.html' }).then(() => 'ok')`);
  await sleep(800);
  await h.cdp.eval(h.pageSession, "location.reload()", { awaitPromise: false }).catch(() => {});
  await sleep(800);
  await h.swEval(`chrome.tabs.update(${set}, { active: true }).then(() => 'ok')`);

  const panel = await h.openPanel();
  await h.swEval(`chrome.tabs.update(${set}, { active: true }).then(() => 'ok')`);
  await h.runTurn(panel.session, "Clique no botao com o texto 'click me'. Depois me diga apenas: ok");
  const final = await h.waitFinal(panel.session, 120000);

  let counter = "0";
  for (let i = 0; i < 20 && counter === "0"; i++) {
    counter = await h.cdp.eval(h.pageSession, "document.getElementById('out')?.textContent || '0'", { awaitPromise: false });
    if (counter === "0") await sleep(300);
  }
  ok(counter !== "0", "clique real na aba escolhida (nao na chrome://)", counter);
  ok(final.length > 0 && !/falhou ao anexar/.test(final), "turno rodou apesar da aba restrita", final.slice(0, 100));

  const statuses = await h.cdp.eval(panel.session, "[...document.querySelectorAll('.msg.sys')].map(e => e.textContent)", { awaitPromise: false });
  ok(Array.isArray(statuses) && statuses.some((s) => /trocada/.test(String(s))), "painel avisou a troca", statuses);
} catch (e) {
  console.error("[tabs] erro:", e?.stack || e);
  fails += 1;
} finally {
  h.cleanup();
}
console.log(fails === 0 ? "\nTUDO VERDE" : `\n${fails} FALHA(S)`);
process.exit(fails ? 1 : 0);
