# NÚCLEO OS — Design System Conceitual

> **Documento 01 de 03.** Linguagem visual, tokens, componentes e regras de interação
> do desktop que roda no navegador. O objetivo declarado é uma experiência de nível
> *"sistema operacional de última geração"*: escura, translúcida, precisa e **medida** —
> onde a beleza vem da contenção e da telemetria verdadeira, não de ornamento.

Implementação de referência: `css/tokens.css` + `css/os.css`,
aplicados em `/os` (**[B]** na nomenclatura do Documento 00).

---

## 1. Princípios

1. **Vidro, não plástico.** Toda superfície flutuante é uma lâmina de vidro escuro sobre o vazio: fundo translúcido, `backdrop-filter`, borda luminosa de 1 px. Nada de gradientes decorativos pesados.
2. **A luz significa estado.** Cor saturada é recurso finito: reservada para foco, atividade e telemetria. Se tudo brilha, nada comunica.
3. **Movimento é física, não enfeite.** Animações existem para explicar de onde veio e para onde foi um objeto (origem → destino). Duração máxima: 420 ms. Entrada mais rápida que saída.
4. **Dados honestos.** O HUD mostra o que o navegador realmente expõe. Métrica indisponível aparece como `N/D` com explicação — nunca inventada, nunca decorativa.
5. **Silêncio em repouso.** Sem UI, a tela é um vazio profundo com uma grade sutil. A interface só aparece onde há conteúdo ou foco.
6. **Acessível por padrão.** O contraste AA, o foco visível e `prefers-reduced-motion` não são *polish* de última hora: são cláusulas do contrato.

---

## 2. Linguagem visual — três camadas de matéria

| Camada | Papel | Material | Regra |
|---|---|---|---|
| **VEU** (Void) | Fundo do desktop | `--void-0` + grade em perspectiva + aurora radial | 97% da área; nunca recebe texto direto |
| **VIDRO** (Glass) | Janelas, dock, HUD, menus | `--glass-1/2/3` + `blur(18px)` + borda `--line` | Só flutua: sempre ≥ 8 px acima do véu |
| **LUZ** (Light) | Foco, atividade, dados | `--neon` `--lime` `--amber` `--crit` | Traço de 1 px, LED de 6 px, ou texto. Nunca preenchimento grande |

### 2.1 Regras do vidro

- Blur em três degraus: `--blur-1: 12px`, `--blur-2: 18px`, `--blur-3: 24px` (HUD e modais).
- Saturação de fundo `saturate(140%)` — dá corpo ao vidro sem custo relevante.
- Borda: `1px solid rgba(53,240,255,.16)`; a **borda ativa** sobe para `.38` **e** ganha `box-shadow: 0 0 0 1px` interno — nunca só mudança de cor.
- **Teto de área:** superfícies com `blur-2`/`blur-3` não passam de ~1,5 M px. Janela maximizada troca para `--glass-solid` (tinta a 92%, sem blur): o usuário não percebe queda de nitidez e o compositor agradece.
- Empilhamento: no máximo **3 superfícies translúcidas sobrepostas** (ex.: janela + HUD + toast). A quarta vira sólida.
- Fallback: `@supports not (backdrop-filter: blur(1px))` → vidro vira tinta a 94%, com a mesma borda. A hierarquia visual se mantém.

### 2.2 Cenário do vazio

Grade em perspectiva (já estabelecida na marca NÚCLEO) como assinatura de profundidade,
duas auroras radiais (ciano no canto superior esquerdo, violeta no direito) e *scanlines*
a 2,8% de opacidade em `mix-blend-mode: overlay`. Tudo em `position: fixed`, `pointer-events: none`,
e **pausável**: com o desktop em repouso > 30 s, o `drift` da grade para (economia de GPU).

---

## 3. Tokens (fonte única: `css/tokens.css`)

