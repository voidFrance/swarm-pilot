// Superficie de ferramentas. Regra de ouro: toda acao que muda o DOM devolve
// junto um snapshot compacto (delta), para o modelo reconhecer o resultado sem
// gastar um passo em page_state. Observacao e gratis.

import * as cdp from "./cdp.js";
import * as page from "./page.js";
import { chat } from "./model.js";
import { resolveProfile } from "./providers.js";

const lastSnap = new Map();
const lastProbe = new Map();

// Estado barato de comparacao, sempre na mesma forma: contador de mutacoes,
// url, foco e viewport. Sem tocar na arvore.
const fromSnap = (s) => ({ dom: s.dom, href: s.url, focus: s.focus?.ref || "", scroll: s.scroll.y, w: s.viewport.w, h: s.viewport.h });
const fromProbe = (p) => ({ dom: p.dom, href: p.href, focus: p.focus || "", scroll: p.scroll, w: p.w, h: p.h });
const sameState = (a, b) =>
  !!a && !!b && a.dom === b.dom && a.href === b.href && a.focus === b.focus &&
  a.scroll === b.scroll && a.w === b.w && a.h === b.h;

const clip = (s, n) => {
  const t = typeof s === "string" ? s : JSON.stringify(s);
  return t.length > n ? t.slice(0, n) + ` ... [${t.length - n} cortados]` : t;
};

const byRef = (s) => {
  const m = new Map();
  for (const it of s.interactive || []) m.set(it.ref, it);
  return m;
};

const fmtItem = (it) => {
  const bits = [it.ref ? `[${it.ref}]` : "", it.role || it.tag];
  if (it.name) bits.push(JSON.stringify(clip(it.name, 70)));
  if (it.value) bits.push("value=" + JSON.stringify(clip(it.value, 28)));
  if (it.checked === true) bits.push("checked");
  if (it.checked === false && (it.role === "checkbox" || it.role === "switch")) bits.push("unchecked");
  if (it.disabled) bits.push("disabled");
  if (it.required) bits.push("required");
  if (it.invalid) bits.push("invalid");
  if (it.expanded === true) bits.push("expanded");
  if (it.focused) bits.push("FOCUS");
  if (it.href && !it.name) bits.push(clip(it.href, 70));
  if (it.inView === false) bits.push("fora-da-viewport");
  if (it.occluded) bits.push("occludido por " + JSON.stringify(clip(it.onTop || "?", 40)) + (it.clickable ? " (clicavel fora do centro)" : " (feche esse overlay primeiro)"));
  return "  " + bits.join(" ") + ` @${it.rect.x},${it.rect.y} ${it.rect.w}x${it.rect.h}`;
};

const deltaLine = (s) => {
  const d = s.delta || {};
  if (d.first) return "";
  const m = byRef(s);
  const who = (ref, fallback) => {
    const it = m.get(ref);
    if (it) return `${ref} ${it.role} ${JSON.stringify(clip(it.name || "", 40))}`;
    if (fallback) {
      const p = String(fallback).split("|");
      return `${ref} ${p[0]} ${JSON.stringify(clip(p[1] || "", 40))} (sumiu)`;
    }
    return ref;
  };
  const parts = [];
  if (d.added?.length) parts.push("+" + d.added.slice(0, 12).map((r) => who(r)).join(", "));
  if (d.changed?.length) parts.push("~" + d.changed.slice(0, 12).map((r) => who(r)).join(", "));
  if (d.removed?.length) parts.push("-" + d.removed.slice(0, 12).map((x) => who(x.ref, x.was)).join(", "));
  if (!parts.length) return "  (nada mudou desde o ultimo snapshot)";
  return "  " + parts.join(" | ");
};

