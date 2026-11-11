// UI do agente na barra lateral nativa. Documento proprio: sem shadow DOM, sem
// disputa de z-index com a pagina, sem vazamento de teclado. Fala com o service
// worker por um Port; o alvo (aba) e resolvido no background a cada turno.

const $ = (id) => document.getElementById(id);
const logEl = $("log");
const ta = $("ta");
const sendBtn = $("send");
const dot = document.querySelector(".dot");
const metaEl = document.querySelector(".meta");
const targetEl = $("target");

let port = null;
let busy = false;
let assistantEl = null;
let reasonEl = null;
let planEl = null;
let stepCard = null; // card aberto: chamada da ferramenta + resultado ficam juntos
let cfg = { model: "-", agent: "nodecode" };

const clip = (s, n) => (String(s).length > n ? String(s).slice(0, n) + " ..." : String(s));

// Cor do badge por tipo de ferramenta (o CSS usa data-kind).
const KIND = {
  navigate: "nav", tabs: "nav", fetch_url: "nav",
  click: "act", type: "act", key: "act", scroll: "act", evaluate: "act",
  page_state: "look", find: "look", read: "look", screenshot: "look", wait: "look",
  plan: "think", ask_agent: "think",
  done: "done",
};

function addEl(cls, text) {
  const el = document.createElement("div");
  el.className = cls;
  if (text) el.textContent = text;
  logEl.appendChild(el);
  logEl.scrollTop = logEl.scrollHeight;
  return el;
}

function setBusy(v) {
  document.body.dataset.busy = String(v);
  busy = v;
  sendBtn.disabled = v;
  dot.classList.toggle("busy", v);
  sendBtn.textContent = v ? "Stop" : "Exec";
  if (v) assistantEl = null;
}

function connect() {
  port = chrome.runtime.connect({ name: "panel" });
  port.onMessage.addListener(handle);
  port.onDisconnect.addListener(() => {
    port = null;
    setTimeout(connect, 400);
  });
  port.postMessage({ type: "config" });
  port.postMessage({ type: "target" });
}

function handle(msg) {
  document.body.dataset.msgTypes = ((document.body.dataset.msgTypes || "") + "," + msg.type).slice(-400);
  switch (msg.type) {
    case "config":
      cfg = { ...cfg, ...(msg.config || {}) };
      metaEl.textContent = `${cfg.agent || "nodecode"} / ${cfg.model || "-"}`;
      break;
    case "target":
      targetEl.replaceChildren(
        document.createTextNode("aba alvo: "),
        Object.assign(document.createElement("b"), { textContent: msg.title || msg.url || "-" }),
      );
      targetEl.title = (msg.url || "") + (msg.note ? "\n" + msg.note : "");
      targetEl.dataset.note = msg.note || "";
      if (msg.note) addEl("msg sys", msg.note);
      break;
    case "profile":
      cfg.model = msg.model || cfg.model;
      metaEl.textContent = `${msg.id}: ${msg.model}`;
      break;
    case "turn-start":
      setBusy(true);
      assistantEl = null;
      reasonEl = null;
      planEl = null;
      stepCard = null;
      break;
    case "status": {
      if (!msg.text) break;
      if (/^passo\s+\d+/i.test(msg.text)) {
        // divisor entre passos; fecha o card anterior
        stepCard = null;
        addEl("msg sys pass", msg.text);
      } else if (stepCard) {
        // anotacao da execucao (ex.: "ponteiro -> ...") fica dentro do card
        const note = document.createElement("div");
        note.className = "msg sys";
        note.textContent = msg.text;
        stepCard.appendChild(note);
        logEl.scrollTop = logEl.scrollHeight;
      } else {
        addEl("msg sys", msg.text);
      }
      break;
    }
    case "delta": {
      if (!assistantEl) assistantEl = addEl("msg assistant", "");
      assistantEl.textContent += msg.text;
      logEl.scrollTop = logEl.scrollHeight;
      break;
    }
    case "reasoning":
      if (!reasonEl) reasonEl = addEl("reason", "");
      reasonEl.textContent += msg.text;
      reasonEl.scrollTop = reasonEl.scrollHeight;
      document.body.dataset.reason = String((Number(document.body.dataset.reason) || 0) + String(msg.text || "").length);
      logEl.scrollTop = logEl.scrollHeight;
      break;
    case "reasoning-end":
      reasonEl = null;
      break;
    case "plan": {
      if (!planEl) planEl = addEl("plan", "");
      const { steps, done = [], why } = msg.plan;
      const head = document.createElement("div");
      head.className = "head";
      const label = document.createElement("span");
      label.textContent = `plano ${done.length}/${steps.length}` + (why ? " - " + why : "");
      const track = document.createElement("i");
      track.className = "track";
      const fill = document.createElement("i");
      fill.style.width = (steps.length ? Math.round((100 * done.length) / steps.length) : 0) + "%";
      track.append(fill);
      head.append(label, track);
      const body = document.createElement("div");
      steps.forEach((s, i) => {
        const row = document.createElement("div");
        row.className = "pstep" + (done.includes(i + 1) ? " done" : "");
        row.textContent = s;
        body.append(row);
      });
      planEl.replaceChildren(head, body);
      document.body.dataset.plan = String(steps.length);
      break;
    }
    case "step": {
      document.body.dataset.steps = String((Number(document.body.dataset.steps) || 0) + 1);
      const card = document.createElement("div");
      card.className = "step-card" + (msg.tool === "done" ? " done" : "");
      const el = document.createElement("div");
      el.className = "step";
      const b = document.createElement("b");
      b.textContent = msg.tool;
      b.dataset.kind = KIND[msg.tool] || "act";
      const s = document.createElement("span");
      s.className = "res";
      const args = msg.args || {};
      // o resumo do done e a propria conclusao: mostrar o texto, nao o JSON
      s.textContent = (msg.tool === "done" && args.summary ? String(args.summary) : JSON.stringify(args)).slice(0, 180);
      el.append(b, s);
      card.append(el);
      logEl.appendChild(card);
      logEl.scrollTop = logEl.scrollHeight;
      stepCard = card;
      break;
    }
    case "step-result": {
      const el = document.createElement("div");
      el.className = "step " + (msg.ok ? "ok" : "bad");
      const b = document.createElement("b");
      b.textContent = msg.ok ? "ok" : "fail";
      const s = document.createElement("span");
      s.className = "res";
      s.textContent = clip(msg.text || "", 220);
      el.append(b, s);
      const card = stepCard || logEl.appendChild(Object.assign(document.createElement("div"), { className: "step-card" }));
      card.append(el);
      if (!msg.ok) card.classList.add("bad");
      logEl.scrollTop = logEl.scrollHeight;
      stepCard = null;
      break;
    }
    case "screenshot": {
      const img = document.createElement("img");
      img.className = "shot";
      img.src = msg.dataUrl;
      logEl.appendChild(img);
      logEl.scrollTop = logEl.scrollHeight;
      break;
    }
    case "progress":
      document.body.dataset.step = String(msg.step || "");
      break;
    case "usage":
      if (msg.usage?.total_tokens) {
        metaEl.textContent = `${cfg.model} - ${msg.usage.total_tokens} tk`;
        document.body.dataset.tokens = String(msg.usage.total_tokens);
      }
      break;
    case "final":
      document.body.dataset.lastFinal = msg.text || "";
      stepCard = null;
      if (!msg.text) break;
      if (!assistantEl) assistantEl = addEl("msg assistant", "");
      assistantEl.textContent = msg.text;
      // a conclusao fecha a conversa: se passos vieram depois do stream, desce ela para o fim
      if (assistantEl !== logEl.lastElementChild) logEl.append(assistantEl);
      assistantEl = null;
      logEl.scrollTop = logEl.scrollHeight;
      break;
    case "error": {
      stepCard = null;
      addEl("msg err", msg.text || "erro");
      dot.classList.add("err");
      setTimeout(() => dot.classList.remove("err"), 2600);
      break;
    }
    case "cleared":
      logEl.textContent = "";
      document.body.dataset.lastFinal = "";
      stepCard = null;
      break;
    case "busy":
      setBusy(!!msg.value);
      break;
    case "turn-end":
      setBusy(false);
      stepCard = null;
      break;
  }
}