| Token | Valor | Uso |
|---|---|---|
| `--void-0` | `#04070e` | fundo absoluto |
| `--void-1` | `#070c16` | gradiente de fundo |
| `--glass-1` | `rgba(9,15,26,.72)` | janela inativa |
| `--glass-2` | `rgba(8,14,24,.84)` | janela ativa, dock |
| `--glass-3` | `rgba(6,11,20,.92)` | HUD, modais, menus |
| `--line` / `--line-2` | `rgba(53,240,255,.16)` / `.38` | bordas em repouso / ativas |
| `--ink` | `#dceaf8` | texto primário |
| `--ink-2` | `#9fb3c8` | texto secundário |
| `--ink-3` | `#6b7f96` | rótulos, unidades |
| `--neon` | `#35f0ff` | acento primário, foco, atividade |
| `--violet` | `#a855f7` | acento do kernel/perfil |
| `--lime` | `#8fff5a` | estado saudável, LED OK |
| `--amber` | `#ffcf5a` | aviso (70–92% do orçamento) |
| `--crit` | `#ff5470` | crítico / falha |
| `--hot` | `#ff3d7f` | marca, boot, splash |
| `--r-1…--r-5` | `2 / 4 / 6 / 10 / 14 px` | raios; janelas usam `--r-4` |
| `--sp-1…--sp-8` | `4 / 8 / 12 / 16 / 24 / 32 / 48 / 64 px` | espaçamento (base 4) |
| `--blur-1…3` | `12 / 18 / 24 px` | degraus de blur |
| `--sh-1/2/3` | elevações | `inset` + sombra externa em três alturas |
| `--z-void…--z-toast` | 0/10/20/50/60/80/90 | escala de empilhamento |
| `--t-90/160/240/420` | durações | micro, hover, transição, entrada de janela |
| `--e-out` | `cubic-bezier(.2,.8,.2,1)` | entrada e foco |
| `--e-inout` | `cubic-bezier(.4,0,.2,1)` | mudanças de estado |

Tipografia:

| Papel | Família | Tamanho / peso / tracking |
|---|---|---|
| Marca | `system-ui` 800 | 26 px / `letter-spacing: 8px` |
| Título de janela | `system-ui` 600 | 13,5 px / `.2px` |
| Corpo / UI | `system-ui` 400 | 13,5 px / linha 1,55 |
| Rótulo | `--mono` 600 | 10 px / `letter-spacing: 1,8px` / CAIXA ALTA |
| Terminal / código | `--mono` 400 | 12,5 px / linha 1,5 |
| Dados numéricos | `--mono` 500 | `font-variant-numeric: tabular-nums` |

Regra de números: **toda métrica usa `tabular-nums`** — dígitos que não dançam são a
diferença entre um HUD profissional e um amador. Unidades em `--ink-3`, valor em `--ink`.

---

## 4. Cor e semântica de dados

| Faixa | Cor | Exemplo |
|---|---|---|
| Saudável (< 70% do orçamento) | `--lime` | 58 FPS, 41% de heap |
| Atenção (70–92%) | `--amber` | 12,4 / 16,6 ms de frame |
| Crítico (> 92%) | `--crit` | 1,1 GB de 1,2 GB |
| Inativo / sem sinal | `--ink-3` + `N/D` | métrica não exposta |
| Atividade do worker | `--neon` pulsando em 1,6 s | tick do kernel |
| Concluído | `--lime` estático | boot finalizado |

Nunca usar vermelho em texto de conteúdo — só em métrica/erro. Nunca usar cor como
único portador de informação: sempre acompanha rótulo textual ou forma.

---

## 5. Movimento

| Interação | Duração / curva | Detalhe |
|---|---|---|
| Hover de botão/LED | `90 ms` `--e-out` | borda + fundo + LED |
| Abrir janela | `240 ms` `--e-out` | `scale(.97) → 1` + `opacity 0 → 1`, origem no ponto de clique |
| Fechar janela | `160 ms` | inverso, mais rápido que a abertura |
| Minimizar | `240 ms` | interpola para a posição do item no dock (*genie* linear, sem bezier composto) |
| Maximizar | `240 ms` | geometria interpolada; `backdrop-filter` desliga no meio do caminho |
| Arrastar | 1:1 | sem inércia artificial; `will-change: transform` só durante o gesto |
| Snap preview | `90 ms` | retângulo em `--neon` a 8% + borda 1 px |
| Toast | entrada `160 ms`, saída `240 ms` | saída mais lenta para leitura |
| Botão de boot | `420 ms` | pulso único, nunca em laço |