export function formatSnapshot(s, opts = {}) {
  const compact = !!opts.compact;
  const L = [];
  L.push(`url: ${s.url}`);
  L.push(`title: ${clip(s.title || "", 120)}`);
  const load = s.ready
    ? "pronta"
    : `CARREGANDO (readyState=${s.readyState}${s.busy ? ", aria-busy" : ""}${s.loadingish ? ", texto de loading" : ""})`;
  L.push(`pagina: ${load}`);
  L.push(`viewport: ${s.viewport.w}x${s.viewport.h} | scroll y=${s.scroll.y} de ${s.scroll.docH}`);
  if (s.focus) L.push(`foco: [${s.focus.ref}] ${s.focus.role} ${JSON.stringify(clip(s.focus.name, 60))}${s.focus.value ? " value=" + JSON.stringify(clip(s.focus.value, 30)) : ""}`);
  if (s.dialogs?.length) L.push("diálogos abertos: " + s.dialogs.map((d) => JSON.stringify(clip(d, 60))).join(", "));
  if (s.alerts?.length) L.push("alertas: " + s.alerts.map((a) => JSON.stringify(clip(a, 90))).join(", "));
  const d = deltaLine(s);
  if (d) L.push("mudou:" + d.trimStart().replace(/^/, " "));

  const items = s.interactive || [];
  const inView = items.filter((it) => it.inView !== false);
  const off = items.filter((it) => it.inView === false);
  L.push(`elementos na viewport (${inView.length}) — use a ref em click/type:`);
  for (const it of inView.slice(0, compact ? 60 : 110)) L.push(fmtItem(it));
  if (off.length) {
    L.push(`fora da viewport (${off.length}): ` + off.slice(0, 40).map((it) => `${it.ref} ${it.role} ${JSON.stringify(clip(it.name, 30))}`).join(" | "));
  }
  if (s.headings?.length) L.push("headings:\n  " + s.headings.slice(0, compact ? 8 : 20).join("\n  "));
  L.push("texto visivel:");
  L.push(clip(s.text, compact ? 700 : 1800));
  if (s.textLen > (compact ? 700 : 1800)) L.push(`(texto total ${s.textLen} chars; use read(selector) para extrair uma regiao)`);
  if (s.truncated) L.push("lista truncada: use find(role/name/text) para o resto");
  if (s.frames?.length) L.push(`frames: ${s.frames.map((f) => clip(f.url, 60)).join(" | ")}`);
  if (!s.ready) L.push(">>> a pagina ainda esta carregando: wait antes de agir.");
  return L.join("\n");
}

async function snapshot(tabId, opts = {}) {
  const s = await cdp.evaluate(tabId, page.snapshotExpr(opts));
  if (!s) throw new Error("snapshot vazio: a pagina nao avaliou (aba descartada? frame trocado?)");
  lastSnap.set(tabId, s);
  lastProbe.set(tabId, fromSnap(s));
  return s;
}

async function probe(tabId) {
  const p = await cdp.evaluate(tabId, page.probeExpr(), { userGesture: false });
  if (p && p.dom !== undefined) lastProbe.set(tabId, fromProbe(p));
  return p;
}

// Observacao automatica: sonda primeiro. DOM intacto, mesma url, mesmo foco,
// mesma viewport = nada a reescanear (1 eval em vez de snapshot inteiro).
async function observe(tabId, note) {
  const head = `\n--- observacao automatica${note ? " (" + note + ")" : ""} ---`;
  try {
    const before = lastProbe.get(tabId);
    const p = await probe(tabId);
    const same = sameState(before, lastProbe.get(tabId)) && p?.ready === "complete";
    if (same) return head + "\n  (nada mudou: DOM, foco e viewport identicos; nao reescaneei)";
    const s = await snapshot(tabId, { max: 220 });
    return head + "\n" + clip(formatSnapshot(s, { compact: true }), 2000);
  } catch (e) {
    return head + `\n  (sonda falhou: ${e?.message || e})`;
  }
}

