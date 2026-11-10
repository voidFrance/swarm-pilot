// Expressoes avaliadas no contexto da pagina (Runtime.evaluate).
// Grounding por REF estavel (data-sp-ref): a mesma ref aponta para o mesmo no
// entre snapshots, mesmo que a ordem do DOM ou o layout mudem. Indice e efemero.
// O preludio vive na pagina e carrega o contador, o mapa WeakMap no->ref, o
// snapshot anterior (para delta) e os helpers de visibilidade, nome e papel.

export const PRELUDE = String.raw`
const SP = (window.__sp = window.__sp || { n: 0, prev: null, map: new WeakMap(), dom: 0, mo: null });
const HOST_SEL = '#__swarm_pilot__';

// Contador de mutacoes: deixa o host saber, em ~1 eval, se vale a pena reescanear
// a pagina depois de uma acao. Sem isso, toda acao pagava um snapshot inteiro.
if (!SP.mo && window.MutationObserver) {
  SP.mo = new MutationObserver((recs) => { SP.dom += recs.length || 1; });
  try {
    SP.mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
  } catch (e) {}
}

function _ref(el) {
  let r = SP.map.get(el);
  if (!r) { r = 'e' + (++SP.n); SP.map.set(el, r); try { el.setAttribute('data-sp-ref', r); } catch (e) {} }
  return r;
}

function _box(el) { return el.getBoundingClientRect(); }

function _shown(el) {
  if (el.closest(HOST_SEL)) return false;
  const r = el.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) return false;
  const s = getComputedStyle(el);
  if (s.visibility === 'hidden' || s.display === 'none') return false;
  if (Number(s.opacity || 1) < 0.06) return false;
  return true;
}

function _txt(el) { return String(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim(); }
function _attr(el, k) { const v = el.getAttribute && el.getAttribute(k); return v == null ? '' : String(v); }

function _name(el) {
  const by = _attr(el, 'aria-labelledby');
  if (by) {
    const t = by.split(/\s+/).map((id) => { const n = document.getElementById(id); return n ? _txt(n) : ''; }).join(' ').replace(/\s+/g, ' ').trim();
    if (t) return t.slice(0, 120);
  }
  const lab = _attr(el, 'aria-label').trim();
  if (lab) return lab.slice(0, 120);
  if (el.labels && el.labels.length) {
    const t = Array.from(el.labels).map(_txt).join(' ').replace(/\s+/g, ' ').trim();
    if (t) return t.slice(0, 120);
  }
  const wrap = el.closest && el.closest('label');
  if (wrap) { const t = _txt(wrap); if (t) return t.slice(0, 120); }
  const alt = (_attr(el, 'alt') || _attr(el, 'title') || _attr(el, 'placeholder')).trim();
  if (alt) return alt.slice(0, 120);
  if (el.tagName === 'SELECT') return (_attr(el, 'name') || el.id || '').slice(0, 120);
  const dense = _txt(el);
  if (dense) return dense.slice(0, 120);
  if (el.tagName === 'INPUT') return String(el.value || '').slice(0, 120);
  return (_attr(el, 'name') || el.id || '').slice(0, 120);
}

function _role(el) {
  const r = _attr(el, 'role').trim();
  if (r) return r.split(/\s+/)[0];
  const t = el.tagName;
  if (t === 'A') return el.hasAttribute('href') ? 'link' : 'generic';
  if (t === 'BUTTON') return 'button';
  if (t === 'SELECT') return el.multiple ? 'listbox' : 'combobox';
  if (t === 'TEXTAREA') return 'textbox';
  if (t === 'SUMMARY') return 'button';
  if (t === 'INPUT') {
    const ty = String(el.type || 'text').toLowerCase();
    if (ty === 'checkbox') return 'checkbox';
    if (ty === 'radio') return 'radio';
    if (ty === 'submit' || ty === 'button' || ty === 'reset' || ty === 'image') return 'button';
    if (ty === 'range') return 'slider';
    if (ty === 'file') return 'file';
    if (ty === 'search') return 'searchbox';
    if (ty === 'hidden') return 'hidden';
    return 'textbox';
  }
  if (el.isContentEditable) return 'textbox';
  return 'generic';
}

function _state(el) {
  const s = {};
  if (el.disabled || _attr(el, 'aria-disabled') === 'true') s.disabled = true;
  if (el.hasAttribute('required') || _attr(el, 'aria-required') === 'true') s.required = true;
  if ('checked' in el && (el.type === 'checkbox' || el.type === 'radio')) s.checked = !!el.checked;
  else if (_attr(el, 'aria-checked')) s.checked = _attr(el, 'aria-checked') === 'true';
  if (_attr(el, 'aria-expanded')) s.expanded = _attr(el, 'aria-expanded') === 'true';
  if (_attr(el, 'aria-selected')) s.selected = _attr(el, 'aria-selected') === 'true';
  if (_attr(el, 'aria-invalid') === 'true') s.invalid = true;
  const isCheck = el.type === 'checkbox' || el.type === 'radio';
  const v = (_attr(el, 'aria-valuenow') || (!isCheck && el.value != null && el.value !== '' ? String(el.value) : '')).slice(0, 120);
  if (v) s.value = v;
  return s;
}

function _hits(limit) {
  const q = 'a,button,input,select,textarea,summary,[role=button],[role=link],[role=tab],' +
    '[role=checkbox],[role=switch],[role=menuitem],[role=menuitemcheckbox],[role=radio],[role=option],' +
    '[role=combobox],[role=textbox],[role=searchbox],[role=slider],[onclick],[contenteditable=true],[tabindex]';
  // getComputedStyle por elemento e o que custa; numa pagina com milhares de
  // nos, parar no teto de visiveis vale muito mais do que varrer tudo.
  const cap = Number(limit) || 240;
  const nodes = document.querySelectorAll(q);
  const out = [];
  for (let i = 0; i < nodes.length && out.length < cap; i++) {
    const el = nodes[i];
    if (el.closest(HOST_SEL)) continue;
    if (_shown(el) && _role(el) !== 'hidden') out.push(el);
  }
  return out;
}

function _fp(it) {
  return [it.role, it.name, it.value || '', it.checked === true ? '1' : '', it.disabled ? 'D' : '',
    it.inView ? 'V' : '', '@' + it.rect.x + ',' + it.rect.y].join('|');
}

function _pointFor(el) {
  const r = el.getBoundingClientRect();
  const fx = [0.5, 0.25, 0.75, 0.1, 0.9];
  const fy = [0.5, 0.25, 0.75, 0.1, 0.9];
  const cands = [[r.x + r.width * 0.5, r.y + r.height * 0.5]];
  for (const a of fy) for (const b of fx) cands.push([r.x + r.width * b, r.y + r.height * a]);
  for (const pair of cands) {
    const x = Math.round(pair[0]), y = Math.round(pair[1]);
    if (x < 1 || y < 1 || x > innerWidth - 1 || y > innerHeight - 1) continue;
    const hit = document.elementFromPoint(x, y);
    if (hit && (hit === el || el.contains(hit) || hit.contains(el))) return { x, y };
  }
  return null;
}
`;