`prefers-reduced-motion: reduce` → todas as durações viram `1 ms`, `drift` desliga,
transições de janela viram corte. Nada de conteúdo depende de animação para ser entendido.

---

## 6. Componentes (anatomia)

### 6.1 Boot / Splash
Logo pixel-traçado (`SEKTOR` em grade 5×7 gerada em canvas), barra de progresso fina de 2 px,
sequência de mensagens **reais** de inicialização (probe de SAB → WebGPU → OPFS → workers).
Falha em qualquer probe vira linha `[WARN]` no log e o boot continua em modo degradado.
Duração mínima 900 ms (evita "flash"), máxima 4 s.

### 6.2 Desktop (VÉU)
Grade + aurora + scanlines, ícones em grade de 96 px (atalhos: Terminal, Debian, Arquivos, Jogo, PS2, Configurações).
Clique direito abre menu contextual com `--glass-3`. Duplo clique abre a janela.

### 6.3 Dock
Barra inferior centrada, `--r-4`, `--blur-2`, altura 62 px. Ícones de 38 px desenhados em SVG
(traço 1,5 px, `currentColor`). Ícone ativo: LED de 4 px em `--neon` sob o ícone. Hover: elevação 4 px em 160 ms.
Instância aberta mostra "trilho" de 2 px. Nunca mais de 12 ícones sem paginação.

### 6.4 Barra superior (Status)
Altura 34 px, borda inferior 1 px. Esquerda: marca + sessão. Direita: relógio, `TRANSPORTE: RING/SAB|MESSAGE`,
`BACKEND: WEBGPU|WEBGL2`, LED de integridade. Clique em qualquer token abre o HUD na seção correspondente.

### 6.5 Janela
Chrome de 34 px: LED de estado, título (truncado com ellipsis), e três ações (minimizar, maximizar, fechar).
Foco eleva `--z-` e troca `--glass-1` → `--glass-2`. Redimensionamento por 8 alças invisíveis de 6 px.
Arrastar pelo título; arrastar para o topo = maximizar; arrastar para as laterais = *snap* de meia tela.
Botão fechar em repouso é `--ink-3`; no hover vira `--crit` **apenas** no traço, sem preencher.

### 6.6 Barra de tarefas (taskbar)
Faixa inferior de 30 px listando janelas abertas com título curto e LED de atividade.
Clique foca/minimiza. Ocupa todo o rodapé e é deliberadamente discreta (opacidade 70%).

### 6.7 HUD de telemetria
Painel `--glass-3`, largura 306 px, três seções: **SISTEMA** (FPS, frame P50/P95, heap),
**SUBSISTEMAS** (kernel, engine, I/O com ms e MB/s por worker), **DISCO** (usado/cota com barra).
Cada linha: rótulo (`--ink-3`, mono 10 px) · valor (`tabular-nums`) · barra de 3 px.
Atualização **2 Hz** (não por quadro): dados que pulsam a 60 Hz são ilegíveis e custam caro.
Botão `ESC` fecha; `F1` alterna. Sparkline de FPS com janela de 120 amostras.

### 6.8 Painel de configurações
Abas: **GRÁFICOS** (backend, escala de resolução, sombras, partículas, teto de FPS),
**DESEMPENHO** (perfil `baseline/balanced/ultra`, DRS on/off, prioridade),
**ARMAZENAMENTO** (gauge OPFS, eviction, exportar/importar save),
**SISTEMA** (reiniciar workers, limpar cache, modo diagnóstico).
Cada controle tem um **efeito visível e imediato** ou está desabilitado com motivo em *tooltip* — nunca um botão que não faz nada.

### 6.9 Terminal
Grade de caracteres, fundo `--void-0` a 88%, texto em `--ink`, prompts em `--neon`.
Cursor em bloco com blink de 1 s (desligado em `prefers-reduced-motion`).
Histórico fixo de 200 linhas (`textContent`, sem HTML). Comandos desconhecidos respondem com
mensagem clara e sugerem `help`. Nunca simula comando que não implementa.

