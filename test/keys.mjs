// O ponteiro vive no top layer, acima de tudo, e ainda assim nao pode roubar
// evento da pagina: clique real chega no botao e tecla chega no campo.
import { boot, sleep } from "./harness.mjs";


const PORT = 9495;
const SRV = 8151;
const h = await boot({ port: PORT, srv: SRV, page: "keys.html", profile: "/tmp/sp-keys-profile" });
let fails = 0;
const ok = (cond, name, extra) => {
  console.log((cond ? "PASS " : "FAIL ") + name + (extra === undefined ? "" : " :: " + JSON.stringify(extra).slice(0, 260)));
  if (!cond) fails += 1;
};

try {
  const panel = await h.openPanel();
  const tab = await h.pageTab();
  const box = await h.cdp.eval(h.pageSession, `(() => { const r = document.getElementById('btn').getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`, { awaitPromise: false });

  // poe o ponteiro exatamente em cima do botao
  const moved = await h.swEval(`chrome.tabs.sendMessage(${tab.id}, { type: 'pointer', x: ${box.x}, y: ${box.y}, label: 'alvo' }, { frameId: 0 }).then(r => JSON.stringify(r))`);
  ok(/done/.test(String(moved)), "content script responde ao ponteiro", moved);
  await sleep(600);
  const landed = await h.cdp.eval(h.pageSession, "document.getElementById('__swarm_pilot__').dataset.ptr", { awaitPromise: false });
  ok(landed === `${box.x},${box.y}`, "ponteiro pousou na coordenada do botao", landed);

  // o que esta no ponto continua sendo o botao, nao o host do ponteiro
  const hit = await h.cdp.eval(h.pageSession, `(() => { const el = document.elementFromPoint(${box.x}, ${box.y}); return el ? (el.id || el.tagName.toLowerCase()) : 'nada'; })()`, { awaitPromise: false });
  ok(hit === "btn", "hit-test no ponto do ponteiro ainda e o botao", hit);

  // clique real por CDP no mesmo ponto: a pagina conta
  await h.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", buttons: 1, clickCount: 1 }, h.pageSession);
  await h.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", buttons: 0, clickCount: 1 }, h.pageSession);
  await sleep(200);
  const counter = await h.cdp.eval(h.pageSession, "document.getElementById('out').textContent", { awaitPromise: false });
  ok(counter === "1", "clique real atravessa a camada do ponteiro", counter);

  // teclado na pagina continua intacto
  await h.cdp.eval(h.pageSession, "document.getElementById('field').focus()", { awaitPromise: false });
  await h.cdp.type(h.pageSession, "abc");
  await sleep(200);
  const typed = await h.cdp.eval(h.pageSession, "window.__typed || ''", { awaitPromise: false });
  ok(typed === "abc", "teclado da pagina intacto com o ponteiro no top layer", typed);

  // e o ponteiro continua depois de um clique sem DOM nenhum mudar
  const again = await h.swEval(`chrome.tabs.sendMessage(${tab.id}, { type: 'pointer', x: 40, y: 40, label: 'volta', press: false }, { frameId: 0 }).then(r => JSON.stringify(r))`);
  ok(/done/.test(String(again)), "segundo movimento do ponteiro tambem responde", again);
  const landed2 = await h.cdp.eval(h.pageSession, "document.getElementById('__swarm_pilot__').dataset.ptr", { awaitPromise: false });
  ok(landed2 === "40,40", "ponteiro persegue a nova coordenada", landed2);
} catch (e) {
  console.error("[keys] erro:", e?.stack || e);
  fails += 1;
} finally {
  h.cleanup();
}
console.log(fails === 0 ? "\nTUDO VERDE" : `\n${fails} FALHA(S)`);
process.exit(fails ? 1 : 0);
