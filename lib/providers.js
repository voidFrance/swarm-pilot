// Registro de provedores. A extensao fala DOIS protocolos:
//   openai    -> POST {baseUrl}/chat/completions, Bearer, SSE com delta.content|delta.reasoning
//   anthropic -> POST {baseUrl}/messages, x-api-key, SSE com content_block_delta
// Qualquer endpoint OpenAI-compativel entra como "custom" (ou "openai"), com baseUrl/model/key.
// "profile" e a instancia escolhida; "advisor" e o perfil que ask_agent consulta.

export const PRESETS = [
  {
    id: "nodecode",
    label: "Nodecode (Cyber v1)",
    protocol: "openai",
    baseUrl: "https://api.nodecode.ai/v1",
    model: "nodecode-cyber-v1",
    vision: true,
    reasoning: true,
    note: "stream com delta.reasoning; 1M ctx",
  },
  {
    id: "openai",
    label: "OpenAI",
    protocol: "openai",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-5",
    vision: true,
    reasoning: true,
  },
  {
    id: "anthropic",
    label: "Anthropic",
    protocol: "anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    model: "claude-sonnet-4-5",
    vision: true,
    reasoning: true,
    note: "protocolo nativo /messages, thinking_delta",
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    protocol: "openai",
    baseUrl: "https://api.deepseek.com/v1",
    model: "deepseek-reasoner",
    vision: false,
    reasoning: true,
    note: "delta.reasoning_content",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    protocol: "openai",
    baseUrl: "https://openrouter.ai/api/v1",
    model: "openrouter/auto",
    vision: true,
    reasoning: true,
  },
  {
    id: "groq",
    label: "Groq",
    protocol: "openai",
    baseUrl: "https://api.groq.com/openai/v1",
    model: "llama-3.3-70b-versatile",
    vision: false,
    reasoning: true,
  },
  {
    id: "ollama",
    label: "Ollama (local)",
    protocol: "openai",
    baseUrl: "http://127.0.0.1:11434/v1",
    model: "qwen3:8b",
    vision: false,
    reasoning: true,
    note: "sem chave; preencha qualquer coisa em key",
  },
  {
    id: "boca",
    label: "boca-livre (gateway proprio)",
    protocol: "openai",
    baseUrl: "https://boca.agendapix.dev.br/v1",
    model: "cyber-v1",
    vision: true,
    reasoning: true,
  },
  {
    id: "custom",
    label: "Custom (OpenAI-compat)",
    protocol: "openai",
    baseUrl: "",
    model: "",
    vision: true,
    reasoning: true,
  },
];

export const byId = (id) => PRESETS.find((p) => p.id === id) || null;

// Config efetiva = preset + override do perfil salvo + campos legados do topo do sp_config.
export function resolveProfile(config = {}, which = "agent") {
  const activeId = which === "advisor" ? config.advisor || config.agent : which === "agent" ? config.agent : which;
  const preset = byId(activeId) || byId("custom") || PRESETS[0];
  const saved = (config.profiles || {})[activeId] || {};
  const legacy = which === "agent" && !config.agent
    ? { baseUrl: config.baseUrl, key: config.key, model: config.model }
    : {};
  const key = saved.key || legacy.key || "";
  const baseUrl = String(saved.baseUrl || legacy.baseUrl || preset.baseUrl || "").replace(/\/+$/, "");
  const model = saved.model || legacy.model || preset.model || "";
  return {
    id: preset.id,
    label: preset.label,
    protocol: saved.protocol || preset.protocol,
    baseUrl,
    key,
    model,
    vision: saved.vision ?? preset.vision,
    reasoning: saved.reasoning ?? preset.reasoning,
    temperature: saved.temperature ?? config.temperature ?? 0.25,
    reasoningEffort: saved.reasoningEffort ?? config.reasoningEffort ?? "",
  };
}

export function describe(profile) {
  const proto = profile.protocol === "anthropic" ? "anthropic" : "openai";
  const hasKey = profile.key ? "chave ok" : "SEM CHAVE";
  return `${profile.id} -> ${profile.baseUrl} | ${profile.model} | ${proto} | ${hasKey}`;
}
