# NÚCLEO OS — Virtual PC no navegador

Projeto independente, dentro deste repositório em `nucleo/`. Um **computador virtual dentro da aba
do navegador**: desktop com janelas flutuantes, terminal sobre um sistema de arquivos real, motor de
mundo aberto próprio com HUD estilo jogo, painel de configurações e telemetria profissional — tudo
escrito à mão, **sem dependências de runtime** e sem rede.

Não é uma demonstração de fachada: cada número exibido na interface vem de uma medição real, e
quando o navegador não expõe uma métrica o sistema escreve `N/D` com o motivo em vez de inventar.

Não depende do launcher PS2 deste repositório: tem servidor próprio, `index.html` próprio e roda por
conta — nenhum arquivo do launcher foi tocado.

```sh
cd nucleo
npm ci                    # opcional: só para os testes de interface (jsdom)
npm start                 # http://localhost:3400
```

Abra em **aba própria** para o modo completo.

### O que muda em preview embutido (iframe de terceiros)

Um iframe não herda isolamento de origem: sem `crossOriginIsolated`, o navegador **não expõe**
`SharedArrayBuffer`. O sistema detecta isso na sondagem de boot e degrada de forma explícita,
nunca silenciosa:

| Capacidade | Aba própria | Preview embutido |
|---|---|---|
| Desktop, janelas, terminal, arquivos, configurações | funciona | funciona |
| Workers (kernel, motor, I/O) | `RING/SAB` | `MESSAGE` (MessageChannel) — mais lento, mesma API |
| `SharedArrayBuffer` + `Atomics.waitAsync` | sim | não |
| Estado do mundo (tráfego) | buffer compartilhado + seqlock | ping-pong por `postMessage` a ~30 Hz, sem alocação |
| OPFS (disco virtual) | persistente | funciona se o host permitir storage; senão, memória volátil declarada |
| WebGL2 (cena 3D) | sim | sim, se o host permitir GPU no iframe |
| Transporte exibido no HUD | `RING/SAB` | `MESSAGE` + aviso na interface |

Três falhas reais foram encontradas e corrigidas justamente testando este caminho — todas derrubavam
o preview e nenhuma aparecia com `SharedArrayBuffer` disponível:

1. `createSnapshotBuffer()` chamava `new SharedArrayBuffer` sem verificar: sem isolamento de origem
   isso é `ReferenceError` e **o boot inteiro morria** na primeira linha (era o
   "Falha ao iniciar o desktop").
2. `openPort()` tratava `port1`/`port2` como par envio/recepção e transferia o extremo do main para
   o worker: o desktop publicava e **nunca recebia resposta** — toda requisição dava timeout.
3. Faltavam o laço de bombeamento no worker de I/O e a entrega de frames ao `Link` no
   `acceptWorkerLink`, o que deixava os `promises` do VFS pendurados para sempre.

Os três têm regressão automatizada: `npm run test:core` §3, §5 e §13 rodam **sem
`SharedArrayBuffer`** e exercitam o `io.worker.js` **real** por `MessagePort`.

Se o contexto for ainda mais restrito — origem opaca (`sandbox` sem `allow-same-origin`), política
que proíbe Web Workers — o sistema **não fica preso na tela de boot**: entra em **modo local**
(desktop sem kernel/motor/worker de I/O, disco em memória), avisa por toast e marca cada métrica
ausente como `N/D` no HUD. A tela de boot tem um watchdog de 15 s para nunca prender o desktop.

Regra: nada é simulado para parecer que funciona. O que não existe aparece como ausente.

---

## O que já funciona