export const snapshotExpr = (opts = {}) => String.raw`(() => { ${PRELUDE}
  const maxN = ${Number(opts.max) || 160};
  const all = _hits(maxN + 40);
  const items = [];
  for (let i = 0; i < all.length && items.length < maxN; i++) {
    const el = all[i];
    const r = _box(el);
    const st = _state(el);
    const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
    const inView = cx > 0 && cy > 0 && cx < innerWidth && cy < innerHeight;
    let occluded = false, onTop = '';
    if (inView) {
      const hit = document.elementFromPoint(Math.round(cx), Math.round(cy));
      if (hit && hit !== el && !el.contains(hit) && !hit.closest(HOST_SEL)) {
        occluded = true;
        onTop = (_role(hit) + ' "' + _name(hit) + '"').slice(0, 60);
      }
    }
    let clickable = true;
    if (occluded) clickable = !!_pointFor(el);
    const it = {
      ref: _ref(el), i: items.length, role: _role(el), tag: el.tagName.toLowerCase(),
      name: _name(el), href: el.tagName === 'A' ? String(el.href || _attr(el, 'href')).slice(0, 140) : '',
      type: _attr(el, 'type'), placeholder: _attr(el, 'placeholder'),
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      inView, occluded, onTop, clickable,
    };
    for (const k in st) it[k] = st[k];
    it.focused = document.activeElement === el;
    items.push(it);
  }

  const cur = {};
  for (const it of items) cur[it.ref] = _fp(it);
  const prev = SP.prev || {};
  const added = [], changed = [], removed = [];
  for (const k in cur) {
    if (!(k in prev)) added.push(k);
    else if (prev[k] !== cur[k]) changed.push(k);
  }
  for (const k in prev) if (!(k in cur)) removed.push({ ref: k, was: prev[k] });
  const isFirst = SP.prev === null;
  SP.prev = cur;

  const heads = [...document.querySelectorAll('h1,h2,h3,[role=heading]')].filter(_shown).slice(0, 20)
    .map((h) => h.tagName.toLowerCase() + ': ' + _txt(h).slice(0, 100));
  const rawText = String(document.body ? document.body.innerText : '')
    .replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
  // texto inteiro so quando e o primeiro snapshot ou quando pedem: serializar
  // 4 kB de body a cada acao e o maior custo fixo do loop.
  const wantFull = ${opts.fullText ? "true" : "false"} || SP.prev === null;
  const text = wantFull ? rawText.slice(0, 4000) : rawText.slice(0, 700);

  const busySel = '[aria-busy="true"]';
  const busy = !!document.querySelector(busySel);
  const bodyHead = text.slice(0, 220);
  const loadingish = /(^|\n)\s*(carregando|loading|aguarde|please wait|processando|verificando)\b/i.test(bodyHead);
  const ready = document.readyState === 'complete' && !busy && !(loadingish && items.length < 4);

  const dialogs = [...document.querySelectorAll('[role=dialog],[role=alertdialog]')].filter(_shown)
    .slice(0, 4).map((d) => _name(d).slice(0, 100));
  const alerts = [...document.querySelectorAll('[role=alert],[aria-live=assertive],[aria-live=polite]')].filter(_shown)
    .slice(0, 4).map((a) => _txt(a).slice(0, 120)).filter(Boolean);
  const focusEl = document.activeElement && document.activeElement !== document.body ? document.activeElement : null;
  const focus = focusEl ? {
    ref: _ref(focusEl), role: _role(focusEl), name: _name(focusEl).slice(0, 80),
    value: String(focusEl.value != null ? focusEl.value : '').slice(0, 80),
  } : null;
  const frames = [...document.querySelectorAll('iframe')].slice(0, 12)
    .map((f) => ({ url: String(f.src || '').slice(0, 90), w: Math.round(f.getBoundingClientRect().width) }));

  return {
    url: location.href, title: document.title,
    viewport: { w: innerWidth, h: innerHeight },
    scroll: { x: Math.round(scrollX), y: Math.round(scrollY), docH: document.documentElement.scrollHeight },
    ready, readyState: document.readyState, busy, loadingish,
    interactive: items, headings: heads,
    text, textLen: rawText.length, dom: SP.dom,
    truncated: items.length >= maxN,
    delta: { first: isFirst, added, changed, removed },
    dialogs, alerts, focus, frames,
  };
})()`;

