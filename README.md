# Swarm Pilot

Agente de browser na **barra lateral do Chrome**. Chat num painel nativo, raciocinio do modelo
visivel, reconhecimento por ref de acessibilidade, e um **ponteiro neon unico** que voa ate o alvo
e clica de verdade via **CDP** (`chrome.debugger` + `Input.dispatchMouseEvent`).

Nao e automacao de DOM. Nao e `element.click()`. E o mesmo canal que o DevTools usa.

## 1.2 — o que mudou

O turno **nao tem teto de passos**: acaba quando a tarefa termina (`done`), quando o modelo
responde sem tool call, no `stop` do painel ou quando o provedor erra. Loop de verdade (mesma
chamada identica) e tratado por assinatura: 3 repeticoes pedem mudanca de abordagem, 6 pedem
conclusao, 9 pedem `done` imediato e nao ha progresso na 12a — ai o turno fecha com `(travado: ...)`.
A chave `maxSteps` sumiu da config (a antiga e apagada na leitura).

- **Barra lateral nativa** (`chrome.sidePanel`): o chat saiu de dentro da pagina. Sem shadow DOM
  disputando z-index, sem vazamento de teclado, sem sumir atras de modal. O que fica injetado na
  aba e so o ponteiro (`content/pointer.js`).
- **Effort em `low`** por padrao (`reasoning_effort`), que e o modo que o resto do mercado chama
  de *ultrafast*: menos tokens e menos passos com a mesma taxa de acerto nesse tipo de tarefa.
- **Loop mais barato**: sonda de mutacao antes de reescanear, texto sob demanda, scan limitado,
  historico menor, teto de resultado por ferramenta. Numeros na secao de testes.
- **Plano obrigatorio** em tarefa de 3+ acoes, com uma cutucada que **nao gasta passo**
  (o modelo manda `plan` junto com a proxima acao, no mesmo turno).

## Instalar

```bash
# 1. carregar sem empacotar
chrome://extensions -> Modo desenvolvedor -> Carregar sem compactacao -> /home/teteu/Projects/swarm-pilot

# 2. abrir a barra lateral: clique no icone (ou Alt+Shift+K)
# 3. OPCOES: provedor, base URL, chave, modelo. Effort ja vem em low.
```

Comandos no painel: `/clear`, `/opts`, `/reason` (mostra/oculta raciocinio), `/model <id>`
(`nodecode`, `openai`, `anthropic`, `deepseek`, `openrouter`, `groq`, `ollama`, `boca`, `custom`),
`/neon #ff2d95`, `/target` (rele a aba alvo).

## Arquitetura

```
sidepanel.html/js        chat na barra lateral (pagina da extensao, sem shadow DOM)
   |  Port "panel"
background.js            resolve a aba ativa, anexa CDP, roda o turno, repassa eventos
   |                 lib/agent.js     loop: plano, ferramenta, observacao, reflexao, orcamento
   |                 lib/providers.js preset + perfil -> protocolo/baseUrl/model
   |                 lib/model.js     openai | anthropic, SSE, reasoning, tool calls
   |                 lib/tools.js     16 ferramentas, observacao automatica
   |                 lib/page.js      preprocessamento NA pagina (ref, a11y, delta, ponto)
   |                 lib/cdp.js       chrome.debugger (CDP 1.3)
   |  tabs.sendMessage
content/pointer.js       ponteiro neon no top layer; responde "chegou"
background.js            Input.dispatchMouseEvent (clique real na coordenada)
```

## Aba alvo

`chrome.debugger` recusa `chrome://`, Web Store, viewer de PDF, `devtools://` e as
paginas de outras extensoes. O background escolhe o alvo **antes** do turno, e o painel diz o que
fez:

| aba ativa | o que acontece |
|---|---|
| http(s) normal | usa ela |
| New Tab vazia | vira `about:blank` e segue |
| `chrome://settings` e afins, com outra aba normal aberta | ativa e usa a outra aba |
| so abas restritas | mensagem com o motivo, sem gastar chamada de modelo |

Se o attach falhar por outro motivo (DevTools aberto em cima da aba, sessao morta), a mensagem
diz qual: `outro debugger preso nesta aba` / `esta aba nao aceita debugger`.

## Ferramentas

| ferramenta | o que faz |
|---|---|
| `page_state` | url, titulo, carregando?, foco, dialogos, alertas, delta, interativos com ref/papel/nome/estado/coordenada |
| `find` | busca por papel/nome/texto e devolve refs |
| `read` | extrai regiao como texto estruturado (headings, listas, tabelas, valores de form) |
| `plan` | registra plano (2-6 passos) e marca passo feito |
| `ask_agent` | consulta outro modelo configurado, opcionalmente com o page_state |
| `click` | clique real por `ref` (preferido), `index`, `text` ou `selector`; ponteiro anima antes |
| `type` | `Input.insertText` no campo (por ref), com `clear`/`submit` |
| `key` | tecla/combo: Enter, Tab, Escape, Control+a... |
| `scroll` / `navigate` / `wait` | roda do mouse / `Page.navigate` / `loaded`, `selector`, `gone`, `text`, `url`, `ms` |
| `evaluate` / `fetch_url` | escotilha JS e fetch com os cookies do usuario |
| `screenshot` / `tabs` / `done` | captura, abas, encerrar |