| Módulo | Estado | O que é real |
|---|---|---|
| Desktop + Window Manager | funcional | janelas arrastáveis/redimensionáveis, minimizar/maximizar/fechar, snap em zonas, barra de tarefas, dock, atalhos, command palette (`Ctrl+K`) |
| Terminal | funcional | shell sobre o VFS (`ls`, `cd`, `cat`, `write`, `rm`, `df`, `sysctl`, `bench`, `top`, `uname`), com caminhos normalizados e recusa de nomes hostis |
| Gerenciador de arquivos | funcional | navegação, criação, remoção, renomeação no mesmo VFS do terminal |
| Sistema de arquivos (VFS) | funcional | OPFS com `SyncAccessHandle` quando disponível, degradando para `createWritable` e para memória volátil — o backend em uso aparece na interface |
| Motor de mundo aberto | funcional | ECS SoA com passo fixo de 120 Hz, física de seguimento de faixa, IA de tráfego, snapshot binário, cena 3D em WebGL2 |
| Telemetria (HUD) | funcional | FPS, P50/P95 de quadro, custo por worker, MB/s de I/O, entidades, ticks, transporte IPC |
| Kernel Linux (Debian) | **emulado, fase inicial** | vCPU simulada com `SYS_EXEC`/`tick`; o terminal é o do NÚCLEO OS, **não** um Linux real |
| Painel de configurações | funcional | perfis, resolução, teto de FPS, shaders, DRS, gestão do disco OPFS; controles sem efeito ficam desabilitados com o motivo |

## Arquitetura

```text
main            NÚCLEO WM/desktop · dock · taskbar · HUD · configurações · apps
  │  ipc.ring: 2 canais SPSC por par em SharedArrayBuffer (degradação: MessageChannel)
  ├── w-kernel  vCPU Linux simulada (SYS_EXEC/SYS_OUT, tick 120 Hz, estatísticas)
  ├── w-engine  ECS SoA + física + IA de tráfego a 120 Hz, snapshot binário
  └── w-io      OPFS (blocos de 32 KiB), índice do sistema de arquivos, medição de I/O
  ↓
GPU: WebGL2 hoje (caminho WebGPU especificado em docs/00) · OPFS: NVMe virtual
```

Leitura completa, com diagrama de fluxo (Mermaid, ASCII e SVG), orçamentos de quadro/VRAM,
matriz de falha → resposta e roadmap:

- [`docs/00-arquitetura.md`](docs/00-arquitetura.md) — arquitetura de alto nível
- [`docs/02-diagrama-fluxo.svg`](docs/02-diagrama-fluxo.svg) — diagrama vetorial
- [`docs/01-design-system.md`](docs/01-design-system.md) — design system (VÉU · VIDRO · LUZ)
- [`docs/03-protocolo-ipc.md`](docs/03-protocolo-ipc.md) — protocolo do barramento entre threads

## Testes

```sh
npm test               # núcleo + interface, sem navegador e sem rede
npm run test:core      # IPC (bytes, wrap, drops), VFS real sobre worker_threads, seqlock, grafo de imports
npm run test:ui        # DOM real via jsdom: boot, window manager, HUD, toasts, boot degradado
npm run test:browser   # Playwright/Chromium — exige `npx playwright install chromium`
```

O teste de navegador está escrito e **não foi executado no ambiente de construção** (download do
Chromium bloqueado). Nenhum resultado de navegador é declarado enquanto não houver execução.

## Honestidade técnica

- `N/D` com motivo no HUD em vez de valor inventado (VRAM, heap por worker).
- VRAM só aparece como soma das alocações declaradas, rotulada como estimativa.
- Sem `SharedArrayBuffer`, o transporte IPC cai para `MESSAGE` e a interface exibe isso.
- O kernel Linux é uma vCPU simulada; nenhum jogo comercial, BIOS ou distribuição é distribuída aqui.
- Nenhum número de desempenho neste diretório foi estimado: todos vêm de medição local.

## Estrutura

```text
index.html          shell do desktop (sem CDN, funciona offline)
server.js           servidor estático mínimo com COOP/COEP (zero dependências)
css/tokens.css      tokens do design system (fonte única de verdade)
css/os.css          contrato visual de todos os componentes
js/core/            ipc · link · wire · snapshot · vfs · vfs-local · geom · wm · bus · util · mat4
js/ui/              hud · toast · icons
js/apps/            terminal · files · game · settings
js/boot.js          boot + sondagem real de capacidades do navegador
js/main.js          orquestração: workers, barramentos, VFS, WM, HUD, registro de apps
workers/            kernel.worker · engine.worker · io.worker
tests/              core.mjs · ui.mjs · browser.mjs · worker-fixture.mjs · io-worker-host.mjs
docs/               arquitetura · design system · protocolo IPC · diagrama
```
