# SECTOR 3 — GTA San Andreas PS2 / Play! WASM

Launcher/painel de emulação PS2 com o núcleo **Play!** em WebAssembly, leitura de disco por
**HTTP Range** (sem baixar a ISO inteira) e instalação sob demanda do
**GTA San Andreas — PS2 USA v3.00** a partir do Internet Archive.

> Nenhum jogo é distribuído neste repositório. A ISO é buscada sob demanda, apenas quando você clica.

## Rodar pelo GitHub

```sh
git clone https://github.com/venomtids/ps2navegator.git
cd ps2navegator
npm ci
npm start
```

Depois abra `http://localhost:3000`.

Com Node.js 22+, execute `npm ci && npm start` na pasta do projeto.
Abra `http://localhost:3000` em uma aba do Chrome/Edge atual, com aceleração gráfica habilitada.
Não abra `index.html` por `file://`: WASM, workers e isolamento exigem o servidor.

## Testar sua ISO

1. Em **Selecionar ISO do computador**, escolha sua ISO de PS2 não compactada.
2. Clique **Montar ISO local**, depois **Iniciar Play!**.
3. Clique dentro da tela para direcionar teclado e liberar áudio.
4. Consulte os eventos e o FPS. VM inicializada não significa que o jogo chegou ao menu.
5. **Parar** encerra workers, áudio e documento do emulador. A ISO continua selecionada; pode iniciar novamente.

O arquivo local não é enviado ao servidor. A leitura usa `File.slice()` e um cache de 8 MiB.
A memória do núcleo WASM é adicional e pode ser significativamente maior. Não há ampliação real de RAM/GPU.

## GTA configurado — USA v3.00 / PS2

Fonte escolhida pelo usuário:
https://archive.org/details/grand-theft-auto-san-andreas-usa-v-3.00_202401

- Arquivo: `Grand Theft Auto - San Andreas (USA) (v3.00).iso`
- Tamanho publicado: **4.517.036.032 bytes** (4,52 GB / 4,21 GiB).
- `SYSTEM.CNF` verificado no conteúdo disponibilizado pelo Archive:
  `BOOT2 = cdrom0:\SLUS_209.46;1`, `VER = 3.00`, `VMODE = NTSC`.
- Fonte, tamanho e SHA-1 ficam em `game-config.json`.
- Nenhum jogo é incluído no ZIP do projeto. Abrir o painel só consulta configuração/status; não inicia download da ISO.

### Dois botões prontos

**Jogar por setores:** monta o arquivo configurado e solicita o boot do Play!. Apenas os trechos requisitados pelo núcleo são buscados no Archive. É o modo indicado para não esperar o download inteiro e não armazenar uma ISO completa.

**Baixar e iniciar GTA:** baixa os 4,52 GB para `games/gta-sa-ps2/game.iso`, verifica tamanho, SHA-1 publicado e cabeçalho ISO9660, e solicita o boot automaticamente. Nas próximas execuções reutiliza o arquivo instalado. O hash verifica consistência com o metadado publicado, não garante confiabilidade do uploader. A origem atual já é ISO; não precisa de extração nem senha.

Os dados são gravados **na máquina em que o servidor Node está rodando**, não necessariamente no dispositivo do navegador. Reserve pelo menos aproximadamente 5,1 GB livres. O botão de cancelamento interrompe o download e limpa os arquivos parciais. Após interrupção do processo, arquivos parciais são removidos na próxima inicialização; não há retomada parcial de downloads.

O campo avançado aceita outro link direto HTTPS autorizado nos hosts permitidos. Para ZIP/7z, o instalador procura exatamente uma ISO e extrai apenas seu conteúdo para um destino fixo, sem usar caminhos do pacote para gravar arquivos. Prioriza `7zz`/`7z` do sistema e tem fallback `7zip-bin`; para um extrator atualizado, instale 7-Zip e configure `SEVEN_ZIP`. Pacotes exigem espaço adicional para arquivo compactado + ISO. Não há bypass de login, CAPTCHA ou bloqueios.

**Não foi validado gameplay desta ISO no Play!.** Confirmamos plataforma PS2, configuração de boot e leitura HTTP Range da origem real pelo backend. Compatibilidade, áudio e desempenho no jogo continuam dependentes do núcleo e do dispositivo.

Use somente conteúdo que tenha autorização para utilizar. Ao parar ou recarregar, o estado de emulação é perdido: saves persistentes não estão implementados.

## Teclado

| Teclas | Controle PS2 |
|---|---|
| W A S D | Analógico esquerdo |
| Setas | Direcional |
| J / K / U / I | Cruz / Círculo / Quadrado / Triângulo |
| Enter / Backspace | Start / Select |
| Q / E | L1 / R1 |
| 1 / 3 | L2 / R2 |

Mapeamento em `emulator/host.js`. É uma adaptação do controle PS2, não do controle nativo de GTA PC.
Mouse/câmera e configuração interativa de teclas não foram implementados.

## Núcleo e arquitetura