## Reconhecimento (o que faz o agente nao ser cego)

`lib/page.js` roda **dentro da pagina**:

- **ref** (`data-sp-ref`) atribuida uma vez por no (WeakMap): sobrevive a reordenacao do DOM.
  Indice e efemero. `click(ref:"e42")` acerta o mesmo no.
- **nome acessivel**: `aria-labelledby` -> `aria-label` -> `<label>` -> `alt/title/placeholder`
  -> texto -> `name/id`.
- **estado**: papel, value, checked, disabled, required, expanded, foco.
- **oclusao**: `elementFromPoint` no centro; diz quem esta por cima e se ha ponto livre
  (`clicavel fora do centro` vs `feche esse overlay primeiro`).
- **clique**: testa centro + 24 pontos do retangulo ate achar um que responda ao elemento.
- **carregando**: `readyState`, `aria-busy` e heuristica de texto.
- **delta**: fingerprint por ref contra o snapshot anterior -> `+novos ~alterados -removidos`.

## Otimizacao (medida)

| o que | antes | agora |
|---|---|---|
| snapshot em pagina com 3000 interativos | scan de tudo | `41 ms` (primeiro), `23 ms` (seguinte) |
| sonda de mutacao (decide reescanear) | nao existia | `2,5 ms` |
| resolver ref na pagina pesada | - | `9-12 ms` |
| texto por snapshot | 4 kB sempre | 4 kB no primeiro, 700 B depois |
| observacao apos acao sem mudanca | snapshot inteiro | `(nada mudou)`, so a sonda |
| historico | 34 mensagens | 24 |
| resultado de ferramenta | 7 kB | 4,5 kB |

Mecanismos: `MutationObserver` na pagina incremente um contador; `probeExpr` le esse contador,
url, foco, scroll e viewport em **um** eval; se nada mudou, a acao devolve `(nada mudou)` e o
modelo nao paga reescaneamento. O scan para em ~240 visiveis (o custo e `getComputedStyle`).
`page_state` so manda texto inteiro no primeiro snapshot ou com `full_text: true`.

## Ponteiro neon

`content/pointer.js`, `pointerTo(x, y, label, press)`: um unico elemento, posicao anterior
guardada, ease-in-out cubico com arco perpendicular de ate 64 px, rastro com branco na ponta,
halo radial, ponto branco exato na coordenada, pulso no pouso. `pointerMs` 120..900 (padrao 320),
`/neon #rrggbb` troca a cor. Aba oculta nao roda `requestAnimationFrame`: retorna na hora, senao
o clique (que espera o ponteiro) nunca dispara.

**Visivel em qualquer tela**: o host e um **popover manual** (`popover="manual"`), ou seja, top
layer: ganha de `<dialog>.showModal()`, de fullscreen, de `z-index: 2147483647` e de ancestral
com `transform` (que quebra `position: fixed`). Montado no `<html>`, remontado por
`MutationObserver` se a SPA trocar o body, e movido para dentro de `dialog[open]` enquanto ele
existir (fora dele o conteudo fica `inert`). `pointer-events: none` garante que ele nao rouba
clique nem tecla - provado em `test/keys.mjs`.

## Pesquisa aplicada

Levantamento feito em `onion.live` / `tor.taxi` (indices onion vivos; Dread por gateway esta fora)
e nos projetos abertos que resolvem o mesmo problema:

| fonte | o que foi aproveitado |
|---|---|
| `browser-use` | o modo que eles chamam de **ultrafast** age por **ids da arvore de acessibilidade** - e o modelo de ref que ja usamos; `sensitive_data` para redigir segredo do output |
| `Stagehand` (Browserbase) | `observe()` devolve seletor real e `act()` se auto-cura: cache de seletor por intencao, replay sem LLM |
| `browser-use` / benchmark v2 | destacar o alvo por ~1 s (nosso ponteiro/pulso) e tier de raciocinio baixo para velocidade |
| HN (Agent-Browser, BrowserWing) | expor a extensao como **MCP** para outro agente dirigir |

Roadmap derivado, em ordem de ganho: (1) **gravar e reproduzir** - primeira execucao com LLM,
replay deterministico por ref/seletor nas seguintes; (2) **`chrome.alarms`** para tarefa agendada
com o painel fechado; (3) **MCP server** local (`127.0.0.1`) expondo `page_state`/`click`/`type`
para Codex/Claude dirigirem o browser; (4) redacao de segredo no output (`sensitive_data`).