export const schemas = [
  {
    type: "function",
    function: {
      name: "plan",
      description: "Registra o plano antes de agir: 2 a 6 passos curtos e o porquê. Chame uma vez no inicio de tarefa nao trivial, e de novo quando o estado mudar muito. Use mark para marcar um passo como feito.",
      parameters: {
        type: "object",
        properties: {
          steps: { type: "array", items: { type: "string" }, description: "passos, do proximo ao ultimo" },
          why: { type: "string", description: "uma frase: por que este plano" },
          mark: { type: "integer", description: "indice (1-based) do passo concluido" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ask_agent",
      description: "Consulta outro modelo configurado (qualquer endpoint OpenAI-compat ou Anthropic) e devolve a resposta. Use quando precisar de um segundo julgamento, de um modelo mais forte para planejar, ou de conhecimento que voce nao tem. Nao executa acao no browser.",
      parameters: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "a pergunta, com todo o contexto necessario" },
          profile: { type: "string", description: "id do perfil (nodecode, openai, anthropic, deepseek, ollama, custom...). Vazio = perfil advisor configurado." },
          with_page: { type: "boolean", description: "anexa o page_state atual (url, elementos, texto) ao prompt" },
        },
        required: ["prompt"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "page_state",
      description: "Snapshot reconhecido da aba: url, titulo, estado de carregamento, foco, dialogos, alertas, delta desde o ultimo snapshot, e TODOS os elementos interativos com REF estavel (ex: e42), papel, nome acessivel, valor, estado e coordenadas. Chame uma vez no inicio; depois de cada acao o resultado ja vem com a observacao automatica.",
      parameters: {
        type: "object",
        properties: {
          image: { type: "boolean", description: "anexa screenshot da aba (o modelo precisa de visao)" },
          max: { type: "integer", description: "maximo de elementos, padrao 160" },
          full_text: { type: "boolean", description: "inclui o texto inteiro da pagina; fora do primeiro snapshot vem so um resumo" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "find",
      description: "Busca elementos por papel/nome/texto e devolve as refs. Use quando a lista do page_state vier truncada ou quando souber o papel (button, link, textbox, checkbox...).",
      parameters: {
        type: "object",
        properties: {
          role: { type: "string", description: "papel a11y exato: button, link, textbox, checkbox, combobox, tab, menuitem" },
          name: { type: "string", description: "trecho do nome acessivel (case-insensitive)" },
          text: { type: "string", description: "trecho do texto do elemento" },
          max: { type: "integer", description: "padrao 20" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read",
      description: "Extrai o conteudo de uma regiao como texto estruturado (headings, paragrafos, listas, tabelas em markdown, valores de input, opcoes de select). Para ler dados, nao para despejar document.body.",
      parameters: {
        type: "object",
        properties: {
          selector: { type: "string", description: "escopo CSS, padrao body" },
          max: { type: "integer", description: "caracteres maximos, padrao 8000" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "click",
      description: "Clique real na tela (CDP Input.dispatchMouseEvent), precedido do ponteiro neon voando ate o alvo. Aponte por ref (preferido), index, text ou selector. O resultado traz o delta do DOM.",
      parameters: {
        type: "object",
        properties: {
          ref: { type: "string", description: "ref do ultimo page_state, ex: e42 (estavel entre snapshots)" },
          index: { type: "integer", description: "indice na lista do ultimo snapshot (efemero, prefira ref)" },
          text: { type: "string", description: "texto visivel do elemento" },
          selector: { type: "string", description: "seletor CSS" },
          button: { type: "string", enum: ["left", "right"], description: "padrao left" },
          settle_ms: { type: "integer", description: "espera apos o clique, padrao 350" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "type",
      description: "Clica no campo e digita (Input.insertText, o caminho de um teclado real). Aponte por ref, text_match ou selector; sem alvo, usa o elemento focado.",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "texto a digitar" },
          ref: { type: "string", description: "ref do campo" },
          text_match: { type: "string", description: "nome/texto do campo, se nao usar ref" },
          selector: { type: "string", description: "seletor CSS do campo" },
          clear: { type: "boolean", description: "seleciona tudo antes (substitui o conteudo)" },
          submit: { type: "boolean", description: "Enter no fim" },
        },
        required: ["text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "key",
      description: "Tecla ou combinacao no focado: Enter, Escape, Tab, ArrowDown, Control+a, Shift+Tab, Control+Enter.",
      parameters: {
        type: "object",
        properties: { combo: { type: "string" } },
        required: ["combo"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "scroll",
      description: "Roda do mouse na pagina (delta em pixels). Positivo desce.",
      parameters: {
        type: "object",
        properties: {
          dy: { type: "integer", description: "delta vertical, padrao 600" },
          dx: { type: "integer", description: "delta horizontal" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "navigate",
      description: "Navega a aba para uma URL e espera o load.",
      parameters: {
        type: "object",
        properties: { url: { type: "string" } },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "wait",
      description: "Espera uma condicao: loaded (pagina pronta), selector, gone (elemento sumiu), text, url, ou milissegundos fixos (ms).",
      parameters: {
        type: "object",
        properties: {
          mode: { type: "string", enum: ["loaded", "selector", "gone", "text", "url", "ms"], description: "padrao loaded" },
          value: { type: "string", description: "selector, texto ou trecho de url" },
          ms: { type: "integer", description: "espera fixa" },
          timeout_ms: { type: "integer", description: "teto, padrao 15000" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "evaluate",
      description: "Executa JavaScript no contexto da pagina e devolve o valor. Escotilha para dados que o DOM nao expoe; nao substitui page_state.",
      parameters: {
        type: "object",
        properties: { expression: { type: "string" } },
        required: ["expression"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fetch_url",
      description: "GET/POST de dentro da pagina, com os cookies e a sessao do usuario. Para ler dados que o DOM nao mostra.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string" },
          method: { type: "string", description: "GET ou POST" },
          body: { type: "string", description: "corpo cru, normalmente JSON" },
          content_type: { type: "string", description: "Content-Type" },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "screenshot",
      description: "Captura a aba como imagem. Devolve data URL quando o modelo aceita visao.",
      parameters: {
        type: "object",
        properties: { full_page: { type: "boolean" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "tabs",
      description: "Lista abas, troca a aba alvo, abre ou fecha aba.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["list", "switch", "new", "close"] },
          tab_id: { type: "integer" },
          url: { type: "string" },
        },
        required: ["action"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "done",
      description: "Encerra a tarefa e entrega a resposta final ao usuario.",
      parameters: {
        type: "object",
        properties: { summary: { type: "string" } },
        required: ["summary"],
      },
    },
  },
];

const KEYMAP = {
  Enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  Tab: { key: "Tab", code: "Tab", keyCode: 9 },
  Escape: { key: "Escape", code: "Escape", keyCode: 27 },
  Backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  Delete: { key: "Delete", code: "Delete", keyCode: 46 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  Home: { key: "Home", code: "Home", keyCode: 36 },
  End: { key: "End", code: "End", keyCode: 35 },
  PageUp: { key: "PageUp", code: "PageUp", keyCode: 33 },
  PageDown: { key: "PageDown", code: "PageDown", keyCode: 34 },
  " ": { key: " ", code: "Space", keyCode: 32, text: " " },
};

const MODIFIERS = [
  ["Control", 2],
  ["Alt", 1],
  ["Shift", 8],
  ["Meta", 4],
];

function parseCombo(combo) {
  const parts = String(combo).split("+").map((s) => s.trim()).filter(Boolean);
  let modifiers = 0;
  let base = null;
  for (const p of parts) {
    const mod = MODIFIERS.find(([name]) => name.toLowerCase() === p.toLowerCase());
    if (mod) modifiers |= mod[1];
    else base = p;
  }
  return { modifiers, base: base || "" };
}

async function pressCombo(tabId, combo) {
  const { modifiers, base } = parseCombo(combo);
  const special = KEYMAP[base];
  const key = special ? special.key : base;
  const code = special ? special.code : /^[a-z]$/i.test(base) ? "Key" + base.toUpperCase() : /^[0-9]$/.test(base) ? "Digit" + base : base;
  const keyCode = special ? special.keyCode : /^[a-z0-9]$/i.test(base) ? base.toUpperCase().charCodeAt(0) : 0;
  const baseParams = { modifiers, key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode };
  await cdp.send(tabId, "Input.dispatchKeyEvent", { type: "rawKeyDown", ...baseParams });
  if (special?.text && !modifiers) {
    await cdp.send(tabId, "Input.dispatchKeyEvent", { type: "char", text: special.text, unmodifiedText: special.text, ...baseParams });
  }
  await cdp.send(tabId, "Input.dispatchKeyEvent", { type: "keyUp", ...baseParams });
}

const renderPlan = (plan) =>
  plan.steps.map((s, i) => `  ${plan.done.includes(i + 1) ? "[x]" : "[ ]"} ${i + 1}. ${s}`).join("\n");

const wantsImage = (args, ctx) => {
  if (args.image === false) return false;
  if (args.image === true) return true;
  return ctx?.config?.vision !== false;
};

async function withImage(out, tabId, ctx, args) {
  if (!wantsImage(args || {}, ctx)) return out;
  try {
    const shot = await cdp.send(tabId, "Page.captureScreenshot", { format: "png" });
    out.image = "data:image/png;base64," + shot.data;
    ctx?.emit?.({ type: "screenshot", dataUrl: out.image });
  } catch (e) {}
  return out;
}

export async function execute(name, args, ctx) {
  const tabId = ctx.tabId;
  args = args || {};
  switch (name) {
    case "plan": {
      const steps = (Array.isArray(args.steps) ? args.steps : []).map((s) => String(s).slice(0, 160)).slice(0, 8);
      if (steps.length) ctx.plan = { steps, why: String(args.why || "").slice(0, 200), done: [] };
      if (!ctx.plan) return { text: "sem plano ativo: chame plan com steps", ok: false };
      if (Number.isInteger(args.mark) && !ctx.plan.done.includes(args.mark)) ctx.plan.done.push(args.mark);
      const head = `plano (${ctx.plan.done.length}/${ctx.plan.steps.length} feitos)${ctx.plan.why ? " :: " + ctx.plan.why : ""}`;
      return { text: head + "\n" + renderPlan(ctx.plan), ok: true, plan: { ...ctx.plan } };
    }
    case "ask_agent": {
      const p = args.profile ? resolveProfile(ctx.config, args.profile) : ctx.advisor || resolveProfile(ctx.config, "advisor");
      if (!p || !p.baseUrl || !p.key) return { text: "perfil sem baseUrl/key: configure em Opcoes", ok: false };
      let prompt = String(args.prompt || "");
      if (args.with_page !== false) {
        try {
          const s = await snapshot(tabId, { max: 60 });
          prompt += "\n\n--- estado da pagina ---\n" + clip(formatSnapshot(s, { compact: true }), 2500);
        } catch (e) {}
      }
      try {
        const r = await chat({
          protocol: p.protocol, baseUrl: p.baseUrl, key: p.key, model: p.model,
          messages: [{ role: "user", content: prompt }], temperature: 0.3, maxTokens: 900,
        });
        return { text: `[${p.id} / ${p.model}]\n` + (r.message.content || "(sem texto)"), ok: true };
      } catch (e) {
        return { text: `ask_agent falhou (${p.id}): ${e?.message || e} ${clip(e?.detail || "", 200)}`, ok: false };
      }
    }
    case "page_state": {
      const s = await snapshot(tabId, { max: args.max, fullText: args.full_text === true });
      const out = { text: formatSnapshot(s), ok: true };
      return withImage(out, tabId, ctx, args);
    }
    case "find": {
      const r = await cdp.evaluate(tabId, page.findExpr(args));
      if (!r?.count) return { text: "nenhum elemento com esse filtro", ok: false, obs: await observe(tabId, "apos find vazio") };
      const lines = r.items.map((it) => `  [${it.ref}] ${it.role} ${JSON.stringify(clip(it.name, 60))} @${it.rect.x},${it.rect.y}${it.inView ? "" : " fora-da-viewport"}`);
      return { text: `${r.count} elemento(s):\n` + lines.join("\n"), ok: true };
    }
    case "read": {
      const r = await cdp.evaluate(tabId, page.readExpr(args));
      if (!r?.ok) return { text: `falhou: ${r?.reason || "escopo invalido"}`, ok: false };
      return { text: r.text || "(regiao sem texto)", ok: true };
    }
    case "click": {
      const r = await cdp.evaluate(tabId, page.resolveExpr(args));
      if (!r?.ok) {
        return {
          text: `falhou: ${r?.reason || "alvo nao resolvido"}\n` + (r?.candidates ? "candidatos:\n" + r.candidates.join("\n") : ""),
          ok: false,
        };
      }
      await ctx.swarm(r.x, r.y, r.name || r.role);
      await cdp.mouseClick(tabId, r.x, r.y, { button: args.button || "left" });
      const settle = Number.isInteger(args.settle_ms) ? args.settle_ms : 350;
      if (settle > 0) await new Promise((res) => setTimeout(res, settle));
      return { text: `clique real em ${r.role} "${r.name}" (${r.how}) @${r.x},${r.y}` + (await observe(tabId, "apos o clique")), ok: true };
    }
    case "type": {
      let target = null;
      if (args.ref || Number.isInteger(args.index) || args.text_match) {
        const r = await cdp.evaluate(tabId, page.resolveExpr({ ref: args.ref, index: args.index, text: args.text_match }));
        if (!r?.ok) return { text: `campo nao resolvido: ${r?.reason || ""}`, ok: false };
        target = r;
        await ctx.swarm(r.x, r.y, r.name || "campo");
        await cdp.mouseClick(tabId, r.x, r.y);
        await new Promise((res) => setTimeout(res, 120));
      } else if (args.selector) {
        const r = await cdp.evaluate(tabId, page.focusExpr(args.selector));
        if (!r?.ok) return { text: `campo nao encontrado: ${args.selector}`, ok: false };
        target = { name: args.selector, ref: r.ref };
      }
      const mod = /mac/i.test(navigator.platform || "") ? "Meta" : "Control";
      if (args.clear) await pressCombo(tabId, mod + "+a");
      await cdp.send(tabId, "Input.insertText", { text: String(args.text) });
      if (args.submit) await pressCombo(tabId, "Enter");
      const f = await cdp.evaluate(
        tabId,
        "(() => { const a = document.activeElement; if (!a || a === document.body) return null; return { role: a.getAttribute('role') || a.tagName.toLowerCase(), name: String(a.getAttribute('aria-label') || a.name || a.id || '').slice(0, 60), value: String(a.value != null ? a.value : '').slice(0, 60) }; })()",
        { userGesture: false },
      );
      return {
        text: `digitado ${JSON.stringify(String(args.text).slice(0, 60))} em ${JSON.stringify(target?.name || "focado")}; foco agora: ${JSON.stringify(f)}` + (await observe(tabId, args.submit ? "apos digitar e Enter" : "apos digitar")),
        ok: true,
      };
    }
    case "key": {
      await pressCombo(tabId, args.combo);
      await new Promise((res) => setTimeout(res, 260));
      return { text: `tecla ${args.combo} enviada` + (await observe(tabId, "apos tecla")), ok: true };
    }
    case "scroll": {
      const vp = await cdp.evaluate(tabId, "({ w: innerWidth, h: innerHeight })", { userGesture: false });
      await cdp.wheel(tabId, Math.round(vp.w / 2), Math.round(vp.h / 2), Number(args.dy) || 600, Number(args.dx) || 0);
      await new Promise((res) => setTimeout(res, 260));
      return { text: `scroll aplicado` + (await observe(tabId, "apos scroll")), ok: true };
    }
    case "navigate": {
      await cdp.send(tabId, "Page.navigate", { url: args.url });
      const ok = await cdp.waitForLoad(tabId, 20000);
      const s = await snapshot(tabId);
      return { text: `navegou para ${s.url} (load ${ok ? "completo" : "timeout"})` + "\n" + formatSnapshot(s, { compact: true }), ok: true };
    }
    case "wait": {
      const mode = args.mode || (args.selector ? "selector" : args.ms ? "ms" : "loaded");
      if (mode === "ms") {
        await new Promise((r) => setTimeout(r, Math.min(30000, Number(args.ms) || 500)));
        return { text: `esperou ${Number(args.ms) || 500}ms`, ok: true, obs: await observe(tabId, "apos espera") };
      }
      const deadline = Date.now() + Math.min(60000, Number(args.timeout_ms) || 15000);
      let last = null;
      while (Date.now() < deadline) {
        try {
          last = await cdp.evaluate(tabId, page.waitExpr({ mode, value: args.value }), { userGesture: false });
        } catch (e) {
          if (!/Cannot access|No tab|not attached/i.test(String(e?.message || e))) throw e;
        }
        if (last?.ok) return { text: `${mode} satisfeito` + (await observe(tabId, "apos wait")), ok: true };
        await new Promise((r) => setTimeout(r, 180));
      }
      return { text: `timeout esperando ${mode} ${args.value ? JSON.stringify(args.value) : ""}; ultimo estado: ${JSON.stringify(last)}`, ok: false, obs: await observe(tabId, "apos timeout") };
    }
    case "evaluate": {
      const v = await cdp.evaluate(tabId, args.expression);
      return { text: clip(v, 4000), ok: true };
    }
    case "fetch_url": {
      const expr = `(async () => {
        const r = await fetch(${JSON.stringify(args.url)}, {
          method: ${JSON.stringify(args.method || "GET")},
          credentials: "include",
          headers: ${JSON.stringify(args.content_type ? { "Content-Type": args.content_type } : {})},
          body: ${args.body ? JSON.stringify(args.body) : "undefined"}
        });
        const t = await r.text();
        return { status: r.status, type: r.headers.get("content-type"), body: t.slice(0, 6000) };
      })()`;
      const v = await cdp.evaluate(tabId, expr);
      return { text: clip(v, 4000), ok: true };
    }
    case "screenshot": {
      const params = { format: "png" };
      if (args.full_page) params.captureBeyondViewport = true;
      const shot = await cdp.send(tabId, "Page.captureScreenshot", params);
      const dataUrl = "data:image/png;base64," + shot.data;
      ctx.emit?.({ type: "screenshot", dataUrl });
      return { text: `screenshot capturado (${Math.round(shot.data.length / 1024)} KB base64)`, ok: true, image: dataUrl };
    }
    case "tabs": {
      if (args.action === "list") {
        const tabs = await chrome.tabs.query({});
        return {
          text: tabs.map((t) => `${t.id}\t${t.active ? "*" : " "}\t${t.title} | ${t.url}`).slice(0, 40).join("\n"),
          ok: true,
        };
      }
      if (args.action === "switch" && Number.isInteger(args.tab_id)) {
        await chrome.tabs.update(args.tab_id, { active: true });
        ctx.tabId = args.tab_id;
        return { text: `aba alvo agora e ${args.tab_id}`, ok: true };
      }
      if (args.action === "new") {
        const t = await chrome.tabs.create({ url: args.url || "about:blank", active: true });
        ctx.tabId = t.id;
        return { text: `aba aberta id=${t.id}`, ok: true };
      }
      if (args.action === "close" && Number.isInteger(args.tab_id)) {
        await chrome.tabs.remove(args.tab_id);
        return { text: `aba ${args.tab_id} fechada`, ok: true };
      }
      return { text: "acao de tabs invalida", ok: false };
    }
    case "done":
      return { text: String(args.summary || "concluido"), ok: true, done: true };
    default:
      return { text: `ferramenta desconhecida: ${name}`, ok: false };
  }
}

export async function detachAll() {
  for (const id of [...lastSnap.keys()]) await cdp.detach(id);
  lastSnap.clear();
}