Projeto: https://github.com/jpd002/Play-
Binários pré-compilados oficiais: https://playjs.purei.org/Play.js e https://playjs.purei.org/Play.wasm
Ambos estão incluídos e são servidos localmente; não é necessário compilar C++ ou baixar o núcleo ao iniciar.
Licença e hashes: `emulator/play/LICENSE.txt` e `emulator/play/provenance.json`.
O commit documentado é a fonte inspecionada da API; não afirmamos que os binários publicados tenham sido compilados exatamente desse commit.
Play! emula a BIOS internamente. Não exige nem usa uma BIOS externa nesta integração.

Fluxo real de leitura:

```text
VM/pthread do Play!
  -> Module.discImageDevice.read(destinoWasm, offset, tamanho)
  -> MessageChannel (documento do núcleo -> launcher)
  -> fila limitada + cache LRU
  -> File.slice() local OU fetch Range -> Express -> Internet Archive
  -> Uint8Array transferível -> HEAPU8 do WASM
  -> isDone() libera a thread de emulação
```

A ISO não é montada inteira no MEMFS. O núcleo fica em iframe de mesma origem, removido ao parar.
Workers e AudioContexts são encerrados explicitamente antes da remoção.
Falhas de leitura param a VM: não entregamos setores inventados ou preenchidos com zeros para fingir funcionamento.
A ponte divide solicitações grandes em blocos de até 1 MiB; o leitor aceita até 2 MiB por operação e mantém fila limitada.
Leituras remotas têm timeout, backoff e fallback para subchunks menores. Resposta sem HTTP 206/Content-Range válido é rejeitada para evitar download integral.
Uma falha irrecuperável exibe erro; nenhum código consegue garantir execução de todo jogo ou impedir falta de memória do processo inteiro.

## Internet Archive

O modo remoto original continua disponível: informe identificador do item e caminho de uma ISO pública não compactada.
O backend aceita somente `archive.org` e seus subdomínios em redirecionamentos.
Não é um proxy de URLs arbitrárias. Páginas de catálogo e arquivos ZIP/7z/RAR/CHD não são suportados por essa rota.
Sem banco de dados e sem upload de jogos.

## Limitações importantes

- **Saves não persistem.** Esta versão não implementa exportação/sincronização de memory cards. Parar/recarregar perde o estado da VM.
- PS2 somente; não roda instaladores Windows nem ROMs de outros consoles.
- Requer WebGL2, WebAssembly, SharedArrayBuffer e COOP/COEP. Fora de localhost, use HTTPS.
- Abra o endereço em uma aba própria se o preview embutido bloquear isolamento.
- Desempenho depende do núcleo, jogo, GPU/CPU e navegador. Perfil RTX/RX e rotação são visuais.
- Backend destinado a uso pessoal; não inclui autenticação nem limites por usuário para exposição pública.
- Tailwind CDN é complementar; há CSS local para manter a interface se o CDN estiver indisponível.

## Validação executada

Teste de navegador Chromium headless com renderização WebGL por software:
- isolamento e SharedArrayBuffer;
- montagem de arquivo local e leitura de setor;
- carregamento do WASM real, inicialização da VM e chamadas do leitor CDVD;
- uma ISO sintética propositalmente incompleta gera erro de boot e encerra o núcleo;
- ejetar sem erro de JavaScript;
- teclas físicas W/J são traduzidas para KeyT/KeyZ do Play!.

**Não é um teste de gameplay ou de GTA.** Não medimos desempenho de jogos.
Também foram testados: instalação de ZIP sintético com senha, extração para disco, limpeza/cancelamento, erro HTTP 403, reinício detectando ISO instalada, Range local e bloqueio de ações cross-site. A interface de instalação foi testada com origem simulada e núcleo real. Na origem real do GTA configurado, um trecho de 2048 bytes foi lido por HTTP 206 através do backend; a assinatura CD001 foi confirmada.
O backend também foi testado anteriormente com origem HTTP simulada para Range, validação de caminhos e rejeição de download integral.

Para repetir o teste de navegador, deixe `npm start` rodando e em outro terminal execute:

```sh
npx playwright install chromium
npm run test:smoke
```

No Linux podem ser necessárias dependências do sistema (`npx playwright install-deps chromium`).
Use `TEST_URL` para outro endereço de servidor. A ISO inválida é gerada em memória pelo teste, não distribuída como jogo.

## Arquivos

- `index.html`: dashboard, leitor local/remoto, cache, telemetria.
- `server.js`: Express, segurança de origem e proxy Range.
- `game-config.json`: fonte configurada e metadados da ISO, sem o jogo.
- `game-installer.js`: instalação sob demanda, progresso, cancelamento, validação e streaming local.
- `emulator/adapter.js`: ciclo de vida e ponte entre launcher e núcleo.
- `emulator/host.html` / `host.js`: canvas, inicialização do Play!, CDVD, WASD e limpeza.
- `emulator/play/`: núcleo oficial pré-compilado, licença e procedência.
- `tests/smoke.cjs`: teste automatizado.