// Sonda de ~1 eval: diz se algo mudou sem reescanear a pagina.
export const probeExpr = () => String.raw`(() => { ${PRELUDE}
  const f = document.activeElement;
  return {
    dom: SP.dom, href: location.href, title: document.title, ready: document.readyState,
    focus: f && f !== document.body ? _ref(f) : '',
    scroll: Math.round(scrollY), w: innerWidth, h: innerHeight,
  };
})()`;

export const resolveExpr = (args) => String.raw`(() => { ${PRELUDE}
  const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const ref = ${JSON.stringify(args.ref || "")};
  const sel = ${JSON.stringify(args.selector || "")};
  const txt = ${JSON.stringify(args.text || "")};
  const idx = ${Number.isInteger(args.index) ? String(args.index) : "null"};
  const hits = _hits();
  let el = null, how = '';
  if (ref) {
    el = hits.find((h) => _ref(h) === ref) || null;
    if (!el) { try { el = document.querySelector('[data-sp-ref="' + ref + '"]'); } catch (e) {} }
    how = el ? 'ref ' + ref : 'ref ' + ref + ' nao existe mais no DOM';
  } else if (sel) {
    try { el = document.querySelector(sel); how = el ? 'seletor ' + sel : 'seletor sem match'; }
    catch (e) { how = 'seletor invalido: ' + e.message; }
  } else if (idx !== null) {
    el = hits[idx] || null;
    how = el ? 'indice ' + idx : 'indice ' + idx + ' fora da lista (' + hits.length + ' elementos)';
  } else if (txt) {
    const t = norm(txt);
    const scored = hits
      .map((h) => { const l = norm(_name(h)); const s = l === t ? 4 : l.startsWith(t) ? 3 : l.includes(t) ? 2 : (l && t.includes(l)) ? 1 : 0; return { h, s, l }; })
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s);
    el = scored[0] ? scored[0].h : null;
    how = el ? 'texto "' + txt + '"' : 'nenhum elemento com o texto "' + txt + '"';
  } else {
    return { ok: false, reason: 'sem ref, index, text ou selector' };
  }
  if (!el) {
    return { ok: false, reason: how, candidates: hits.slice(0, 60).map((h) => _ref(h) + ' ' + _role(h) + ' ' + JSON.stringify(_name(h).slice(0, 60))) };
  }
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  const pt = _pointFor(el);
  const r = _box(el);
  if (!pt) {
    const top = document.elementFromPoint(Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2));
    const quem = top ? _role(top) + ' "' + _name(top).slice(0, 50) + '"' : 'nada';
    return { ok: false, reason: 'nenhum ponto do retangulo responde a este elemento; por cima esta ' + quem,
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }, how };
  }
  return { ok: true, x: pt.x, y: pt.y, ref: _ref(el), role: _role(el), name: _name(el).slice(0, 90), how };
})()`;

