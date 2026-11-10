// Port do painel lateral, perfis de agente, orcamento, historico e anexo CDP.
// A UI vive em sidepanel.html (pagina da extensao); o conteudo injetado na aba e
// apenas o ponteiro neon (content/pointer.js).

import { runTurn } from "./lib/agent.js";
import * as cdp from "./lib/cdp.js";

const DEFAULTS = {
  baseUrl: "https://api.nodecode.ai/v1",
  key: "", // o usuario cola a chave em OPCOES; chave embutida vira conta de todos
  model: "nodecode-cyber-v1",
  temperature: 0.25,
  pointerMs: 320,
  neon: "#22d3ee",
  vision: true,
  autoAttach: true,
  agent: "nodecode",
  advisor: "",
  reasoningEffort: "low",
  profiles: {},
};

async function getConfig() {
  const stored = await chrome.storage.sync.get("sp_config");
  const raw = { ...DEFAULTS, ...(stored.sp_config || {}) };
  const cfg = { ...raw, profiles: { ...(raw.profiles || {}) } };
  // nao ha mais teto de passos: o turno so acaba quando a tarefa termina. A chave
  // antiga fica no storage de quem ja salvou a config; some daqui para nao voltar.
  if ("maxSteps" in cfg) delete cfg.maxSteps;
  if (raw.key && !cfg.profiles.nodecode?.key) {
    cfg.profiles.nodecode = { baseUrl: raw.baseUrl, key: raw.key, model: raw.model };
  }
  return cfg;
}

async function seed() {
  const stored = await chrome.storage.sync.get("sp_config");
  if (!stored.sp_config) await chrome.storage.sync.set({ sp_config: { ...DEFAULTS } });
}

async function enablePanelBehavior() {
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch (e) {}
}

chrome.runtime.onInstalled.addListener(async (d) => {
  await seed();
  const got = await chrome.storage.sync.get("sp_config");
  const cfg = got.sp_config || {};
  if (cfg.swarmMs && !cfg.pointerMs) cfg.pointerMs = cfg.swarmMs;
  delete cfg.swarmCount;
  delete cfg.swarmMs;
  if (cfg.key && !(cfg.profiles || {}).nodecode) {
    cfg.profiles = { ...(cfg.profiles || {}), nodecode: { baseUrl: cfg.baseUrl, key: cfg.key, model: cfg.model } };
  }
  if (!cfg.agent) cfg.agent = "nodecode";
  if (!cfg.reasoningEffort) cfg.reasoningEffort = "low";
  if (d?.reason === "update") await chrome.storage.sync.set({ sp_config: { ...DEFAULTS, ...cfg } });
  await enablePanelBehavior();
});

chrome.runtime.onStartup.addListener(async () => {
  await seed();
  await enablePanelBehavior();
});
enablePanelBehavior();

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "toggle-panel") return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try {
    if (chrome.sidePanel.close && (await isPanelOpen(tab?.windowId))) {
      await chrome.sidePanel.close({ windowId: tab.windowId });
    } else {
      await chrome.sidePanel.open({ windowId: tab.windowId });
    }
  } catch (e) {
    try { await chrome.sidePanel.open({ windowId: tab?.windowId }); } catch (e2) {}
  }
});

// setPanelBehavior ja abre no clique do icone; o listener cobre o fallback.
chrome.action.onClicked.addListener(async (tab) => {
  try {
    await chrome.sidePanel.open({ windowId: tab?.windowId });
  } catch (e) {}
});

const openPanels = new Set();
async function isPanelOpen(windowId) {
  return Number.isInteger(windowId) && openPanels.has(windowId);
}

chrome.tabs.onRemoved.addListener((tabId) => {
  cdp.detach(tabId).catch(() => {});
  chrome.storage.session.remove([`hist:${tabId}`]).catch(() => {});
});

const historyKey = (tabId) => `hist:${tabId}`;

