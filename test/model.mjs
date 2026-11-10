// Prova o cliente contra servidores falsos: openai (reasoning + tool_calls)
// e anthropic (thinking_delta + tool_use), mais a conversao de mensagens.
import http from "node:http";
import { chat, toAnthropic, parseArgs, pingProfile, ModelError } from "../lib/model.js";
import { resolveProfile, PRESETS } from "../lib/providers.js";

let fails = 0;
const ok = (cond, name, extra) => {
  console.log((cond ? "PASS " : "FAIL ") + name + (extra === undefined ? "" : " :: " + JSON.stringify(extra).slice(0, 320)));
  if (!cond) fails++;
};

let sawOpenaiBody = null;
let sawAnthropicBody = null;

const sse = (res, chunks) => {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
};

const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (d) => (raw += d));
  req.on("end", () => {
    const body = raw ? JSON.parse(raw) : {};
    if (req.url === "/v1/models") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "fake-1" }, { id: "fake-2" }] }));
      return;
    }
    if (req.url === "/v1/chat/completions") {
      sawOpenaiBody = body;
      if (req.headers.authorization !== "Bearer sk-fake") {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "bad key" }));
        return;
      }
      sse(res, [
        { choices: [{ delta: { role: "assistant", content: "" } }] },
        { choices: [{ delta: { reasoning: "preciso " } }] },
        { choices: [{ delta: { reasoning: "clicar no botao" } }] },
        { choices: [{ delta: { content: "vou clicar" } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_a", function: { name: "click", arguments: '{"ref":' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"e7"}' } }] } }] },
        { choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { total_tokens: 42 } },
      ]);
      return;
    }
    if (req.url === "/v1/messages") {
      sawAnthropicBody = body;
      if (req.headers["x-api-key"] !== "sk-ant") {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "bad key" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const ev = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      ev({ type: "message_start", message: { usage: { input_tokens: 11 } } });
      ev({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } });
      ev({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "o campo esta occludido" } });
      ev({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } });
      ev({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "vou fechar o overlay" } });
      ev({ type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "tu_1", name: "click" } });
      ev({ type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"text":' } });
      ev({ type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '"fechar"}' } });
      ev({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 7 } });
      res.end();
      return;
    }
    res.writeHead(404);
    res.end("{}");
  });
});

await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}/v1`;

try {
  // ---------- openai
  const deltas = [];
  const thinks = [];
  const r1 = await chat({
    protocol: "openai", baseUrl: base, key: "sk-fake", model: "fake-1",
    messages: [{ role: "user", content: "clique no botao" }],
    tools: [{ type: "function", function: { name: "click", parameters: { type: "object", properties: {} } } }],
    temperature: 0.2, reasoningEffort: "high",
    onDelta: (d) => deltas.push(d), onReasoning: (d) => thinks.push(d),
  });
  ok(r1.reasoning === "preciso clicar no botao", "openai: reasoning capturado", r1.reasoning);
  ok(thinks.join("") === r1.reasoning, "openai: onReasoning entrega o reasoning ao vivo", thinks);
  ok(r1.message.content === "vou clicar", "openai: conteudo capturado", r1.message.content);
  ok(deltas.join("") === "vou clicar", "openai: onDelta entrega o conteudo ao vivo");
  ok(r1.message.tool_calls?.[0]?.function?.name === "click", "openai: tool call com nome");
  ok(parseArgs(r1.message.tool_calls[0].function.arguments).ref === "e7", "openai: argumentos JSON acumulados por fragmento", r1.message.tool_calls[0].function.arguments);
  ok(r1.usage?.total_tokens === 42, "openai: usage", r1.usage);
  ok(sawOpenaiBody.reasoning_effort === "high", "openai: reasoning_effort repassado no corpo");
  ok(sawOpenaiBody.stream === true && sawOpenaiBody.tools?.length === 1, "openai: stream e tools no corpo");

  // ---------- anthropic
  const at = { role: "system", content: "seja seco" };
  const conv = toAnthropic([
    at,
    { role: "user", content: "feche o overlay" },
    { role: "assistant", content: "vou clicar", tool_calls: [{ id: "tu_0", type: "function", function: { name: "click", arguments: '{"text":"x"}' } }] },
    { role: "tool", tool_call_id: "tu_0", content: "ok" },
    { role: "user", content: [{ type: "text", text: "veja" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] },
  ]);
  ok(conv.system === "seja seco", "anthropic: system separado");
  ok(conv.messages[1].content[1].type === "tool_use" && conv.messages[1].content[1].input.text === "x", "anthropic: assistant tool_calls viram tool_use", conv.messages[1].content);
  ok(conv.messages[2].role === "user" && conv.messages[2].content[0].type === "tool_result", "anthropic: tool vira tool_result em mensagem user");
  ok(conv.messages[3].content[1].type === "image", "anthropic: data URL vira bloco image", conv.messages[3].content[1]);

  const r2 = await chat({
    protocol: "anthropic", baseUrl: base, key: "sk-ant", model: "claude-fake",
    messages: [{ role: "user", content: "feche o overlay" }],
    tools: [{ type: "function", function: { name: "click", description: "clica", parameters: { type: "object", properties: { text: { type: "string" } } } } }],
  });
  ok(r2.reasoning === "o campo esta occludido", "anthropic: thinking capturado", r2.reasoning);
  ok(r2.message.content === "vou fechar o overlay", "anthropic: texto capturado");
  ok(r2.message.tool_calls?.[0]?.function?.arguments === '{"text":"fechar"}', "anthropic: input_json_delta acumulado", r2.message.tool_calls?.[0]);
  ok(r2.usage?.output_tokens === 7, "anthropic: usage de message_delta", r2.usage);
  ok(sawAnthropicBody.system === undefined && Array.isArray(sawAnthropicBody.messages), "anthropic: corpo com messages");
  ok(sawAnthropicBody.tools?.[0]?.input_schema?.properties?.text?.type === "string", "anthropic: tools com input_schema");

  // ---------- erros e perfis
  let err = null;
  try {
    await chat({ protocol: "openai", baseUrl: base, key: "errada", model: "fake", messages: [{ role: "user", content: "x" }] });
  } catch (e) { err = e; }
  ok(err instanceof ModelError && /HTTP 401/.test(err.message), "chave errada vira ModelError HTTP 401", err && err.message);

  const health = await pingProfile({ protocol: "openai", baseUrl: base, key: "sk-fake", model: "fake-1" });
  ok(/fake-1, fake-2/.test(health), "pingProfile lista modelos", health);

  const cfg = { agent: "openai", profiles: { openai: { baseUrl: base, key: "sk-fake", model: "gpt-x", reasoningEffort: "low" } }, temperature: 0.1 };
  const p = resolveProfile(cfg, "agent");
  ok(p.protocol === "openai" && p.model === "gpt-x" && p.baseUrl === base, "resolveProfile usa o perfil salvo", p && { base: p.baseUrl, model: p.model });
  ok(p.reasoningEffort === "low", "resolveProfile le reasoningEffort do perfil");
  const legacy = resolveProfile({ baseUrl: base, key: "k", model: "m" }, "agent");
  ok(legacy.model === "m", "resolveProfile honra config legada sem agent");
  const any = resolveProfile(cfg, "deepseek");
  ok(any.id === "deepseek" && any.protocol === "openai", "resolveProfile por id de preset", any.id);
  ok(PRESETS.some((x) => x.protocol === "anthropic"), "preset anthropic presente");
} finally {
  server.close();
}

console.log(fails === 0 ? "\nTUDO VERDE" : `\n${fails} FALHA(S)`);
process.exit(fails ? 1 : 0);