### 6.10 Arquivos (File Manager)
Duas colunas: árvore do VMFS à esquerda (240 px), listagem à direita. Ícones por tipo.
Mostra caminho, tamanho e data. Ações: criar pasta, criar arquivo, apagar, renomear —
todas **reais** no VMFS/OPFS, com *undo* por 5 s no toast.

### 6.11 Toast
Canto inferior direito, largura máx. 320 px, empilhamento de 3, auto-dismiss 4 s
(erros: 8 s e fechamento manual). Faixa de cor de 2 px à esquerda comunica severidade.

### 6.12 Command palette (`Ctrl+K`)
Busca fuzzy sobre ações e janelas. Setas navegam, `Enter` executa, `Esc` fecha.
Mostra o atalho à direita de cada ação. É o atalho de teclado de tudo que existe na UI.

---

### 6.13 Navegador (motor próprio)

Duas superfícies convivem na mesma janela, e a diferença é dita na barra de estado:

| Superfície | Tratamento | Regra |
|---|---|---|
| Viewport gráfico (canvas) | fundo branco do documento, sem moldura interna | a página é a página: o cromo do NÚCLEO OS não entra nela. O canvas fica com `cursor: default`, virando `pointer` **só** sobre link |
| Barra de ferramentas | mesma anatomia do §6.5 (`.btn.sm`, altura 26 px, raio 8 px) | voltar/avançar/recarregar, endereço, modo, zoom, salvar |
| Barra de metadados | `--mono` 10,5 px, `--ink-3` | `status · bytes · ms · layout · pintura · links · imagens · %` — cada número tem origem declarada |
| Botão `notas N` | pílula neutra; vira acento (`--neon`) quando N > 0 | é o compromisso de honestidade em forma de controle: quando a página pede algo que o motor não faz, o contador sobe e o painel lista com números |
| Painel de notas | `rgba(6,11,18,.72)`, `--mono` 10,5 px, máximo 132 px com rolagem | sintaxe de lista com `•`, uma nota por linha, sem jargão |
| Modo texto | mesmos tokens do terminal (§6.9): linhas densas, links `--neon` sublinhados | alternativa de leitura e de rede lenta, não uma degradação envergonhada |

Micro-interações da janela: o zoom mantém o centro da viewport (não “pula” para o canto); a
rolagem por roda, arrastar e teclado compartilham o mesmo estado; o hover de link promove o
destino à barra de status sem tooltip flutuante — informação onde o olho já está.

**Nada de esqueleto falso:** enquanto a página carrega, a barra de estado muda para `buscando …`
com a classe `.busy` (acento) em vez de exibir uma animação de carregamento que não corresponde a
progresso real. Sem progresso medido, sem indicador de progresso.

#### 6.13.1 Página de erro (o estado que não pode ser invisível)

| Elemento | Tratamento | Regra |
|---|---|---|
| Fundo | `#0a0f16` (mesmo das páginas locais do sistema) | o erro é do sistema, não do site: a cor diz isso |
| Faixa lateral | 4 px, `#ff8a8a`, altura total | visível antes de qualquer leitura |
| Título | `600 17px sans`, `--amber` | "Não foi possível abrir" — frase, não código |
| URL | `12.5px monospace`, `--ink-2` | o endereço exato, com o esquema |
| Motivo | `13px sans`, `--ink` | a string crua da rede (`ECONNRESET`, `tempo esgotado (6000 ms)`) — nunca "algo deu errado" |
| Rodapé | `--ink-3` + acento `--neon` | como resolver: `about:rede` para medir o que a rede alcança |
| Painel `notas` | recebe a mesma mensagem | o botão de notas deixa de ficar vazio justamente quando há o que dizer |

O mesmo conteúdo aparece no modo texto (DOM) e, sem contexto 2D, o app **troca para o modo texto**
automaticamente, porque é o único caminho em que a mensagem é visível.

#### 6.13.2 Páginas locais e a sondagem de rede

- `about:inicio` — hub: o que o motor faz, o que não faz, atalhos e os exemplos que **esta** rede
  alcança (GitHub/npm), com o convite para medir em vez de tentar.
- `about:teste` — demonstração do motor com zero requisições: cabeçalhos, listas, citação, tabela
  `Camada/Arquivo/Papel`, negrito/itálico/código e um bloco `display:flex` que vira nota.
