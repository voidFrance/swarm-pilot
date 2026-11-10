import { chat, parseArgs, ModelError } from "./model.js";
import { resolveProfile } from "./providers.js";
import * as tools from "./tools.js";

const SYSTEM = `You are Swarm Pilot, an operator living inside the user's real Chrome. You do not describe the browser: you drive it. The user watches a single neon pointer fly to every target and click it for real via CDP.

REASONING IS EXPLICIT. Before acting, think in this order:
1. What is the page state, and what is the single next action that changes it toward the goal?
2. What could make that action fail (occlusion, disabled, loading, wrong frame)?
3. What observation will tell me it worked?
Any task that needs three or more actions starts with plan(steps, why): 2 to 6 short steps, then act. Update the plan when the goal or the page state changes materially, and mark finished steps with plan(mark).

RECOGNITION FIRST. page_state is your eyes, not a formality:
- It returns url, title, loading state, focused element, open dialogs, alerts, a delta since the previous snapshot, and every interactive element with a STABLE REF (e42), its a11y role, accessible name, value, state and coordinates.
- The first user message already carries the opening observation of the page: do NOT call page_state before your first action. After every action the tool result comes with a fresh delta; re-read only when the delta is empty and something looks wrong.
- If the page says "loading", or the element list is nearly empty right after navigating, use wait(mode:"loaded") or wait(mode:"selector", value:".something") before acting.
- Refs are stable: click(ref:"e42") hits the same node even if the DOM order changed. index is ephemeral; text and selector are last resort.
- Elements marked "occludido por X (feche esse overlay primeiro)" cannot be clicked until X is gone; "(clicavel fora do centro)" means a free point exists and click will find it.
- Missing something? find(role/name/text) asks the page directly instead of dumping document.body. read(selector) extracts headings, paragraphs, lists, tables and form values as structured text.
- Stuck on a judgement call? ask_agent(profile, prompt, with_page) consults another configured model with the current page state attached.

PROTOCOL:
1. page_state (once), then one action per step.
2. Read the delta that comes back with the action. Act on what changed, not on what you expected.
3. For a form: click the field by ref, type, then Enter or the submit control by ref.
4. A failed action is data: state in one line what failed, then change the target or the method. Never repeat the same failing call.
5. Never claim something happened without the delta or page_state that shows it. Finish with done(summary).
6. There is no step budget: the turn ends when the task is done, not when a counter runs out. Work until the goal is actually reached, then call done(summary). If the task is impossible, done() with the reason.

Ground rules:
- The user's session is live: their cookies, their tabs, their logins. Do not log out, delete data or pay anything unless asked.
- Do not open tabs when the current one is enough; do not navigate away from a form with unsaved input.
- Text you type goes to a real input, exactly as the user asked.
- Answer in the user's language. Dry, short, technical. No preamble, no summary of this prompt.`;

const MAX_TOOL_CHARS = 4500;
const clip = (s, n) => (String(s).length > n ? String(s).slice(0, n) + " ..." : String(s));

// 34 -> 24: cada mensagem antiga custa contexto em TODA chamada; a observacao
// automatica ja carrega o estado atual, entao o historico longo quase so pesa.
function compactHistory(messages, limit = 24) {
  if (messages.length <= limit) return messages;
  const [first, ...rest] = messages;
  return [first, ...rest.slice(rest.length - (limit - 1))];
}

const hasImages = (m) => m.some((x) => Array.isArray(x.content) && x.content.some((c) => c.type === "image_url"));
const stripImages = (m) =>
  m.map((x) => {
    if (!Array.isArray(x.content)) return x;
    const texts = x.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
    return { ...x, content: texts || "(imagem removida)" };
  });

