// Camada CDP sobre chrome.debugger: uma sessao por aba, sem flags de launch.
const sessions = new Map();

// O detach pode vir de fora: o botao "Cancel" da infobar, o DevTools assumindo a aba,
// outro debugger. Sem isto o Map continua dizendo "anexado" e todo sendCommand falha
// em silencio ate a aba recarregar.
chrome.debugger.onDetach.addListener((source) => {
  if (source?.tabId !== undefined) sessions.delete(source.tabId);
});

export class CdpError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = "CdpError";
    this.detail = detail;
  }
}

export async function attach(tabId) {
  if (sessions.has(tabId)) return;
  const target = { tabId };
  try {
    await chrome.debugger.attach(target, "1.3");
  } catch (e) {
    const msg = String(e?.message || e);
    if (/Another debugger is already attached/i.test(msg)) {
      throw new CdpError("outro debugger preso nesta aba (feche o DevTools e tente de novo)", msg);
    }
    // Aba de chrome://, Web Store, PDF viewer e devtools nao aceitam o debugger.
    // Sem dizer QUAL aba, a mensagem generica faz o operador achar que e bug do agente.
    if (/cannot access|cannot attach|chrome:\/\/|extensions gallery|not scriptable|kInvalidUrl/i.test(msg)) {
      throw new CdpError("esta aba nao aceita debugger (chrome://, Web Store, PDF ou devtools) - abra uma pagina http(s)", msg);
    }
    throw new CdpError("falha ao anexar o debugger", msg);
  }
  sessions.set(tabId, true);
  try {
    await chrome.debugger.sendCommand(target, "Page.enable");
    await chrome.debugger.sendCommand(target, "Runtime.enable");
  } catch (e) {
    // Page/Runtime.enable e best-effort: alguns alvos (prerender, extensao) recusam.
  }
}

export async function detach(tabId) {
  if (!sessions.has(tabId)) return;
  sessions.delete(tabId);
  try {
    await chrome.debugger.detach({ tabId });
  } catch (e) {}
}

export function isAttached(tabId) {
  return sessions.has(tabId);
}

export async function send(tabId, method, params = {}) {
  await attach(tabId);
  try {
    return await chrome.debugger.sendCommand({ tabId }, method, params);
  } catch (e) {
    const msg = String(e?.message || e);
    if (!/not attached|No tab with given id|Cannot access/i.test(msg)) {
      throw new CdpError(`${method} recusado`, msg);
    }
    // Sessao morreu por fora: esquece e re-anexa uma vez, em vez de falhar para sempre.
    sessions.delete(tabId);
    await attach(tabId);
    try {
      return await chrome.debugger.sendCommand({ tabId }, method, params);
    } catch (e2) {
      throw new CdpError(`${method} recusado apos re-anexar`, String(e2?.message || e2));
    }
  }
}

export async function evaluate(tabId, expression, opts = {}) {
  const params = {
    expression,
    returnByValue: opts.returnByValue !== false,
    awaitPromise: opts.awaitPromise !== false,
    userGesture: opts.userGesture !== false,
  };
  const res = await send(tabId, "Runtime.evaluate", params);
  if (res.exceptionDetails) {
    const d = res.exceptionDetails;
    const desc = d.exception?.description || d.text || "excecao na pagina";
    throw new CdpError("excecao ao avaliar na pagina", desc);
  }
  return res.result?.value;
}

export async function waitForLoad(tabId, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const ready = await evaluate(tabId, "document.readyState", { userGesture: false });
      if (ready === "complete") return true;
    } catch (e) {}
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

export async function mouseClick(tabId, x, y, opts = {}) {
  const button = opts.button || "left";
  const clickCount = opts.clickCount || 1;
  const buttons = button === "right" ? 2 : 1;
  await send(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", buttons: 0 });
  await new Promise((r) => setTimeout(r, 16));
  await send(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, buttons, clickCount });
  await new Promise((r) => setTimeout(r, 28));
  await send(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, buttons: 0, clickCount });
}

export async function mouseMove(tabId, x, y) {
  await send(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", buttons: 0 });
}

export async function wheel(tabId, x, y, deltaY, deltaX = 0) {
  await send(tabId, "Input.dispatchMouseEvent", {
    type: "mouseWheel", x, y, deltaX, deltaY, button: "none", buttons: 0,
  });
}