- `about:rede` — tabela medida por `/api/probe`: ✓/✗ por destino, com `status` e milissegundos; sem
  sondagem feita, a página diz que nada foi medido em vez de mostrar tabela vazia.
- Botão **Rede** na barra dispara a sondagem e resume em uma frase: `sondagem: 3/6 destinos
  responderam · 3 bloqueados por esta rede`.

### 6.14 Cidade (motor 3D)

A janela é um viewport, não um painel: o cromo é o mínimo possível e o que sobra é
informação de estado. Anatomia, de cima para baixo:

| Faixa | Tratamento | Conteúdo |
|---|---|---|
| Viewport (canvas) | fundo `#01040a` (o mesmo `clearColor` da cena), sem borda interna, `outline: none` | céu em gradiente, chão com grade neon nas vias, cidade com pódio/corpo/telhado, tráfego em 3 tipos de veículo |
| Linha de estado | `--mono` 10,5 px, `--ink-3`, altura 26 px, padding 6/10 | `<BACKEND> · N instâncias · N desenhos · X ms render · N fps · escala Q× · DRS ativo · tráfego N (w-engine) · N volumes acima do teto` |
| Faixa de aviso | `#ffcf5a` (`--warn`), mesma tipografia, `display:none` quando não há o que dizer | o motivo exato de o renderizador ter mudado de degrau |

Regras de honestidade visual da janela:

1. **O backend é dito, não presumido.** `WEBGL2`, `SOFTWARE 2D` ou `SEM DESENHO` abrem a linha de
   estado — a mesma palavra que o HUD repete na nota de VRAM (`Cidade: render em software …`).
2. **Faixa âmbar em vez de tela preta.** Se o degrau caiu, a faixa explica em uma frase; o motivo
   nunca fica escondido atrás de um canvas escuro.
3. **O que não coube é declarado.** Quando o teto de objetos do modo software corta volumes, a
   linha de estado mostra quantos. Um quadro incompleto que se apresenta como completo é mentira;
   um quadro incompleto que diz o que faltou é instrumentação.
4. **Falha de quadro congela com legenda.** Ao primeiro erro de GL o laço para, a linha de estado
   vira `laço interrompido` e a faixa carrega o motivo — em vez de congelar o último quadro como
   se estivesse tudo bem.
5. **Tráfego é do motor, não decorativo.** O número entre parênteses vem do `w-engine`
   (snapshot lock-free). Sem worker, o motor é declarado indisponível e **nenhum veículo é
   inventado** para preencher a tela.
6. **Nada de VRAM inventada.** A janela não mostra "VRAM usada": a API não expõe. O que ela
   mostra (instâncias, desenhos, escala, ms) é medido no laço.

Interação: arrastar gira a câmera (`yaw`/`pitch`), `W A S D` deslocam, `Shift` acelera,
`←`/`→` giram; o DRS reduz a escala de render quando o P95 do quadro passa de 18 ms e devolve
devagar; o teto de FPS do painel de configurações (§6.8) é obedecido por temporização, não por
descarte de quadro — o custo mostrado é o custo real.

Composição inicial: câmera na **via** (eixo `x = 20`, o mesmo centro de faixa do motor), a 5 m
de altura, olhando para o centro da cidade a 210 m — enquadramento de rua, não de drone. O
contrato com o motor é visual: se a cidade não seguir a grade viária, o tráfego cruza prédio.

### 6.15 Jogos (emulador de PS2)

A janela é um palco preto com o cromo mínimo — o conteúdo é a tela do console, não
o sistema. Anatomia, de cima para baixo:

| Faixa | Tratamento | Conteúdo |
|---|---|---|
| Barra | mesma anatomia do §6.13 (`--sp-2`, altura 26 px, `.btn.sm`), com quebra de linha | Escolher ISO do computador · seletor de ISOs do PC virtual · Montar do PC virtual · Iniciar · Parar · Tela cheia |
| Palco | `flex:1`, fundo `#000`, `overflow:hidden` | o iframe do núcleo Play! desenha a tela do jogo (sem moldura, sem sobreposição) |
| Linha de estado | `--mono` 10,5 px, `--ink-3`, borda superior | `PS2 · Play! · <disco> · <tamanho> · ISO9660 · rótulo "<n>" · <setores> · origem <PC virtual|computador> · <leituras> leituras · <bytes> · última <ms> · <fps> fps · <situação>` |
| Cartão de aviso | `rgba(6,11,18,.94)`, `--amber`, título 11,5 px + corpo 11 px até 74ch | o motivo exato de não dar para emular e como resolver |

