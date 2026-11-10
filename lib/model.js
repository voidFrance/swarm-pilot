// Cliente de modelo. Fala dois protocolos:
//   openai    -> /chat/completions (Bearer), SSE: delta.content, delta.reasoning,
//                delta.reasoning_content, delta.thinking, delta.tool_calls[i]
//   anthropic -> /messages (x-api-key), SSE: content_block_delta com text_delta,
//                thinking_delta, input_json_delta
// Formato canonico interno: mensagens no formato OpenAI. toAnthropic() converte na hora.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class ModelError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = "ModelError";
    this.detail = detail;
  }
}

const isAbort = (e) => e?.name === "AbortError" || /abort/i.test(String(e?.message || ""));

export function parseArgs(raw) {
  if (!raw) return {};
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(raw);
  } catch (e) {
    const m = String(raw).match(/\[[\s\S]*\]|\{[\s\S]*\}/);
    if (m) {
      try {
        return JSON.parse(m[0]);
      } catch (e2) {}
    }
    return { _raw: String(raw).slice(0, 200) };
  }
}

// ---------------------------------------------------------------- conversao

function dataUrlToBlock(url) {
  const m = String(url).match(/^data:([^;]+);base64,(.*)$/);
  if (!m) return null;
  return { type: "image", source: { type: "base64", media_type: m[1], data: m[2] } };
}

export function toAnthropic(messages) {
  const system = [];
  const out = [];
  for (const m of messages) {
    if (m.role === "system") {
      system.push(typeof m.content === "string" ? m.content : String(m.content?.map?.((c) => c.text).join("\n") || ""));
      continue;
    }
    if (m.role === "tool") {
      const block = { type: "tool_result", tool_use_id: m.tool_call_id, content: String(m.content ?? "") };
      const last = out[out.length - 1];
      if (last && last.role === "user" && Array.isArray(last.content) && last.content.every((c) => c.type === "tool_result")) {
        last.content.push(block);
      } else {
        out.push({ role: "user", content: [block] });
      }
      continue;
    }
    if (m.role === "assistant") {
      const parts = [];
      if (m.content) parts.push({ type: "text", text: String(m.content) });
      for (const tc of m.tool_calls || []) {
        parts.push({
          type: "tool_use",
          id: tc.id || `call_${parts.length}`,
          name: tc.function?.name || "",
          input: parseArgs(tc.function?.arguments) || {},
        });
      }
      out.push({ role: "assistant", content: parts.length ? parts : [{ type: "text", text: "(vazio)" }] });
      continue;
    }
    // user
    if (Array.isArray(m.content)) {
      const parts = [];
      for (const c of m.content) {
        if (c.type === "text") parts.push({ type: "text", text: String(c.text) });
        else if (c.type === "image_url") {
          const b = dataUrlToBlock(c.image_url?.url || "");
          if (b) parts.push(b);
        }
      }
      out.push({ role: "user", content: parts.length ? parts : [{ type: "text", text: "(vazio)" }] });
      continue;
    }
    out.push({ role: "user", content: String(m.content ?? "") });
  }
  return { system: system.join("\n\n").trim(), messages: out };
}

export function toAnthropicTools(tools) {
  return (tools || []).map((t) => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters || { type: "object", properties: {} },
  }));
}

// ---------------------------------------------------------------- SSE

function sseLines(buffer, chunk) {
  buffer += chunk;
  const events = [];
  let idx;
  while ((idx = buffer.indexOf("\n\n")) !== -1) {
    events.push(buffer.slice(0, idx));
    buffer = buffer.slice(idx + 2);
  }
  // alguns servidores usam CRLF
  const crlf = buffer.indexOf("\r\n\r\n");
  if (crlf !== -1) {
    buffer.split("\r\n\r\n").forEach((b, i, arr) => {
      if (i < arr.length - 1) events.push(b);
    });
    buffer = buffer.slice(buffer.lastIndexOf("\r\n\r\n") + 4);
  }
  return { events, buffer };
}

async function pump(body, onEvent) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    const r = sseLines(buffer, decoder.decode(value, { stream: true }));
    buffer = r.buffer;
    for (const raw of r.events) {
      for (const line of raw.split(/\r?\n/)) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        let evt;
        try {
          evt = JSON.parse(payload);
        } catch (e) {
          continue;
        }
        onEvent(evt);
      }
    }
  }
}

// ---------------------------------------------------------------- openai

function openaiBody({ model, messages, tools, temperature, reasoningEffort, maxTokens }) {
  const body = { model, messages, temperature: Number(temperature) || 0.25, stream: true };
  if (tools && tools.length) {
    body.tools = tools;
    body.tool_choice = "auto";
  }
  if (reasoningEffort) body.reasoning_effort = reasoningEffort;
  if (maxTokens) body.max_tokens = maxTokens;
  return body;
}

async function streamOpenai(res, { onDelta, onReasoning }) {
  let content = "";
  let reasoning = "";
  let finish = null;
  let usage = null;
  const calls = [];
  await pump(res.body, (evt) => {
    if (evt.usage) usage = evt.usage;
    if (evt.error) throw new ModelError(`erro do provedor`, JSON.stringify(evt.error).slice(0, 300));
    const choice = evt.choices?.[0];
    if (!choice) return;
    const delta = choice.delta || choice.message || {};
    const think = delta.reasoning ?? delta.reasoning_content ?? delta.thinking;
    if (typeof think === "string" && think.length) {
      reasoning += think;
      onReasoning?.(think);
    }
    if (typeof delta.content === "string" && delta.content.length) {
      content += delta.content;
      onDelta?.(delta.content);
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const i = Number.isInteger(tc.index) ? tc.index : calls.length;
        if (!calls[i]) calls[i] = { id: "", type: "function", function: { name: "", arguments: "" } };
        if (tc.id) calls[i].id = tc.id;
        if (tc.function?.name) calls[i].function.name += tc.function.name;
        if (tc.function?.arguments) calls[i].function.arguments += tc.function.arguments;
      }
    }
    if (choice.finish_reason) finish = choice.finish_reason;
  });
  const message = { role: "assistant", content: content.length ? content : null };
  if (calls.length) message.tool_calls = calls.filter(Boolean).map((c, i) => ({ ...c, id: c.id || `call_${i}` }));
  return { message, finish_reason: finish, usage, reasoning };
}

