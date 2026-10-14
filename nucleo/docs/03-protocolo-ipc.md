# NÚCLEO OS — Protocolo `ipc.ring` (normativo)

Referência de implementação: `js/core/ipc.js`. Cobertura: §3 de [`00-arquitetura.md`](00-arquitetura.md),
`tests/core.mjs` (seções 1, 2, 3, 8 e "anel de quadro inteiro") e `tests/worker-fixture.mjs` (worker real).
Este documento é **normativo**: se o código divergir daqui, o código está errado — ou este documento é
atualizado junto com um teste que prove o novo comportamento.

---

## 1. Objetivo e limites

O barramento existe para uma única coisa: mover trabalho entre threads **sem alocar** e **sem bloquear o
quadro**. Ele não é um sistema de mensagens genérico:

- 1 produtor e 1 consumidor por canal (SPSC). Dois escritores no mesmo canal é violação de contrato.
- Transferência de posse (transferables) **não** acontece aqui; buffers grandes vão por `postMessage`
  com `SharedArrayBuffer` de dados + opcode de aviso no anel (padrão "sino + baú").
- Nada de `await`/promise no consumidor de estado: o quadro **consome agora ou descarta**.

---

## 2. Layout de memória

Cada canal é um `SharedArrayBuffer` único:

```text
offset 0      : Int32Array(32)  control   — 128 bytes
offset 128    : Uint8Array(cap) payload   — frames alinhados a 16 B
```

### 2.1 Bloco de controle (índices do `Int32Array`)

| Índice | Nome | Significado |
|---|---|---|
| 0 | `MAGIC` | `0x53454354` ("SECT") — valida `attachChannel` |
| 1 | `HEAD` | posição de leitura (avançada só pelo consumidor) |
| 2 | `TAIL` | posição de escrita (avançada só pelo produtor) |
| 3 | `CAP` | capacidade de `payload` em bytes (cópia do valor real) |
| 4 | `FRAMES` | total de frames publicados (monotônico) |
| 5 | `DROPS` | frames recusados por falta de espaço |
| 6 | `WAITS` | vezes que um leitor esperou (`waitAsync`/`wait`) |
| 7 | `BYTES` | total de bytes de payload publicados |
| 8 | `ALIVE` | 1 = canal vivo, 0 = encerrado |
| 9 | `C_WRITTEN` | contador monotônico de publicações |
| 10 | `C_READ` | contador monotônico de consumos |
| 11..31 | — | reservado |

**Invariante de vazio:** `C_READ === C_WRITTEN`. Nunca use `HEAD === TAIL`: depois de um *wrap* esses
valores podem coincidir com o buffer cheio. Esse foi um bug real, encontrado pelo teste de wrap e
corrigido por esses dois contadores.

### 2.2 Frame

```text
u32 len    — bytes de payload (payload pode ser 0)
u16 opcode — tabela §4
u16 flags  — bit 0 reservado, bit 1 = WRAP (ver §3.3)
payload[len]
padding    — até múltiplo de 16
```

O cabeçalho fica no início do quadro e o *padding* até 16 B é zerado de forma determinística,
para que o conteúdo do buffer não vaze entre consumidores nem dependa de memória não inicializada.

---

## 3. Publicação e consumo

### 3.1 Publicar (`writer.push(op, bytes)`)

1. `len = bytes.length`; `frame = 8 + len` alinhado a 16.
2. `if (len > cap - 8 - 32)` → `drops++` e `false` (frame maior que o canal; acima disso use
   "sino + baú": o payload vai por `postMessage` e o anel leva só o aviso).
3. `frame = 8 + align16(len)`; `head`, `tail` e `free = cap - used - 32` são lidos do controle.
4. **Regra de wrap:** se `at + frame > cap - 32`, o quadro precisa voltar ao início. Isso só é legal
   quando `at !== 0`, a região livre dá a volta (`head <= at`) e `frame <= head`; caso contrário
   `drops++` e `false`. Autorizado o wrap: escreve `len = 0xFFFFFFFF` + `flags.bit1 = 1` em `at`,
   zera `at` e segue.
