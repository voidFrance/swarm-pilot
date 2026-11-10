// Tarefa completa com o modelo real: reconhecer formulario, planejar, preencher por
// ref, marcar checkbox, trocar select, clicar, relatar, e consultar outro modelo.
import { readFile, writeFile } from "node:fs/promises";
import { boot, EXT, sleep } from "./harness.mjs";

const PORT = 9491;
const SRV = 8141;
const auth = JSON.parse(await readFile("/home/teteu/.nodecode/auth.json", "utf8"));
const key = auth.api_keys["api.nodecode.ai"].key;

const h = await boot({ port: PORT, srv: SRV, page: "ground.html", profile: "/tmp/sp-task-profile" });
let fails = 0;
const ok = (cond, name, extra) => {
  console.log((cond ? "PASS " : "FAIL ") + name + (extra === undefined ? "" : " :: " + JSON.stringify(extra).slice(0, 300)));
  if (!cond) fails += 1;
};

try {
  await h.setConfig({
    baseUrl: "https://api.nodecode.ai/v1", key, model: "nodecode-cyber-v1",
    agent: "nodecode", advisor: "nodecode",
    profiles: { nodecode: { baseUrl: "https://api.nodecode.ai/v1", key, model: "nodecode-cyber-v1" } },
    temperature: 0.2, maxSteps: 2, pointerMs: 240, neon: "#22d3ee", vision: true, reasoningEffort: "low",
  });

  const panel = await h.openPanel();
  const task = "No formulario desta pagina: preencha 'Nome completo' com Teteu, 'E-mail de contato' com teteu@exemplo.dev, "
    + "garanta que o checkbox 'Aceito os termos' esteja marcado, selecione o plano 'pro' no campo plano, "
    + "e clique em 'Enviar agora'. Depois me diga o contador e o alerta.";
  await h.runTurn(panel.session, task);
  console.log("[task] pedido enviado, aguardando...");
  const finalText = await h.waitFinal(panel.session, 200000);

  const state = await h.cdp.eval(h.pageSession, `(() => ({
    nome: document.getElementById('nome').value,
    email: document.getElementById('email').value,
    aceite: document.getElementById('aceite').checked,
    plano: document.getElementById('plano').value,
    contador: document.getElementById('out').textContent,
    alerta: document.getElementById('alerta').textContent,
  }))()`, { awaitPromise: false });
  const planSteps = Number(await h.cdp.eval(panel.session, "document.body.dataset.plan || 0", { awaitPromise: false }));
  const reasonChars = Number(await h.cdp.eval(panel.session, "document.body.dataset.reason || 0", { awaitPromise: false }));
  const steps = Number(await h.cdp.eval(panel.session, "document.body.dataset.steps || 0", { awaitPromise: false }));
  const tokens = Number(await h.cdp.eval(panel.session, "document.body.dataset.tokens || 0", { awaitPromise: false }));
  const shot = await h.cdp.send("Page.captureScreenshot", { format: "png" }, h.pageSession);
  await writeFile(EXT + "/test/task-shot.png", Buffer.from(shot.data, "base64"));

  ok(state.nome === "Teteu", "campo nome preenchido", state.nome);
  ok(state.email === "teteu@exemplo.dev", "campo email preenchido", state.email);
  ok(state.aceite === true, "checkbox marcado", state.aceite);
  ok(state.plano === "pro", "select no plano pro", state.plano);
  ok(/contador: [1-9]/.test(state.contador), "clique real no Enviar agora", state.contador);
  ok(/enviado/.test(state.alerta), "alerta disparado pela pagina", state.alerta);
  ok(planSteps > 0, "plano registrado (raciocinio explicito)", planSteps);
  ok(reasonChars > 40, "raciocinio no painel", reasonChars);
  ok(steps > 1, "sem teto de passos (maxSteps:2 nao corta)", steps);
  ok(tokens > 0, "tokens medidos", tokens);
  ok(finalText.length > 10, "resposta final", finalText.slice(0, 120));

  // segunda fase: ask_agent consulta o outro modelo
  await h.cdp.eval(panel.session, "document.body.dataset.lastFinal = ''", { awaitPromise: false });
  await h.runTurn(panel.session, "Use ask_agent para perguntar ao perfil nodecode exatamente isto: 'responda apenas a palavra OK-CONSULTOR'. Depois me diga o que ele respondeu.");
  const answer = await h.waitFinal(panel.session, 120000);
  ok(/ok-consultor/i.test(answer), "ask_agent trouxe a resposta do outro modelo", answer.slice(0, 160));
} catch (e) {
  console.error("[task] erro:", e?.stack || e);
  fails += 1;
} finally {
  h.cleanup();
}
console.log(fails === 0 ? "\nTUDO VERDE" : `\n${fails} FALHA(S)`);
process.exit(fails ? 1 : 0);