// ---------------------------------------------------------------- anthropic

async function streamAnthropic(res, { onDelta, onReasoning }) {
  let content = "";
  let reasoning = "";
  let finish = null;
  let usage = null;
  const blocks = new Map(); // index -> { id, name, json }
  await pump(res.body, (evt) => {
    switch (evt.type) {
      case "message_start":
        if (evt.message?.usage) usage = { ...evt.message.usage };
        break;
      case "content_block_start": {
        const b = evt.content_block || {};
        if (b.type === "tool_use") blocks.set(evt.index, { id: b.id, name: b.name, json: "" });
        break;
      }
      case "content_block_delta": {
        const d = evt.delta || {};
        if (d.type === "text_delta" && d.text) {
          content += d.text;
          onDelta?.(d.text);
        } else if (d.type === "thinking_delta" && d.thinking) {
          reasoning += d.thinking;
          onReasoning?.(d.thinking);
        } else if (d.type === "input_json_delta") {
          const b = blocks.get(evt.index);
          if (b) b.json += d.partial_json || "";
        }
        break;
      }
      case "message_delta":
        if (evt.delta?.stop_reason) finish = evt.delta.stop_reason;
        if (evt.usage) usage = { ...(usage || {}), ...evt.usage };
        break;
      case "error":
        throw new ModelError("erro do provedor", JSON.stringify(evt.error).slice(0, 300));
      default:
        break;
    }
  });
  const calls = [...blocks.values()].map((b, i) => ({
    id: b.id || `call_${i}`,
    type: "function",
    function: { name: b.name, arguments: b.json || "{}" },
  }));
  const message = { role: "assistant", content: content.length ? content : null };
  if (calls.length) message.tool_calls = calls;
  return { message, finish_reason: finish, usage, reasoning };
}

// ---------------------------------------------------------------- api

export async function chat({
  protocol = "openai",
  baseUrl,
  key,
  model,
  messages,
  tools,
  temperature = 0.25,
  reasoningEffort = "",
  maxTokens,
  vision,
  signal,
  onDelta,
  onReasoning,
}) {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  const isAnthropic = protocol === "anthropic";
  const url = isAnthropic ? `${base}/messages` : `${base}/chat/completions`;
  const headers = { "Content-Type": "application/json" };
  let body;
  if (isAnthropic) {
    headers["x-api-key"] = key || "";
    headers["anthropic-version"] = "2023-06-01";
    const conv = toAnthropic(messages);
    body = {
      model,
      max_tokens: maxTokens || 4096,
      temperature: Number(temperature) || 0.25,
      stream: true,
      messages: conv.messages,
    };
    if (conv.system) body.system = conv.system;
    if (tools && tools.length) body.tools = toAnthropicTools(tools);
  } else {
    if (key) headers.Authorization = `Bearer ${key}`;
    body = openaiBody({ model, messages, tools, temperature, reasoningEffort, maxTokens });
  }

  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (signal?.aborted) throw new ModelError("interrompido", "abort");
    try {
      const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        if ((res.status === 429 || res.status >= 500) && attempt < 2) {
          await sleep(900 * Math.pow(2, attempt));
          lastError = new ModelError(`HTTP ${res.status}`, text.slice(0, 400));
          continue;
        }
        throw new ModelError(`HTTP ${res.status}`, text.slice(0, 600));
      }
      if (!res.body) throw new ModelError("resposta sem corpo", "stream indisponivel");
      return await (isAnthropic ? streamAnthropic : streamOpenai)(res, { onDelta, onReasoning });
    } catch (e) {
      if (isAbort(e)) throw new ModelError("interrompido", "abort");
      lastError = e;
      const http4 = e instanceof ModelError && /^HTTP 4/.test(String(e.detail || "")) ;
      if (attempt < 2 && !http4) {
        await sleep(700 * Math.pow(2, attempt));
        continue;
      }
      throw e;
    }
  }
  throw lastError || new ModelError("falha desconhecida", "");
}

// health check de um perfil: lista modelos ou faz um turno minimo
export async function pingProfile(profile) {
  const base = String(profile.baseUrl || "").replace(/\/+$/, "");
  if (profile.protocol === "anthropic") {
    const res = await fetch(`${base}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": profile.key || "", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: profile.model, max_tokens: 16, messages: [{ role: "user", content: "ok" }] }),
    });
    if (!res.ok) throw new ModelError(`HTTP ${res.status}`, (await res.text()).slice(0, 300));
    return "ok (anthropic)";
  }
  const res = await fetch(`${base}/models`, { headers: profile.key ? { Authorization: `Bearer ${profile.key}` } : {} });
  if (!res.ok) throw new ModelError(`HTTP ${res.status}`, (await res.text()).slice(0, 300));
  const data = await res.json();
  const ids = (data.data || data || []).map((m) => m.id).slice(0, 12);
  return `ok (${ids.join(", ")})`;
}
