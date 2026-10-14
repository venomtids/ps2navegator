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

## Como instalar coisas

Três níveis diferentes — e é importante não confundir um com o outro.

### 1. Dependências do projeto (só para os testes)

```sh
cd nucleo
npm ci          # instala jsdom, usado APENAS pelos testes de interface
```

O sistema em si **não tem dependências de runtime**: `js/core`, `js/ui`, `js/apps` e
`workers/` rodam sem `node_modules`. O `server.js` é `node:http` puro. Se `npm ci` não rodar,
`npm start` continua funcionando — só `npm run test:ui` fica indisponível.

### 2. Arquivos dentro do PC virtual (funciona hoje)

O disco virtual (`VMFS`, sobre OPFS) aceita arquivos do seu computador de quatro formas:

| Gesto | Onde cai |
|---|---|
| **Arrastar e soltar** em qualquer lugar do desktop | `~/Downloads` (o overlay diz o destino antes de soltar) |
| Arrastar e soltar **na janela Arquivos** | o diretório aberto naquela janela |
| `Ctrl+K` → *Instalar arquivos no PC virtual* | `~/Downloads` |
| Terminal: `install` (ou `receber`) | o diretório atual do shell |

No terminal, `install ~/fotos` instala no diretório indicado. Nada sai do seu computador: não há
rede, não há upload, não há telemetria — são bytes do seu disco para o OPFS do navegador.

Regras que o instalador aplica (todas com teste):

- **nome nunca vira caminho**: `../../etc/passwd` entra como `etc-passwd`;
- **nada é sobrescrito em silêncio**: nome repetido vira `arquivo (1).txt` e a UI avisa;
- **cota antes da escrita**: quando o navegador informa a cota, o arquivo é recusado com os
  números reais em vez de falhar no meio; sem cota informada, nenhum limite é inventado;
- **falha isolada**: um arquivo ilegível não impede os outros de entrarem;
- **progresso medido**: bytes e tempo reais, reportados no fim.

Para conferir o que entrou: terminal `ls ~/Downloads`, `df` (uso e cota do disco) e `bench`
(velocidade real de escrita/leitura do VMFS). Os arquivos ficam no OPFS do navegador para esta
origem: sobrevivem a recarregar a página quando o backend é `OPFS`; em modo local (memória
volátil) eles somem ao fechar a aba — e o HUD diz qual dos dois está ativo.

### 3. Programas Linux (`apt install …`) — ainda não, e sem fingir

O kernel do convidado é uma **vCPU simulada** (fase inicial): existe `SYS_EXEC`/`tick`, mas não há
Linux de verdade rodando, e portanto não existe `apt`, `dpkg` nem repositório. Um `apt install`
falso seria exatamente o tipo de mentira que este projeto evita — a resposta honesta é a fase F4 do
roadmap (`docs/00-arquitetura.md` §6.1).

Quando o runtime real entrar, o caminho já está definido e o disco não muda:

```text
hoje     instalar arquivo  →  VMFS (OPFS)                    ← real, testado
F4       apt install       →  runtime Linux no w-kernel
                             ├─ rootfs Debian no próprio VMFS (o instalador acima
                             │  já coloca a imagem lá, sem código novo)
                             ├─ rede do guest via WebSocket/WebRTC (proxy no host)
                             └─ `install` passa a aceitar também pacotes .deb
```

Ou seja: o `nucleo/` que você tem hoje já é o disco dessa máquina. O que falta é o kernel de
verdade, não o armazenamento nem o caminho de instalação.

## Como instalar um navegador nele

Resposta curta e em camadas, porque "instalar o Chrome aqui dentro" tem três significados
diferentes — e só um deles é mentira:

**1. Um navegador gráfico de verdade (Chrome, Firefox) rodando *dentro* do PC virtual.**
Precisa do runtime Linux real, que é a fase F4 (`docs/00-arquitetura.md` §6.1). Não existe ainda, e
um "Chrome" de mentira seria pior do que dizer isso.

**2. Embutir o site dentro da interface por `iframe`.** Não funciona por dois motivos independentes:
a maioria dos sites proíbe ser embutida (`X-Frame-Options`/`frame-ancestors`) e a nossa própria
página é `crossOriginIsolated` (COEP `require-corp`), então nada de outra origem é carregado no
documento. O resultado prático seria uma área em branco — não uma janela de navegador.

