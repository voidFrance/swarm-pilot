// Sonda de layout do painel: ordem do log, mensagem final presente, overflow na largura real.
import { readFile } from "node:fs/promises";
import { boot, sleep } from "./harness.mjs";

const auth = JSON.parse(await readFile("/home/teteu/.nodecode/auth.json", "utf8"));
const h = await boot({ port: 9447, srv: 8124, page: "page.html", profile: "/tmp/sp-panel-profile" });
try {
  await h.setConfig({
    baseUrl: "https://api.nodecode.ai/v1", key: auth.api_keys["api.nodecode.ai"].key,
    model: "nodecode-cyber-v1", agent: "nodecode", advisor: "nodecode",
    temperature: 0.2, pointerMs: 400, vision: true, reasoningEffort: "low",
  });
  const panel = await h.openPanel();
  await h.runTurn(panel.session, "Clique no botao 'click me' e diga o numero do contador.");
  const t0 = Date.now();
  while (Date.now() - t0 < 120000) {
    if (await h.cdp.eval(panel.session, "document.body.dataset.lastFinal || ''", { awaitPromise: false })) break;
    await sleep(200);
  }
  await sleep(1200);
  const dump = (label) => `(() => {
    const log = document.getElementById('log');
    const kids = [...log.children].map(e => e.className + ' :: ' + (e.textContent||'').replace(/\\s+/g,' ').slice(0, 60));
    return JSON.stringify({
      kids,
      finalShown: !!document.querySelector('.msg.assistant') && document.querySelector('.msg.assistant').textContent.slice(0,60),
      bodyOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      logOverflowX: log.scrollWidth - log.clientWidth,
      wide: [...log.querySelectorAll('*')].filter(e => e.getBoundingClientRect().right > log.getBoundingClientRect().right + 1).map(e => e.className).slice(0,5),
      shots: [...log.querySelectorAll('img.shot')].map(i => ({ complete: i.complete, w: i.naturalWidth, h: i.naturalHeight, srcLen: (i.src||'').length, box: Math.round(i.getBoundingClientRect().width) + 'x' + Math.round(i.getBoundingClientRect().height) })),
    });
  })()`;
  console.log("[520px] " + await h.cdp.eval(panel.session, dump(), { awaitPromise: false }));
  const raw = await h.cdp.eval(panel.session, "(document.querySelector('img.shot')||{}).src || ''", { awaitPromise: false });
  if (raw) { const { writeFile } = await import('node:fs/promises'); await writeFile('/tmp/frame.png', Buffer.from(raw.split(',')[1], 'base64')); console.log('[frame] /tmp/frame.png'); }
  await h.cdp.send("Emulation.setDeviceMetricsOverride", { width: 380, height: 820, deviceScaleFactor: 2, mobile: false }, panel.session);
  await sleep(500);
  console.log("[380px] " + await h.cdp.eval(panel.session, dump(), { awaitPromise: false }));
} finally { await h.cleanup(); }