Regras de honestidade da janela:

1. **Ambiente avaliado antes da interface.** Se falta `SharedArrayBuffer`, se a
   página não está isolada ou se não há WebGL2, o cartão aparece **e** os controles
   ficam desabilitados (`[disabled]` com opacidade .32, §6.13). Nunca existe botão
   que só pode falhar.
2. **Disco verificado antes de qualquer thread.** ISO sem descritor ISO9660 é
   recusada com o tipo e a assinatura encontrados — não se cria VM para descobrir
   isso 40 s depois.
3. **Falha do núcleo vira cartão.** Erro do Play!, timeout de inicialização ou
   falha ao carregar o adaptador: mensagem na frente do palco + toast. Tela preta
   silenciosa é o pior resultado possível e está proibido por contrato.
4. **Estado medido, não estimado.** FPS vem do próprio núcleo; leituras e bytes
   vêm do contador do disco; "última leitura" é cronometrada no `read`. Sem
   medida, o campo não aparece.
5. **O que o sistema não faz, ele diz.** Baixar jogos, catálogo do launcher e save
   state não existem aqui — então não há botão cinza "em breve" fingindo roadmap.

Micro-interações: a janela **foca o palco** ao iniciar (teclado vai para o jogo);
"Tela cheia" pede fullscreen do palco e degrada com aviso quando o navegador
recusa; fechar a janela encerra núcleo, pthreads e áudio antes de sair.

## 7. Micro-interações

| Gesto | Feedback |
|---|---|
| Hover no dock | ícone sobe 4 px; LED acende; rótulo em *tooltip* após 400 ms |
| Clique em app do dock | janela abre a partir da posição do ícone (origem de transform) |
| Arrastar janela para borda | retângulo de snap em `--neon` a 8%; soltar aplica meia tela |
| Foco em campo | borda sobe para `--line-2` + `outline` de 1 px a 2 px de deslocamento |
| Botão pressionado | `transform: translateY(1px)` por 90 ms — *tato* digital |
| Métrica em alerta | a barra do HUD muda de cor e o LED correspondente pulsa a 1,6 s (uma vez por transição) |
| Erro de worker | LED vermelho fixo + linha de log no terminal + toast com o motivo |
| Boot concluído | LED da barra de status passa a `--lime`; sem confete, sem som |

---

## 8. Linguagem de dados

- Números com 1 casa decimal para ms/MB/s, inteiros para FPS/entidades.
- Unidades sempre visíveis (`58 fps`, `12,4 ms`, `312 MB/s` — locale pt-BR: vírgula decimal).
- Percentual sempre com barra; valor absoluto sempre com unidade.
- Latência mostrada como **P50 / P95**, nunca média sozinha: média esconde o travamento.
- Nada de "score" ou métrica agregada inventada — o HUD não gamifica desempenho.

---

## 9. Acessibilidade

| Requisito | Regra |
|---|---|
| Contraste | Texto de corpo ≥ 4,5:1 e rótulos ≥ 3:1 medidos sobre a **cor composta** do vidro (vidro a 84% sobre `--void-0`), não sobre o token isolado |
| Foco | `:focus-visible` com anel de 2 px em `--neon` e deslocamento de 2 px; nunca `outline: none` sem substituto |
| Teclado | Todo controle alcançável por `Tab`; `Ctrl+K` abre a paleta; `F1` HUD; `Esc` fecha a camada superior |
| Semântica | `role="dialog"` + `aria-modal`, `aria-live="polite"` para telemetria crítica, `aria-label` em todo ícone-botão |
| Movimento | `prefers-reduced-motion` desliga animações e o drift do fundo |
| Contraste forçado | `@media (prefers-contrast: more)` eleva bordas para `--line-2` e remove translucidez |
| Zoom | Layout íntegro a 200% de zoom; janelas viram pilha vertical abaixo de 820 px |
| Alvo de toque | ≥ 40 px em telas com ponteiro grosso (`@media (pointer: coarse)`) |
| Som | Nenhuma informação depende de áudio |