## Testes

```bash
cd /home/teteu/Projects/swarm-pilot
node test/model.mjs      # dois protocolos contra servidor falso: reasoning, tool calls, conversao
node test/ground.mjs     # fixture de reconhecimento: ref, delta, oclusao, a11y, read
node test/options.mjs    # a engrenagem abre a pagina, salva no storage, reset volta ao padrao
node test/keys.mjs       # ponteiro no top layer nao rouba clique nem tecla da pagina
node test/tabs.mjs       # New Tab / chrome://settings nao matam o turno: troca de alvo
node test/anywhere.mjs   # ponteiro acima de transform, z-index rei e <dialog> modal
node test/perf.mjs       # orcamento de tempo/texto + sonda de "nada mudou"
node test/e2e.mjs        # modelo real: clique por ref, ponteiro na tela, raciocinio no painel
node test/task.mjs       # modelo real: formulario completo + ask_agent
```

Estado medido (Chrome 155.0.8059.84, `nodecode-cyber-v1`, effort low):

| teste | resultado |
|---|---|
| `model` | 26/26 - reasoning real, tool calls por fragmento, anthropic `thinking_delta`, 401 vira ModelError |
| `ground` | 26/26 - refs estaveis, delta, oclusao nos dois sentidos, `read` de tabela |
| `keys` | 7/7 - ponteiro pousa, hit-test ainda e o botao da pagina, clique e teclado intactos |
| `anywhere` | 8/8 - top layer com modal e `transform`, host entra/sai do dialogo, coordenada de viewport |
| `perf` | 14/14 - snapshot 41/23 ms, sonda 2,5 ms, resolve 9-12 ms, `(nada mudou)` apos acao inerte |
| `tabs` | 7/7 - New Tab vira `about:blank`, `chrome://settings` cede lugar a pagina normal, turno roda e clica |
| `options` | 11/11 - engrenagem abre `options.html`, 9 provedores, salvar persiste, reset restaura |
| `e2e` | 5 passos (com `maxSteps:1` na config, ignorado), ~4,5 mil tokens, contador 0->1 por clique CDP, usage no painel |
| `task` | 8 passos, plano de 5, 337 chars de raciocinio, 7 mil tokens, 5 campos corretos, `ask_agent` -> OK-CONSULTOR |

## Limites conhecidos

- **iframe cross-origin**: o snapshot ve o `iframe` (url, tamanho), nao o conteudo.
- **`chrome://`, Web Store e PDF viewer**: extensao nao injeta.
- **`file://`**: exige "Permitir acesso a URLs de arquivo" nas opcoes da extensao.
- **MV3 cacheia o grafo de imports do service worker no perfil**: editar `lib/*.js` e recarregar a
  extensao nao basta no mesmo perfil. Suba `manifest.version` (agora 1.2.2) ou use perfil limpo.
  Os testes apagam o perfil por isso.
- **Side panel no headless**: o Chrome sem janela nao expoe a barra lateral como alvo CDP; os
  testes abrem `sidepanel.html` numa aba e reativam a aba alvo. Em janela real e a barra nativa.
- **`reasoning` em effort low e esporadico**: o provedor pode nao emitir raciocinio nenhum e o
  painel fica sem o bloco; o plano (obrigatorio em 3+ acoes) continua sendo o rastro do porque.
- **Ctrl+clique direito do site**: o ponteiro fica no top layer e nao intercepta nada, mas um
  overlay do proprio site com `pointer-events: auto` ainda pode cobrir o alvo do clique; e o que
  o `occludido por X` do snapshot denuncia.

## Arquivos

```
manifest.json          MV3: debugger, tabs, storage, scripting, sidePanel
background.js          port do painel, aba ativa, perfis, orcamento, historico, CDP
sidepanel.html/js      chat na barra lateral: raciocinio, plano, passos, comandos
lib/agent.js           loop ReAct: plano, ferramenta, observacao, reflexao, orcamento
lib/providers.js       presets + resolucao de perfil (agent / advisor / por id)
lib/model.js           openai | anthropic, SSE, reasoning, tool calls, ping
lib/tools.js           16 ferramentas, observacao por sonda, ask_agent
lib/page.js            preprocessamento na pagina: ref, a11y, delta, ponto clicavel, sonda
lib/cdp.js             chrome.debugger: attach, evaluate, mouse, wheel, screenshot
content/pointer.js     ponteiro neon no top layer (unico script injetado na pagina)
options.html/js        provedor, perfil, advisor, reasoning (low), ponteiro, visao; sem campo de passos
test/                  harness + model, ground, options, keys, anywhere, perf, e2e, task
```