async function loadHistory(tabId) {
  try {
    const got = await chrome.storage.session.get(historyKey(tabId));
    return got[historyKey(tabId)] || [];
  } catch (e) {
    return [];
  }
}

async function saveHistory(tabId, messages) {
  try {
    const trimmed = messages.length > 36 ? messages.slice(messages.length - 36) : messages;
    await chrome.storage.session.set({ [historyKey(tabId)]: trimmed });
  } catch (e) {}
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

// chrome.debugger recusa chrome://, about: (menos blank), devtools, view-source,
// Web Store e o viewer de PDF. Escolher o alvo depois de descobrir isso e caro:
// o turno inteiro morre no attach.
const RESTRICTED = /^(chrome|edge|brave|vivaldi|opera|devtools|view-source|chrome-extension|chrome-untrusted|chrome-search):|^https:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore)/i;

const isAttachable = (url) => {
  const u = String(url || "");
  if (/^about:blank/i.test(u)) return true;
  if (/^about:/i.test(u)) return false;
  return !RESTRICTED.test(u);
};

const waitComplete = async (tabId, ms = 4000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const t = await chrome.tabs.get(tabId);
      if (t && t.status === "complete") return t;
    } catch (e) {}
    await new Promise((r) => setTimeout(r, 80));
  }
  try { return await chrome.tabs.get(tabId); } catch (e) { return null; }
};

// Devolve a aba que o agente vai dirigir, com o motivo quando troca:
// aba vazia (New Tab) vira about:blank; aba restrita cede lugar a uma normal.
async function pickTab(preferredId) {
  let tab = null;
  if (preferredId) {
    try { tab = await chrome.tabs.get(preferredId); } catch (e) {}
  }
  if (!tab) tab = await activeTab();
  if (!tab) return { tab: null, note: "nenhuma aba na janela" };
  if (isAttachable(tab.url)) return { tab, note: null };

  // New Tab vazio: nada a perder, vira about:blank e segue.
  if (!tab.url || /^(chrome|edge|brave|vivaldi|opera):\/\/(newtab|new-tab)/i.test(tab.url)) {
    try {
      await chrome.tabs.update(tab.id, { url: "about:blank" });
      const done = await waitComplete(tab.id, 3000);
      return { tab: done || tab, note: "aba vazia trocada por about:blank" };
    } catch (e) {}
  }

  // Outra aba normal na mesma janela: melhor que falhar.
  try {
    const all = await chrome.tabs.query({ windowId: tab.windowId });
    const cand = all.find((t) => t.id !== tab.id && isAttachable(t.url));
    if (cand) {
      await chrome.tabs.update(cand.id, { active: true }).catch(() => {});
      return { tab: cand, note: `aba restrita (${tab.url}) trocada por ${cand.title || cand.url}` };
    }
  } catch (e) {}

  return { tab, note: `aba ${tab.url} nao aceita debugger - abra uma pagina http(s)` };
}
self.__pickTab = pickTab;

async function ensurePointer(tabId) {
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: "ping-pointer" }, { frameId: 0 });
    if (res?.ok) return true;
  } catch (e) {}
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content/pointer.js"] });
    return true;
  } catch (e) {
    return false;
  }
}