function command(text) {
  const cmd = text.slice(1).trim();
  if (cmd === "clear") {
    port?.postMessage({ type: "clear" });
    return true;
  }
  if (cmd === "opts") {
    chrome.runtime.sendMessage({ type: "open-options" });
    return true;
  }
  if (cmd === "reason") {
    logEl.classList.toggle("hide-reason");
    addEl("msg sys", logEl.classList.contains("hide-reason") ? "raciocinio oculto" : "raciocinio visivel");
    return true;
  }
  if (cmd.startsWith("model")) {
    const id = cmd.split(/\s+/)[1];
    if (id) port?.postMessage({ type: "set-agent", id });
    addEl("msg sys", id ? `agente -> ${id}` : `agente atual: ${cfg.agent || "nodecode"}`);
    return true;
  }
  if (cmd.startsWith("neon")) {
    const c = cmd.split(/\s+/)[1];
    if (!/^#[0-9a-f]{6}$/i.test(c || "")) {
      addEl("msg sys", "uso: /neon #22d3ee");
      return true;
    }
    chrome.storage.sync.get("sp_config").then((got) => {
      chrome.storage.sync.set({ sp_config: { ...(got.sp_config || {}), neon: c } });
      addEl("msg sys", `ponteiro neon ${c}`);
    });
    return true;
  }
  if (cmd === "target") {
    port?.postMessage({ type: "target" });
    return true;
  }
  return false;
}

function send() {
  const text = ta.value.trim();
  if (!text || busy) return;
  if (text.startsWith("/") && command(text)) {
    ta.value = "";
    ta.style.height = "auto";
    document.body.dataset.ta = ta.value;
    return;
  }
  addEl("msg user", text);
  ta.value = "";
  ta.style.height = "auto";
  document.body.dataset.ta = ta.value;
  port?.postMessage({ type: "ask", text });
}

sendBtn.addEventListener("click", () => {
  if (busy) port?.postMessage({ type: "stop" });
  else send();
});

ta.addEventListener("input", () => {
  document.body.dataset.ta = ta.value;
  ta.style.height = "auto";
  ta.style.height = Math.min(ta.scrollHeight, Math.round(innerHeight * 0.4)) + "px";
});

ta.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});

document.querySelectorAll(".icon").forEach((b) => {
  b.addEventListener("click", () => {
    const act = b.dataset.act;
    if (act === "settings") chrome.runtime.sendMessage({ type: "open-options" });
    if (act === "clear") port?.postMessage({ type: "clear" });
  });
});

chrome.storage.onChanged.addListener((changes) => {
  if (!changes.sp_config) return;
  cfg = { ...cfg, ...(changes.sp_config.newValue || {}) };
  metaEl.textContent = `${cfg.agent || "nodecode"} / ${cfg.model || "-"}`;
});

// Atalhos do rodape: clicar num /comando coloca ele no campo.
document.querySelectorAll(".hint code").forEach((c) => {
  c.addEventListener("click", () => {
    ta.value = c.textContent + " ";
    ta.dispatchEvent(new Event("input"));
    ta.focus();
  });
});

connect();
ta.focus();