5. `free < frame` → `drops++` e `false` ("canal cheio").
6. Escreve cabeçalho, payload (`set` de uma vez) e *padding* zerado até `frame`.
7. Publica, **nesta ordem**: `TAIL = (at + frame) % cap` → `FRAMES++` → `BYTES += len` →
   `C_WRITTEN++` → `notify(C_WRITTEN, 1)`.

> A ordem do passo 7 é normativa. Os bytes precisam estar escritos antes de `TAIL` avançar, e o
> incremento de `C_WRITTEN` (sequencialmente consistente) é a barreira que o consumidor observa.
> Se `C_WRITTEN` subisse antes de `TAIL`, o consumidor leria um quadro com posição antiga.

### 3.2 Consumir (`reader.drain()`)

- Laço com teto de **4096 frames por passagem** (evita monopolizar a thread principal).
- Se `C_READ === C_WRITTEN` → vazio, retorna 0.
- Marcador de WRAP: salta `HEAD` para 0 e continua, sem emitir mensagem.
- `len` acima do limite do canal, `len` maior que a *scratch* ou `HEAD` fora de faixa →
  `corrupt++`, `HEAD` volta a 0 (ressincronização) e o frame é descartado em silêncio,
  sem emitir nada para o app. `reader.corrupt` é a métrica de diagnóstico.
- Quadro válido: copia para a *scratch* reutilizável, avança `HEAD` e incrementa `C_READ`
  (um incremento por frame), então chama `onMessage(op, view, len)`.
- O consumidor recebe uma **view** sobre a scratch — válida só até o próximo `drain()`.
  Guardar a view é bug (e o teste de integridade de bytes existe para pegar isso).

### 3.3 Marcador de WRAP

```text
len = 0xFFFFFFFF, flags.bit1 = 1, sem payload
```

Ao ver o marcador, o leitor **não emite mensagem**: apenas salta `HEAD` para 0 e continua. O produtor
nunca escreve um frame que atravesse o fim do buffer — assim o consumidor jamais precisa de cópia
em duas partes (nada de `slice` + `slice` no caminho quente).

### 3.4 Espera

| Contexto | Primitiva | Regra |
|---|---|---|
| Thread principal | `drain()` a cada quadro | **proibido** `Atomics.wait` (bloqueia o compositor) |
| Worker | `await reader.waitAsync(ms)` | `Atomics.waitAsync` (mantém microtasks vivas) |
| Worker, fallback | `setTimeout` ≤ 8 ms | navegador sem `waitAsync` |
| Espera bloqueante | `sendBlocking()` | apenas em `Link.request/readBlock/writeBlock`, com teto de 8 s |

`Atomics.wait` **síncrono** não é usado em nenhum laço de worker: ele impediria o retorno de handlers
`async` (leitura de OPFS, por exemplo) — o worker pareceria travado. O laço canônico é:

```js
link.reader.pump(onIdle);   // while (alive) { await waitAsync(); drain(); if (vazio) onIdle(); }
```

### 3.5 Backpressure

`push()` **nunca** espera indefinidamente. Sem espaço: `drops++` e `false`. O chamador decide —
e no caminho de quadro a decisão já está tomada: descartar o tick e registrar a métrica. Telemetria
perdida é aceitável; quadro perdido não.

---

## 4. Opcodes

