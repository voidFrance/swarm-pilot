# Seguranca

## O que a extensao pode fazer em seu nome

| permissao | da acesso a | custo |
|---|---|---|
| `debugger` | CDP completo: `Runtime.evaluate`, `Input.dispatchMouseEvent`, `Page.captureScreenshot` | banner "esta depurando" enquanto anexada; `autoAttach` anexa em toda aba |
| `<all_urls>` | ler, clicar e escrever em qualquer origem | cobre cookies de sessao |
| `scripting` | injetar `content/pointer.js` | um no no DOM de toda pagina |
| `storage.sync` | config, perfis e chaves | a chave e sincronizada com a conta Google |

O modelo decide qual ferramenta roda. **Texto de pagina e entrada hostil**: prompt injection na aba
alvo pode mandar o agente chamar `evaluate` (JS arbitrario) ou `fetch_url` (fetch com
`credentials: "include"`, ou seja, com os cookies daquela origem). Nao ha allowlist de origem nem
confirmacao por acao; `stop` no painel corta o turno. Trate como um agente com a sua sessao, nao
como um leitor.

## Chaves

- Nenhuma chave no repositorio. `DEFAULTS.key` em `background.js` e `""`. A build 1.1 saiu com a
  chave do autor embutida; ate a 1.2.2 quem instalou de fonte alheia usava a conta dele.
- A chave fica em `chrome.storage.sync`, em claro, e viaja para a conta Google do usuario.
- `endpointBase()` em `lib/model.js` normatiza o endpoint antes de qualquer request: `https:` em
  qualquer host, `http:` so em loopback (`localhost`, `127.0.0.1`, `[::1]`), e recusa `baseUrl`
  com usuario/senha embutidos. `Bearer` e `x-api-key` nunca saem em texto claro.
- Rotacione a chave se ela esteve em arquivo compartilhado, print, gist ou build antiga.

## Reportar

Issue privada: **Security -> Report a vulnerability** (private vulnerability reporting habilitado).
Sem bounty. Confirmacao em 72h; correcao em ate 30 dias para o que for exploravel.

## Fora de escopo

- Deteccao de automacao pelo site alvo (`navigator.webdriver`, timing de CDP, banner do debugger):
  e limitacao de projeto do canal, nao vulnerabilidade.
- Modelo respondendo errado ou clicando no alvo errado.
