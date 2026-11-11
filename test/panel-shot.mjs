// Captura o painel lateral em PNG com um turno real curto — inspecao visual do design.
import { writeFile } from "node:fs/promises";
import { boot, EXT, sleep } from "./harness.mjs";

const h = await boot({ port: 9447, srv: 8124, page: "page.html", profile: "/tmp/sp-panel-profile" });
try {
  await h.setConfig({
    baseUrl: "https://api.nodecode.ai/v1",
    key: (await import("node:fs")).readFileSync("/home/teteu/.nodecode/auth.json", "utf8")
      ? JSON.parse((await import("node:fs")).readFileSync("/home/teteu/.nodecode/auth.json", "utf8")).api_keys["api.nodecode.ai"].key : "",
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
  await sleep(800);
  const m = await h.cdp.send("Page.getLayoutMetrics", {}, panel.session);
  const w = 420;
  const ht = 1100;
  await h.cdp.send("Emulation.setDeviceMetricsOverride", { width: w, height: ht, deviceScaleFactor: 2, mobile: false }, panel.session);
  await sleep(400);
  const shot = await h.cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true }, panel.session);
  await writeFile(EXT + "/test/panel-shot.png", Buffer.from(shot.data, "base64"));
  console.log("[panel] " + w + "x" + ht + " salvo em test/panel-shot.png");
  const info = await h.cdp.eval(panel.session, `JSON.stringify({
    steps: document.body.dataset.steps, plan: document.body.dataset.plan,
    cards: document.querySelectorAll('.step-card').length,
    errs: [...document.querySelectorAll('.msg.err')].map(e => e.textContent),
  })`, { awaitPromise: false });
  console.log("[panel] " + info);
} finally {
  await h.cleanup();
}