// A tela de opcoes e uma pagina da extensao aberta em aba. O painel pede por
// mensagem avulsa (nao pelo port), entao precisa de um onMessage que responda:
// sem isto o botao de engrenagem fica mudo.
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg?.type === "open-options") {
    chrome.runtime
      .openOptionsPage()
      .then(() => reply({ ok: true }))
      .catch(async () => {
        try {
          await chrome.tabs.create({ url: chrome.runtime.getURL("options.html") });
          reply({ ok: true });
        } catch (e) {
          reply({ ok: false, error: String(e?.message || e) });
        }
      });
    return true;
  }
  if (msg?.type === "ping") {
    reply({ ok: true, version: chrome.runtime.getManifest().version });
    return false;
  }
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "panel") return;
  const windowId = port.sender?.tab?.windowId;
  if (windowId !== undefined) openPanels.add(windowId);
  let controller = null;
  let busy = false;

  const emit = (msg) => {
    try {
      self.__types = ((self.__types || "") + "," + msg.type).slice(-600);
      port.postMessage(msg);
    } catch (e) {}
  };

  // O clique no alvo e animado pelo ponteiro; teto duro para nunca travar a acao.
  const pointer = async (x, y, label) => {
    try {
      const tab = await activeTab();
      if (!tab) return;
      await Promise.race([
        chrome.tabs.sendMessage(tab.id, { type: "pointer", x, y, label, press: true }, { frameId: 0 }),
        new Promise((r) => setTimeout(r, 900)),
      ]);
    } catch (e) {}
  };

  port.onMessage.addListener(async (msg) => {
    if (msg.type === "config") {
      emit({ type: "config", config: await getConfig() });
      return;
    }

    if (msg.type === "target") {
      const { tab, note } = await pickTab();
      emit({ type: "target", id: tab?.id, title: tab?.title, url: tab?.url, note });
      return;
    }

    if (msg.type === "set-agent") {
      const stored = await chrome.storage.sync.get("sp_config");
      const cfg = stored.sp_config || {};
      cfg.agent = String(msg.id || "nodecode");
      await chrome.storage.sync.set({ sp_config: cfg });
      emit({ type: "config", config: await getConfig() });
      emit({ type: "status", text: `agente -> ${cfg.agent}` });
      return;
    }

    if (msg.type === "ask") {
      if (busy) {
        emit({ type: "error", text: "ainda estou executando o passo anterior" });
        return;
      }
      const picked = await pickTab(msg.tabId);
      const tab = picked.tab;
      if (!tab?.id) {
        emit({ type: "error", text: "nenhuma aba ativa" });
        return;
      }
      if (picked.note) emit({ type: "status", text: picked.note });
      const tabId = tab.id;
      busy = true;
      controller = new AbortController();
      emit({ type: "turn-start" });
      emit({ type: "busy", value: true });
      emit({ type: "target", id: tab.id, title: tab.title, url: tab.url });
      try {
        const config = await getConfig();
        if (!config.key) throw new Error("sem chave da API: abra as opcoes do Swarm Pilot");
        if (!cdp.isAttached(tabId)) emit({ type: "status", text: "anexando debugger (CDP)..." });
        await cdp.attach(tabId);
        await ensurePointer(tabId);
        const history = await loadHistory(tabId);
        const result = await runTurn({
          tabId,
          text: msg.text,
          history,
          config,
          emit: (m) => emit(m),
          onSwarm: async (x, y, label) => {
            emit({ type: "status", text: `ponteiro -> ${label} @${x},${y}` });
            await pointer(x, y, label);
          },
          signal: controller.signal,
        });
        await saveHistory(result.tabId || tabId, result.history || []);
      } catch (e) {
        emit({ type: "error", text: String(e?.message || e) });
        emit({ type: "final", text: "(falhou antes de responder)" });
      } finally {
        busy = false;
        controller = null;
        emit({ type: "busy", value: false });
        emit({ type: "turn-end" });
      }
      return;
    }

    if (msg.type === "stop") {
      controller?.abort();
      emit({ type: "status", text: "interrompido" });
      return;
    }

    if (msg.type === "clear") {
      const tab = (await pickTab()).tab;
      if (tab?.id) await saveHistory(tab.id, []);
      emit({ type: "cleared" });
      return;
    }

    if (msg.type === "detach") {
      const tab = await activeTab();
      if (tab?.id) await cdp.detach(tab.id);
      emit({ type: "status", text: "debugger liberado" });
    }
  });

  port.onDisconnect.addListener(() => {
    if (windowId !== undefined) openPanels.delete(windowId);
    controller?.abort();
  });
});