---

## 10. Responsivo e entrada

| Classe | Largura | Comportamento |
|---|---|---|
| Desktop | > 1180 px | janelas flutuantes livres, HUD ancorado à direita |
| Laptop | 820–1180 px | HUD recolhido por padrão (só LED), dock 56 px |
| Tablet | 560–820 px | janelas empilháveis em coluna, snap só por botão |
| Telefone | < 560 px | uma janela por vez em tela cheia, dock com 5 apps, HUD em *sheet* |

Entrada: mouse (primário), teclado (atalhos de §6.12), **gamepad** via `Gamepad API` — mapeamento
analógico direto para o motor do jogo e para o runtime do console; toque com gestos de
arrastar/redimensionar com área ampliada.

---

## 11. Governança do design system

1. **Tokens são a única fonte.** Componente que usa `#35f0ff` literal em vez de `var(--neon)` não passa de revisão.
2. **Toda superfície nova** precisa declarar em qual das três camadas de matéria ela vive (§2) e o custo de blur.
3. **Toda métrica nova** precisa declarar fonte, custo e o texto de `N/D` quando indisponível.
4. **Nada entra na UI sem instrumentação** — botão sem efeito é bug, não rascunho.
5. Verificação visual por captura (`npm run test:os`, Playwright) e por leitura do HUD em teste automatizado.

---

## 12. Mapa componente → arquivo (protótipo)

| Componente | Arquivo |
|---|---|
| Tokens | `css/tokens.css` |
| VÉU, janelas, dock, HUD, modais | `css/os.css` |
| WM (mover, redimensionar, snap, foco, z-order) | `js/core/wm.js` |
| Registro de apps + janelas de conteúdo | `js/apps/*.js` |
| Terminal + VMFS | `js/apps/terminal.js`, `js/core/vfs.js` |
| HUD | `js/ui/hud.js` |
| Boot e probes | `js/boot.js` |
| Barramento | `js/core/ipc.js` |
| Eventos de UI e toasts | `js/core/bus.js`, `js/ui/toast.js` |
| Navegador: cascata de CSS | `js/core/css.js` |
| Navegador: layout (caixas e linhas) | `js/core/layout.js` |
| Navegador: pipeline da página | `js/core/srcpage.js` |
| Navegador: pintura e hit-test | `js/apps/gfx/paint.js` |
| Navegador: imagens | `js/apps/gfx/images.js` |
| Navegador: janela e interação | `js/apps/browser.js` |
| Cidade: geometria e cena | `js/apps/game.js` (`makeCubeData`, `buildCity`) |
| Cidade: caminho WebGL2 (shaders, instância) | `js/apps/game.js` (`iniciarGl`, `desenharGl`) |
| Cidade: caminho software 2D | `js/apps/game.js` (`desenharSoftware`) |
| Cidade: seleção do pintor (teto por proximidade) | `js/apps/game.js` (`selecionarProximos`) |
| Cidade: clipe de plano próximo | `js/apps/game.js` (`recortarProximo`, `linhaEmTela`) |
| Cidade: telemetria do renderizador | `js/main.js` (`reportGame`) → `js/ui/hud.js` |
| Cidade: quadro de evidência fora do navegador | `tools/render-cidade.mjs` + `tools/engine-worker-host.mjs` |
| Jogos: portão de ambiente | `js/apps/jogos.js` (`avaliarAmbiente`) |
| Jogos: fontes de disco e verificação ISO9660 | `js/core/disc.js` |
| Jogos: leitura por faixa no VMFS | `js/core/vfs.js` (`readRange`) |
| Jogos: janela e ciclo do emulador | `js/apps/jogos.js` |
| Jogos: núcleo Play! (herdado, verificado no boot) | `../emulator/*` servido por `/emulator/*` em `server.js` |

O protótipo é a **prova executável** deste documento: os valores citados aqui são os
valores em `tokens.css`, e as regras de §2.1 (teto de área, 3 superfícies, fallback)
estão implementadas — não são intenção.