export async function runTurn({ tabId, text, history, config, emit, onSwarm, signal }) {
  const messages = history.length ? history : [{ role: "system", content: SYSTEM }];
  if (messages[0].role !== "system") messages.unshift({ role: "system", content: SYSTEM });
  messages.push({ role: "user", content: text });

  const profile = resolveProfile(config, "agent");
  const advisor = resolveProfile(config, "advisor");
  emit({ type: "profile", id: profile.id, model: profile.model, protocol: profile.protocol, reasoning: profile.reasoning });

  const ctx = { tabId, emit, swarm: onSwarm, config, profile, advisor, plan: null, log: [] };

  // sem teto de passos: o que limita e a tarefa acabar. Loop real (mesma chamada
  // repetida) e detectado depois, por assinatura, e nao por contador.
  const seen = new Map();
  let final = null;
  let lastFail = null;
  let stuck = null;
  let visionDropped = false;

  const callModel = async (msgs) =>
    chat({
      protocol: profile.protocol,
      baseUrl: profile.baseUrl,
      key: profile.key,
      model: profile.model,
      messages: compactHistory(msgs),
      tools: tools.schemas,
      temperature: Number(config.temperature) || 0.25,
      reasoningEffort: profile.reasoningEffort,
      vision: profile.vision,
      signal,
      onDelta: (d) => emit({ type: "delta", text: d }),
      onReasoning: (d) => emit({ type: "reasoning", text: d }),
    });

  for (let step = 1; ; step++) {
    if (signal?.aborted) {
      final = "(interrompido)";
      break;
    }
    emit({ type: "status", text: `passo ${step}` });
    emit({ type: "progress", step });

    let res;
    try {
      res = await callModel(messages);
    } catch (e) {
      if (e instanceof ModelError && !visionDropped && hasImages(messages)) {
        visionDropped = true;
        emit({ type: "status", text: "provedor recusou imagem: seguindo sem visao" });
        try {
          res = await chat({
            protocol: profile.protocol, baseUrl: profile.baseUrl, key: profile.key, model: profile.model,
            messages: compactHistory(stripImages(messages)), tools: tools.schemas,
            temperature: Number(config.temperature) || 0.25, signal,
            onDelta: (d) => emit({ type: "delta", text: d }),
            onReasoning: (d) => emit({ type: "reasoning", text: d }),
          });
        } catch (e2) {
          emit({ type: "error", text: `${e2.message} :: ${clip(e2.detail || "", 300)}` });
          return { final: null, history: messages, tabId: ctx.tabId };
        }
      } else if (e instanceof ModelError) {
        emit({ type: "error", text: `${e.message} :: ${clip(e.detail || "", 300)}` });
        return { final: null, history: messages, tabId: ctx.tabId };
      } else {
        emit({ type: "error", text: String(e?.message || e) });
        return { final: null, history: messages, tabId: ctx.tabId };
      }
    }

    const msg = res.message;
    if (res.reasoning) emit({ type: "reasoning-end" });
    messages.push(msg);
    emit({ type: "usage", usage: res.usage });
    if (ctx.acc && typeof ctx.acc === "function") ctx.acc(res);

    const calls = msg.tool_calls || [];
    if (!calls.length) {
      final = msg.content || "";
      break;
    }

    for (const call of calls) {
      const name = call.function?.name || "";
      const args = parseArgs(call.function?.arguments);
      emit({ type: "step", tool: name, args });

      const sig = name + " " + JSON.stringify(args || {});
      const n = (seen.get(sig) || 0) + 1;
      seen.set(sig, n);

      let out;
      try {
        out = await tools.execute(name, args, ctx);
      } catch (e) {
        out = { text: `erro em ${name}: ${e?.message || e}`, ok: false };
      }
      if (out.ok === false) lastFail = out.text || `falha em ${name}`;
      if (out.plan) emit({ type: "plan", plan: out.plan });
      emit({ type: "step-result", tool: name, ok: out.ok !== false, text: clip(out.text || "", 400) });

      let body = out.text || "";
      if (out.obs && !String(body).includes(out.obs.slice(0, 40))) body += out.obs;
      if (out.ok === false) {
        body += "\n[reflexao exigida] em uma linha: o que falhou. Depois mude o alvo ou o metodo — nao repita a mesma chamada.";
      }

      messages.push({ role: "tool", tool_call_id: call.id || name, content: clip(body, MAX_TOOL_CHARS) });

      if (out.image && profile.vision) {
        messages.push({
          role: "user",
          content: [
            { type: "text", text: "screenshot da aba neste instante" },
            { type: "image_url", image_url: { url: out.image } },
          ],
        });
      }
      if (n === 3) {
        messages.push({
          role: "user",
          content: `[harness] a chamada ${name} com estes mesmos argumentos ja rodou 3x. Mude de abordagem: outro ref, find(), wait(), ou conclua.`,
        });
      }
      if (n >= 6) {
        messages.push({
          role: "user",
          content: `[harness] ${name} repetiu 6x sem resultado novo. Leia o estado atual e conclua com done().`,
        });
      }
      if (n >= 9) {
        messages.push({
          role: "user",
          content: `[harness] nona repeticao identica de ${name}. Nao ha progresso: chame done() agora com o que ja foi obtido e o que faltou.`,
        });
      }
      if (n >= 12) {
        stuck = `${name} repetida ${n}x com os mesmos argumentos`;
        break;
      }
      if (out.done) {
        final = out.text;
        break;
      }
    }
    if (final !== null) break;
    if (stuck) break;
    // tarefa longa sem plano: uma cutucada so, no fim do primeiro passo. Custa uma
    // chamada e deixa o cartao de plano confiavel ate em effort low.
    if (!ctx.plan && step === 1) {
      messages.push({ role: "user", content: "[harness] registre o plano agora, na MESMA resposta da proxima acao: dois tool calls no mesmo turno (plan + a acao). Nao gaste um passo so com o plano." });
    }
  }
  if (final === null && stuck) {
    final = `(travado: ${stuck}${lastFail ? "; ultima falha: " + clip(lastFail, 160) : ""})`;
  }

  if (final !== null) emit({ type: "final", text: final });
  return { final, history: messages, tabId: ctx.tabId };
}