export const findExpr = (args) => String.raw`(() => { ${PRELUDE}
  const max = ${Number.isInteger(args.max) ? String(args.max) : "20"};
  const wantRole = ${JSON.stringify(args.role || "")}.trim();
  const wantName = ${JSON.stringify(args.name || "")}.trim().toLowerCase();
  const wantText = ${JSON.stringify(args.text || "")}.trim().toLowerCase();
  const out = [];
  for (const el of _hits()) {
    if (out.length >= max) break;
    const role = _role(el), name = _name(el);
    if (wantRole && role !== wantRole) continue;
    if (wantName && !name.toLowerCase().includes(wantName)) continue;
    if (wantText && !(_txt(el).toLowerCase().includes(wantText) || name.toLowerCase().includes(wantText))) continue;
    const r = _box(el);
    out.push({ ref: _ref(el), role, name: name.slice(0, 90), tag: el.tagName.toLowerCase(),
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      inView: r.y + r.height > 0 && r.y < innerHeight });
  }
  return { count: out.length, items: out };
})()`;

export const waitExpr = (args) => String.raw`(() => { ${PRELUDE}
  const mode = ${JSON.stringify(args.mode || "loaded")};
  const value = ${JSON.stringify(String(args.value || ""))};
  if (mode === 'loaded') {
    const busy = document.querySelector('[aria-busy="true"]');
    const bodyHead = String(document.body ? document.body.innerText : '').slice(0, 220);
    const loading = /(^|\n)\s*(carregando|loading|aguarde|please wait|processando|verificando)\b/i.test(bodyHead);
    return { ok: document.readyState === 'complete' && !busy && !loading, state: document.readyState, busy: !!busy, loading };
  }
  if (mode === 'selector') return { ok: !!document.querySelector(value) };
  if (mode === 'gone') return { ok: !document.querySelector(value) };
  if (mode === 'text') return { ok: String(document.body ? document.body.innerText : '').includes(value) };
  if (mode === 'url') return { ok: location.href.includes(value) };
  return { ok: false, reason: 'modo desconhecido: ' + mode };
})()`;