**3. Um navegador do sistema, modo texto — este existe e está funcionando.**
É o "Lynx do NÚCLEO": a página é buscada pelo servidor local (`/api/fetch`), convertida em texto e
linhas clicáveis, e navegada dentro de uma janela normal do desktop.

| Recurso | Estado | Como usar |
|---|---|---|
| Abrir | funcional | dock **Navegador**, paleta (`Ctrl+K` → *Abrir o navegador do sistema*), ou terminal `browse <endereço>` (alias `navegar`, `www`) |
| Endereço | funcional | digitar e `Enter`; sem esquema assume `https://`; o que não parece domínio vira busca na Wikipédia |
| Navegação | funcional | links em néon clicáveis, `←`/`→` (ou `Alt+←`/`Alt+→`), `⟳`/`F5`, `Ctrl+L` para a barra de endereço |
| Salvar | funcional | botão **Salvar** grava o recurso em `~/Downloads` pelo mesmo instalador (aparece em `ls`, `Arquivos`) |
| Renderização | **modo texto** | título, cabeçalhos, listas, citações, `<pre>`, imagens (`[imagem: alt]`) e links; **não** há layout, CSS, imagens pintadas nem JavaScript do site |

O que o servidor recusa, com o motivo escrito na própria página de erro (nada é silencioso):
`file://`, `data:`, `javascript:`, credenciais na URL, portas baixas fora de 80/443, portas de
serviços internos (Docker API, Redis, bancos — lista em `js/core/fetchpolicy.js`), `localhost`,
sufixos `.local`/`.internal`, qualquer IP privado/loopback/link-local, e redirecionamentos que
levem para dentro da rede. As guardas são testadas antes **e** depois do DNS, porque um hostname
público pode resolver para um IP privado.

```text
o usuário digita            servidor local (modem)                   janela do navegador
─────────────────           ─────────────────────────────          ─────────────────────
"Navegador" no dock   →     /api/fetch?url=…                  →    htmltext.js
ou `browse site.com`        ├─ política de destino (SSRF)          ├─ título / linhas / links
                            ├─ DNS validado por salto              ├─ segmentos clicáveis
                            ├─ redirects seguidos à mão (≤5)       ├─ histórico ← →
                            ├─ 2 MiB texto · 8 MiB bruto           └─ "Salvar" → ~/Downloads (VMFS)
                            └─ timeout de 15 s
```

Limites declarados, para ninguém se surpreender: páginas acima de 2 MiB são recortadas em 4000
linhas (com aviso na tela, não em silêncio); downloads acima de 8 MiB são recusados com o tamanho
real informado; e a checagem de IP acontece antes da conexão, então **DNS rebinding** não é
eliminado por completo — a mitigação é a de sempre: este servidor é de uso local, não exponha a
porta na internet. Se a sua rede exigir uma CA própria (proxy corporativo), suba o servidor com
`NODE_EXTRA_CA_CERTS=/caminho/ca.crt node server.js` — mecanismo padrão do Node, sem gambiarra.

## O que muda em preview embutido (iframe de terceiros)

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
| Navegador (modo texto) | funcional | busca pelo servidor local com política anti-SSRF, HTML → texto com links clicáveis, histórico voltar/avançar, salvar em `~/Downloads`; declara na interface que **não** é um motor gráfico |
| Instalador de arquivos | funcional | arrastar-e-soltar, paleta, janela Arquivos e `install` no terminal; sanitização de nome, colisão sem sobrescrita, cota checada antes da escrita |
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

Os testes da política de rede do navegador usam `fetch` e DNS falsos (`tests/core.mjs` §17): se
alguém tentar buscar `169.254.169.254` ou seguir um `Location` para dentro da rede, o teste acusa —
e a rota é exercitada sem tocar a internet.

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
js/core/            ipc · link · wire · snapshot · vfs · vfs-local · import · fetchpolicy · htmltext · geom · wm · bus · util · mat4
server/             fetch-route.js (rota /api/fetch do navegador do sistema)
js/ui/              hud · toast · icons
js/apps/            terminal · browser · files · game · settings
js/boot.js          boot + sondagem real de capacidades do navegador
js/main.js          orquestração: workers, barramentos, VFS, WM, HUD, registro de apps
workers/            kernel.worker · engine.worker · io.worker
tests/              core.mjs · ui.mjs · browser.mjs · worker-fixture.mjs · io-worker-host.mjs
docs/               arquitetura · design system · protocolo IPC · diagrama
```