| Código | Nome | Direção | Payload |
|---|---|---|---|
| `0x01` | `HB` | worker → main | batimento |
| `0x10` | `TICK` | main → engine | `u16 dt_ms`, `u32 input_bits` (6 B) |
| `0x11` | `TICK_REPORT` | engine → main | `u16 ms_sim ×100`, `u16 ms_ia ×100`, `u32 entidades`, `f32 tick_max` |
| `0x12` | `CFG` | main → worker | JSON curto de configuração |
| `0x20` | `BLK_READ` | main → io | `u32 id`, `u64 offset`, `u32 len` |
| `0x21` | `BLK_DATA` | io → main | bytes + `u32 id` |
| `0x22` | `BLK_WRITE` | main → io | `u32 id` + bytes |
| `0x28` | `FS_OP` | main → io | JSON curto (list/stat/mkdir/…) |
| `0x29` | `FS_RES` | io → main | JSON curto |
| `0x30` | `SYS_EXEC` | main → kernel | comando JSON |
| `0x31` | `SYS_OUT` | kernel → main | saída JSON |
| `0x40` | `STAT_REQ` | main → worker | — |
| `0x41` | `STAT` | worker → main | `u16 code`, `u16 count`, `f32[count]` |
| `0x50` | `LOG` | worker → main | texto |
| `0x60` | `PING` | qualquer | — |
| `0x61` | `PONG` | qualquer | — |

**Regra de ouro dos opcodes:** binário de tamanho fixo para o caminho quente (`TICK`, `TICK_REPORT`,
`STAT`, `BLK_*`); JSON **apenas** em caminhos frios (≤ 10 Hz) — e o código diz isso em comentário,
em vez de esconder a inconsistência.

### 4.1 Estatísticas (`STAT`)

`u16 code` (0 = canônico) · `u16 count` · `f32[count]`, índice definido em `js/core/wire.js`:

```text
0 FRAME_MS · 1 FRAME_P95 · 2 FPS · 3 SIM_MS · 4 AI_MS · 5 KERNEL_MS · 6 IO_MS · 7 IO_MBPS
8 ENTITIES · 9 HEAP_MB · 10 DISK_MB · 11 DISK_QUOTA_MB · 12 TICKS · 13 TICK_MAX_MS · 14/15 EXTRA
```

Slot não preenchido é `NaN` — e o HUD imprime `N/D` com o motivo. **Nunca** preencha com 0 para
"ficar bonito": zero é uma medida, ausência de medida é outra.

---

## 5. Transporte alternativo (`MESSAGE`)

Sem `SharedArrayBuffer` (página não isolada), `PortWriter/PortReader` oferecem **a mesma API**
(`push`, `drain`, `stats`, `waitAsync`, `pump`) sobre `MessageChannel`. Diferenças declaradas:

| Aspecto | `RING` (SAB) | `MESSAGE` (port) |
|---|---|---|
| Latência de wake | notify + `waitAsync` (~µs) | fila de tarefas (ms) |
| Alocação por frame | zero (view) | uma cópia por mensagem |
| Caminho quente | sim | sim, com teto de taxa |
| Exibição no HUD | `RING/SAB` | `MESSAGE` |

O resto do sistema **não** ramifica por transporte: quem escolhe é `createChannel()`/`ipc.create()`.
Toda a UI lê `link.transport` só para exibir — nunca para mudar comportamento.

---

## 6. Ciclo de vida

1. `Link.connectWorker(worker, name)` cria os canais e transfere `a2b`/`b2a` no `postMessage`.
2. O worker responde `{ type: 'nucleo-link-ready', name }`; sem isso, timeout de 6 s e erro explícito.
3. `ALIVE = 0` + `close()` encerram o laço `pump` na outra ponta.
4. Evento `nucleo-shutdown` fecha todos os links conhecidos (parada limpa, sem worker órfão).

---

## 7. Contrato de integração dos workers (não negociável)

`acceptWorkerLink(self, { onReady })` deve encaminhar **todo** frame recebido para `link.ingest(op, view, len)`
antes de qualquer callback opcional. Um `RingReader` que consuma frames sem os entregar ao `Link` os
descarta silenciosamente — foi exatamente o defeito encontrado pelo teste com `worker_threads`, em que a
resposta chegava ao anel e nenhum handler disparava. Correção em `js/core/link.js`; regressão coberta
por `tests/core.mjs` §8.
