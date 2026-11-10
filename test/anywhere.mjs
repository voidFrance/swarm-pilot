// O ponteiro tem que aparecer em qualquer tela: body com transform, div com z-index
// maximo e <dialog> modal nativo. Ele vive no top layer; a pagina continua clicavel.
import { boot, sleep, EXT } from "./harness.mjs";
import { writeFile } from "node:fs/promises";

const PORT = 9499;
const SRV = 8161;
const h = await boot({ port: PORT, srv: SRV, page: "anywhere.html", profile: "/tmp/sp-anywhere-profile" });
let fails = 0;
const ok = (cond, name, extra) => {
  console.log((cond ? "PASS " : "FAIL ") + name + (extra === undefined ? "" : " :: " + JSON.stringify(extra).slice(0, 260)));
  if (!cond) fails += 1;
};

const hostState = async () => h.cdp.eval(h.pageSession, `(() => {
  const el = document.getElementById('__swarm_pilot__');
  if (!el) return { host: false };
  return {
    host: true,
    layer: el.matches(':popover-open') ? 'top' : 'z',
    parent: el.parentElement ? el.parentElement.tagName.toLowerCase() : '',
    ptr: el.dataset.ptr || '',
    ptrs: el.dataset.ptrs || '',
  };
})()`, { awaitPromise: false });

try {
  const tab = await h.pageTab();
  const s1 = await hostState();
  ok(s1.host && s1.layer === "top", "ponteiro no top layer (popover aberto)", s1);
  ok(s1.ptrs === "1", "exatamente um ponteiro na pagina", s1.ptrs);
  ok(s1.parent === "html", "host montado no <html>, body e trocado por SPA", s1.parent);

  // body com transform: o ponteiro nao pode ser arrastado junto
  await h.swEval(`chrome.tabs.sendMessage(${tab.id}, { type: 'pointer', x: 300, y: 200, label: 'alvo', press: true }, { frameId: 0 }).then(r => JSON.stringify(r))`);
  await sleep(600);
  const s2 = await hostState();
  ok(s2.ptr === "300,200", "ponteiro pousou na coordenada da viewport apesar do transform", s2.ptr);

  // dialog modal nativo: ponteiro continua no top layer e o host sai do inert
  await h.cdp.eval(h.pageSession, "document.getElementById('modal').showModal()", { awaitPromise: false });
  await sleep(1900);
  const s3 = await hostState();
  ok(s3.layer === "top", "ponteiro segue no top layer com modal aberto", s3.layer);
  ok(s3.parent === "dialog", "host entra no dialogo (nao fica inerte atras do backdrop)", s3.parent);
  {
    const shot = await h.cdp.send("Page.captureScreenshot", { format: "png" }, h.pageSession);
    await writeFile(EXT + "/test/toplayer-shot.png", Buffer.from(shot.data, "base64"));
  }

  await h.cdp.eval(h.pageSession, "document.getElementById('modal').close()", { awaitPromise: false });
  await sleep(1900);
  const s4 = await hostState();
  ok(s4.parent === "html" && s4.layer === "top", "host volta ao <html> e o ponteiro segue no topo", [s4.parent, s4.layer]);

  // posicao salva fora da tela nao importa mais: o ponteiro e sempre viewport
  await h.swEval(`chrome.tabs.sendMessage(${tab.id}, { type: 'pointer', x: 5, y: 5, label: 'canto', press: false }, { frameId: 0 }).then(r => JSON.stringify(r))`);
  await sleep(400);
  const s5 = await hostState();
  ok(s5.ptr === "5,5", "ponteiro aceita coordenada no canto", s5.ptr);
} catch (e) {
  console.error("[anywhere] erro:", e?.stack || e);
  fails += 1;
} finally {
  h.cleanup();
}
console.log(fails === 0 ? "\nTUDO VERDE" : `\n${fails} FALHA(S)`);
process.exit(fails ? 1 : 0);