export const readExpr = (args) => String.raw`(() => {
  const scope = ${JSON.stringify(args.selector || "body")};
  const max = ${Number.isInteger(args.max) ? String(args.max) : "8000"};
  const root = document.querySelector(scope) || document.body;
  if (!root) return { ok: false, reason: 'escopo nao encontrado' };
  const skip = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'PATH']);
  const out = [];
  let len = 0;
  const push = (s) => { if (s && len < max) { out.push(s); len += s.length; } };
  // render devolve a linha do no, ou null quando o no deve ser aberto (descer).
  const render = (node) => {
    const tag = node.tagName.toLowerCase();
    if (tag === 'table') {
      return [...node.querySelectorAll('tr')].slice(0, 30).map((tr) =>
        '| ' + [...tr.children].map((td) => String(td.innerText || '').replace(/\s+/g, ' ').trim()).join(' | ') + ' |').join('\n');
    }
    if (tag === 'select') {
      return 'select[' + String(node.name || node.id || '') + ']: ' +
        [...node.options].slice(0, 40).map((o) => (o.selected ? '*' : ' ') + o.text.trim()).join(' / ');
    }
    if (tag === 'input' && node.type !== 'hidden') {
      return 'input[' + String(node.name || node.id || node.type) + ']' + (node.value ? ' = ' + String(node.value).slice(0, 80) : '');
    }
    if (tag === 'textarea') {
      return 'textarea[' + String(node.name || node.id || '') + ']' + (node.value ? ' = ' + String(node.value).slice(0, 80) : '');
    }
    if (/^(h1|h2|h3|h4|p|li|dt|dd|blockquote|pre|figcaption)$/.test(tag)) {
      const t = String(node.innerText || '').replace(/\s+/g, ' ').trim();
      if (!t) return null;
      return (tag[0] === 'h' ? '#'.repeat(Number(tag[1])) + ' ' : '') + t;
    }
    return null;
  };
  const walk = (node, depth) => {
    if (len >= max || depth > 24) return;
    for (const child of node.children) {
      if (len >= max) return;
      if (skip.has(child.tagName)) continue;
      const line = render(child);
      if (line !== null) push(line);
      else walk(child, depth + 1);
    }
  };
  const top = render(root);
  if (top !== null) push(top);
  else walk(root, 0);
  const text = out.join('\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, max);
  return { ok: true, text, chars: text.length };
})()`;

export const pointExpr = (x, y) => String.raw`(() => { ${PRELUDE}
  const el = document.elementFromPoint(${Number(x)}, ${Number(y)});
  if (!el) return { ok: false, reason: 'nada no ponto' };
  return { ok: true, ref: _ref(el), role: _role(el), name: _name(el).slice(0, 80), tag: el.tagName.toLowerCase() };
})()`;

export const setValueExpr = (selector, value) => String.raw`(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return { ok: false, reason: 'campo nao encontrado' };
  el.focus();
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
    : el instanceof HTMLInputElement ? HTMLInputElement.prototype : null;
  const desc = proto ? Object.getOwnPropertyDescriptor(proto, 'value') : null;
  if (desc && desc.set) desc.set.call(el, ${JSON.stringify(value)}); else el.value = ${JSON.stringify(value)};
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return { ok: true, value: String(el.value).slice(0, 80) };
})()`;

export const focusExpr = (selector) => String.raw`(() => { ${PRELUDE}
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return { ok: false };
  el.scrollIntoView({ block: 'center', behavior: 'instant' });
  el.focus();
  return { ok: true, ref: _ref(el), value: String(el.value || '').slice(0, 120) };
})()`;
