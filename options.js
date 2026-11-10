import { PRESETS, byId, resolveProfile } from "./lib/providers.js";
import { pingProfile } from "./lib/model.js";

const DEFAULTS = {
  agent: "nodecode",
  advisor: "",
  temperature: 0.25,
  pointerMs: 320,
  neon: "#22d3ee",
  vision: true,
  reasoningEffort: "low",
  profiles: {},
};

const $ = (id) => document.getElementById(id);
const statusEl = $("status");
let cfg = { ...DEFAULTS, profiles: {} };

const setStatus = (text, bad = false) => {
  statusEl.textContent = text;
  statusEl.className = bad ? "bad" : "";
  if (text) setTimeout(() => (statusEl.textContent = ""), 6000);
};

const fillSelect = (el, list, withEmpty) => {
  el.replaceChildren();
  if (withEmpty) el.appendChild(new Option("- nenhum -", ""));
  for (const p of list) el.appendChild(new Option(`${p.label} [${p.protocol}]`, p.id));
};

function loadProfileFields() {
  const id = $("agent").value;
  const preset = byId(id);
  const saved = cfg.profiles[id] || {};
  $("p_baseUrl").value = saved.baseUrl || preset?.baseUrl || "";
  $("p_key").value = saved.key || "";
  $("p_model").value = saved.model || preset?.model || "";
  $("protocol").value = saved.protocol || preset?.protocol || "openai";
  $("presetNote").textContent = preset?.note ? `${preset.label}: ${preset.note}` : "";
}

function saveProfileFields() {
  const id = $("agent").value;
  cfg.profiles[id] = {
    baseUrl: $("p_baseUrl").value.trim(),
    key: $("p_key").value.trim(),
    model: $("p_model").value.trim(),
    protocol: $("protocol").value,
  };
}

async function load() {
  const got = await chrome.storage.sync.get("sp_config");
  const raw = got.sp_config || {};
  cfg = { ...DEFAULTS, ...raw, profiles: { ...(raw.profiles || {}) } };
  // legado: chave/modelo no topo viram o perfil nodecode
  if (raw.key && !cfg.profiles.nodecode?.key) {
    cfg.profiles.nodecode = { baseUrl: raw.baseUrl, key: raw.key, model: raw.model };
  }
  fillSelect($("agent"), PRESETS, false);
  fillSelect($("advisor"), PRESETS, true);
  $("agent").value = byId(cfg.agent) ? cfg.agent : "nodecode";
  $("advisor").value = cfg.advisor && byId(cfg.advisor) ? cfg.advisor : "";
  $("reasoningEffort").value = cfg.reasoningEffort || "";
  $("pointerMs").value = cfg.pointerMs;
  $("neon").value = cfg.neon;
  $("temperature").value = cfg.temperature;
  $("vision").checked = cfg.vision !== false;
  loadProfileFields();
}

$("agent").addEventListener("change", () => {
  saveProfileFields();
  loadProfileFields();
});

$("save").addEventListener("click", async () => {
  saveProfileFields();
  const agent = $("agent").value;
  const p = cfg.profiles[agent] || {};
  if (!p.baseUrl || !p.model) return setStatus("baseUrl e model sao obrigatorios no perfil", true);
  if (!/^#[0-9a-f]{6}$/i.test($("neon").value)) return setStatus("cor do ponteiro precisa ser #rrggbb", true);
  const out = {
    ...cfg,
    ...(cfg.profiles[agent] || {}),
    agent,
    advisor: $("advisor").value,
    reasoningEffort: $("reasoningEffort").value,
    temperature: Number($("temperature").value),
    pointerMs: Number($("pointerMs").value),
    neon: $("neon").value,
    vision: $("vision").checked,
  };
  // campos legados do topo acompanham o perfil ativo (compatibilidade)
  out.baseUrl = p.baseUrl;
  out.key = p.key;
  out.model = p.model;
  await chrome.storage.sync.set({ sp_config: out });
  cfg = out;
  setStatus("salvo");
});

$("test").addEventListener("click", async () => {
  saveProfileFields();
  const profile = resolveProfile({ ...cfg, agent: $("agent").value }, "agent");
  if (!profile.model) return setStatus("sem modelo", true);
  setStatus("testando...");
  try {
    setStatus(await pingProfile(profile));
  } catch (e) {
    setStatus(String(e.message || e) + (e.detail ? " :: " + String(e.detail).slice(0, 120) : ""), true);
  }
});

$("reset").addEventListener("click", async () => {
  await chrome.storage.sync.set({ sp_config: { ...DEFAULTS } });
  await load();
  setStatus("padroes restaurados");
});

load();
