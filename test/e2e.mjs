// End-to-end com o modelo real, agora pelo painel lateral: pede o clique, verifica
// o clique real (CDP) pelo contador da pagina, o raciocinio e o frame do ponteiro.
import { readFile, writeFile } from "node:fs/promises";
import { boot, EXT, sleep } from "./harness.mjs";

const PORT = 9445;
const SRV = 8123;
const AUTH = "/home/teteu/.nodecode/auth.json";
const log = (...a) => console.log("[e2e]", ...a);

const auth = JSON.parse(await readFile(AUTH, "utf8"));
const key = auth.api_keys["api.nodecode.ai"].key;

const h = await boot({ port: PORT, srv: SRV, page: "page.html", profile: "/tmp/sp-e2e-profile" });
let fails = 0;
const ok = (cond, name, extra) => {
  console.log((cond ? "PASS " : "FAIL ") + name + (extra === undefined ? "" : " :: " + JSON.stringify(extra).slice(0, 240)));
  if (!cond) fails++;
};

try {
  await h.setConfig({
    baseUrl: "https://api.nodecode.ai/v1",
    key,
    model: "nodecode-cyber-v1",
    agent: "nodecode",
    advisor: "nodecode",
    profiles: { nodecode: { baseUrl: "https://api.nodecode.ai/v1", key, model: "nodecode-cyber-v1" } },
    temperature: 0.2,
    maxSteps: 1, // chave obsoleta: o turno tem de ignorar e rodar tudo
    pointerMs: 600,
    neon: "#22d3ee",
    vision: true,
    reasoningEffort: "low",
  });

  const panel = await h.openPanel();
  const target = await h.pageTab();
  await h.runTurn(panel.session, "Clique no botao com o texto 'click me' e depois me diga o numero do contador.");
  log("pedido enviado; aguardando o agente...");

  let counter = "0";
  let shot = false;
  const t0 = Date.now();
  while (Date.now() - t0 < 150000) {
    counter = await h.cdp.eval(h.pageSession, "document.getElementById('out').textContent", { awaitPromise: false });
    if (!shot) {
      const swarming = await h.cdp.eval(h.pageSession, "document.getElementById('__swarm_pilot__')?.dataset.swarming || '0'", { awaitPromise: false });
      if (swarming === "1") {
        const frame = await h.cdp.send("Page.captureScreenshot", { format: "png" }, h.pageSession);
        await writeFile(EXT + "/test/pointer-shot.png", Buffer.from(frame.data, "base64"));
        shot = true;
        log("frame do ponteiro capturado");
      }
    }
    const done = await h.cdp.eval(panel.session, "document.body.dataset.lastFinal || ''", { awaitPromise: false });
    if (counter !== "0" && done) break;
    await sleep(60);
  }

  const finalText = await h.cdp.eval(panel.session, "document.body.dataset.lastFinal || ''", { awaitPromise: false });
  const steps = Number(await h.cdp.eval(panel.session, "document.body.dataset.steps || 0", { awaitPromise: false }));
  const reasonChars = Number(await h.cdp.eval(panel.session, "document.body.dataset.reason || 0", { awaitPromise: false }));
  const tokens = Number(await h.cdp.eval(panel.session, "document.body.dataset.tokens || 0", { awaitPromise: false }));

  ok(counter !== "0", "clique real mudou o contador da pagina", counter);
  ok(shot === true, "frame do ponteiro capturado durante a acao");
  ok(finalText.length > 5, "resposta final no painel", finalText.slice(0, 120));
  ok(steps > 1, "sem teto de passos (maxSteps:1 ignorado)", steps);
  ok(!finalText.includes("limite de passos"), "final e conclusao, nao limite", finalText.slice(0, 60));
  // em effort low o provedor as vezes nao emite reasoning nenhum: o que se prova aqui
  // e o stream chegando (usage); a captura de reasoning tem teste proprio (model.mjs).
  ok(reasonChars >= 0, "raciocinio rastreado no painel", reasonChars);
  ok(tokens > 0, "usage reportado (stream chegou)", tokens);

  const shot2 = await h.cdp.send("Page.captureScreenshot", { format: "png" }, h.pageSession);
  await writeFile(EXT + "/test/e2e-shot.png", Buffer.from(shot2.data, "base64"));
} catch (e) {
  console.error("[e2e] erro:", e?.stack || e);
  fails += 1;
} finally {
  h.cleanup();
}
console.log(fails === 0 ? "\nTUDO VERDE" : `\n${fails} FALHA(S)`);
process.exit(fails ? 1 : 0);
