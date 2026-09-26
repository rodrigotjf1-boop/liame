# LIA · Kit da agente 3D da Liame

A LIA é a assistente virtual da Liame, em 3D e animada no navegador. Este kit traz a personagem pronta para usar na landing page e no app.

## O que tem no kit

| Arquivo | Para que serve |
|---|---|
| `lia-agent.js` | A biblioteca da personagem. É o único arquivo que o site precisa. |
| `index.html` | **Estúdio da LIA**: testa as 15 expressões, os 14 visuais (estações e datas), troca cores e exporta PNG e vídeo WebM com fundo transparente. |
| `exemplos/landing.html` | Hero de landing page com a LIA reagindo aos botões e à rolagem. |
| `exemplos/app-chat.html` | Página do app com avatar flutuante e chat. A LIA muda de expressão conforme a conversa. |
| `lia-avatar.svg` | Avatar 2D para usar quando o 3D não carregar, em notificações e como ícone. |
| `LEIA-ME.md` | Este guia. |

Abra os arquivos com dois cliques no Chrome ou no Edge. Para os exemplos funcionarem, mantenha a estrutura de pastas.

## Instalação no site

Coloque `lia-agent.js` no servidor e adicione no HTML, antes do fechamento do `<body>`:

```html
<div id="lia" style="width:480px;height:640px"></div>

<script src="https://cdn.jsdelivr.net/npm/three@0.147.0/build/three.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/three@0.147.0/examples/js/environments/RoomEnvironment.js"></script>
<!-- opcional: só se quiser que o visitante gire a personagem -->
<script src="https://cdn.jsdelivr.net/npm/three@0.147.0/examples/js/controls/OrbitControls.js"></script>
<script src="/js/lia-agent.js"></script>
<script>
  const lia = LiaAgent.create(document.getElementById('lia'), {
    framing: 'full',          // 'full' corpo inteiro · 'bust' busto · 'face' rosto
    background: 'transparent',
    controls: false,
    state: 'wave'
  });
</script>
```

A LIA ocupa todo o tamanho do elemento. Defina largura e altura no CSS.

## Opções de `LiaAgent.create`

| Opção | Padrão | Descrição |
|---|---|---|
| `framing` | `'full'` | Enquadramento: `full`, `bust` ou `face`. |
| `background` | `'transparent'` | Transparente ou uma cor CSS (`'#F1EEEA'`). |
| `controls` | `true` | Arrastar para girar (precisa do OrbitControls). |
| `zoom` | `true` | Rodinha do mouse aproxima. |
| `shadows` | `true` | Sombra no chão. Desligue em avatares pequenos. |
| `floorRing` | `true` | Anel de luz sob os pés. |
| `lookAtPointer` | `true` | Olhar e cabeça seguem o cursor. |
| `state` | `'idle'` | Expressão inicial. |
| `colors` | `'liame'` | Nome de uma paleta pronta ou objeto de cores. |
| `outfit` | `'executiva'` | Visual inicial. Use `'auto'` para a LIA se vestir conforme a estação ou a data comemorativa do dia. |
| `capture` | `false` | `true` libera `snapshot()` e gravação de vídeo. |
| `pixelRatio` | até 2 | Baixe para 1 ou 1,5 em avatares pequenos. |
| `pauseWhenHidden` | `true` | Para de animar fora da tela, economizando bateria. |

## Comandos

```js
lia.setState('talk');            // muda a expressão
lia.react('celebrate', 2500);    // expressão por 2,5 s e volta para 'idle'
lia.speak(3000);                 // fala por 3 s
lia.setColors('vibrante');       // paleta pronta
lia.setColors({ hair: '#E0407A', suit: '#111111' });  // cores avulsas
lia.setOutfit('natal');          // troca o visual
lia.setOutfit('auto');           // visual da estação/data de hoje
lia.getOutfit();                 // visual atual
LiaAgent.outfitForDate('2026-12-24'); // 'natal' (sem criar personagem)
lia.setFraming('bust');          // muda o enquadramento com transição
lia.snapshot();                  // PNG em data URL (exige capture:true)
lia.pause(); lia.resume();       // pausa e retoma
lia.on('state', s => {});        // eventos: 'ready', 'state', 'colors', 'outfit'
lia.destroy();                   // remove e libera memória
```

## As 15 expressões

| ID | Nome | Quando usar |
|---|---|---|
| `idle` | Parada | Estado padrão: respira, pisca e olha em volta. |
| `wave` | Olá | Ao abrir o site ou o chat. |
| `talk` | Falando | Enquanto a resposta aparece na tela. O microfone pulsa. |
| `listen` | Ouvindo | Enquanto o usuário digita ou fala. Mão no fone e ondas de som. |
| `think` | Pensando | Aguardando a resposta do servidor. |
| `working` | Trabalhando | Tarefas longas: digita num notebook. |
| `analyze` | Analisando | Relatórios e números: painel holográfico com gráficos. |
| `happy` | Feliz | Tarefa concluída. |
| `celebrate` | Comemorando | Meta batida, venda, cadastro concluído. Confete e pulos. |
| `love` | Encantada | Elogios e agradecimentos. Corações flutuando. |
| `wink` | Piscadinha | Dicas, novidades, tom descontraído. |
| `surprised` | Surpresa | Novidade inesperada ou resultado acima do normal. |
| `confused` | Confusa | Não entendeu a mensagem. Ponto de interrogação. |
| `empathetic` | Empática | Reclamações, problemas, pedidos de ajuda. |
| `shy` | Tímida | Respostas a elogios e brincadeiras. |

### Ligação sugerida com o chat

| Evento do chat | Expressão |
|---|---|
| Chat abriu | `wave` por 2,5 s |
| Usuário digitando | `listen` |
| Mensagem enviada, aguardando | `think` (ou `working` se passar de 3 s) |
| Resposta chegando | `talk` |
| Resposta final | `happy`, `analyze`, `empathetic` ou `confused`, conforme o tipo |
| Sem atividade | `idle` |

O backend pode devolver um campo `estado` junto com o texto da resposta. É assim que o exemplo `app-chat.html` funciona.

## Visuais: estações e datas comemorativas

A LIA troca de roupa, acessórios, objeto na mão e partículas no ar. As estações seguem o calendário do hemisfério sul (Brasil). Todas as 15 expressões funcionam com qualquer visual.

| ID | Visual | Período no modo `auto` | O que muda |
|---|---|---|---|
| `executiva` | Executiva | o ano todo (padrão) | Blazer, lenço ciano, crachá. |
| `verao` | Verão | 21 dez a 19 mar | Vestido florido de alça, óculos de sol, sandália, brilho de sol. |
| `outono` | Outono | 20 mar a 20 jun | Blazer terracota, cachecol de tricô, boina, folhas caindo. |
| `inverno` | Inverno | 21 jun a 22 set | Casaco de pele marrom com gola, punhos e barra felpudos, botas, café quente soltando fumaça. |
| `primavera` | Primavera | 23 set a 20 dez | Vestido rosa florido, coroa de flores, flores caindo. |
| `carnaval` | Carnaval | 5 dias antes até a Quarta de Cinzas | Vestido de paetê, cocar de plumas, glitter no rosto, confete. |
| `pascoa` | Páscoa | semana até o Domingo de Páscoa | Vestido listrado pastel, tiara com orelhas de coelho que mexem (balançam, dobram a ponta e dão "tremidinhas"), ovinhos subindo. |
| `namorados` | Dia dos Namorados | 5 a 12 jun | Vestido vermelho, presilha de coração, buquê, corações. |
| `junina` | Festa Junina | 1º jun a 20 jul | Vestido xadrez, chapéu de palha, pintinhas no rosto, bandeirinhas. |
| `torcida` | Torcida Brasil | só manual (dias de jogo) | Camisa amarela da torcida, pintura no rosto, bandeira. |
| `halloween` | Halloween | 24 a 31 out | Vestido roxo, capa, chapéu de bruxa, abóbora, morcegos. |
| `blackfriday` | Black Friday | 4 dias antes até 3 dias depois | Terninho preto com lenço pink, sacola com %, etiquetas subindo. |
| `natal` | Natal | 1 a 26 dez | Vestido vermelho com barra de pelo, gorro de Papai Noel com a ponta caída, presente, pinheiro enfeitado com luzes piscando ao fundo, neve. |
| `anonovo` | Ano Novo | 27 dez a 2 jan | Vestido branco de paetê, tiara, estrelas douradas. |

No modo `auto`, datas comemorativas têm prioridade sobre a estação. Carnaval e Páscoa são calculados a cada ano. O visual é escolhido ao carregar a página, com a data do computador do visitante.

Quando a LIA volta para `executiva`, ela recupera as cores definidas com `setColors`. Nos outros visuais, as cores de roupa vêm do próprio visual; cabelo, pele e olhos continuam os seus.

## Paletas prontas

`liame` (padrão) · `classica` · `vibrante` · `pastel` · `tropical` · `noturna` · `vinho`

Partes que aceitam cor: `hair`, `skin`, `eyes`, `suit`, `skirt`, `shirt`, `accent` (lenço, luzes e microfone), `set` (headset) e `shoes`.

## Desempenho e acessibilidade

- A LIA pausa sozinha quando sai da tela ou quando a aba fica oculta.
- Em celulares e avatares pequenos, use `shadows:false` e `pixelRatio:1.5`.
- Quem ativa "reduzir movimento" no sistema recebe uma versão com movimentos mais suaves.
- O canvas tem descrição acessível ("LIA, assistente virtual da Liame"). O texto das conversas continua em HTML, legível por leitores de tela.
- Se o navegador não tiver WebGL, `LiaAgent.create` lança um erro. Capture com `try/catch` e mostre `lia-avatar.svg` no lugar.

```js
try { LiaAgent.create(el, {...}); }
catch (e) { el.innerHTML = '<img src="/img/lia-avatar.svg" alt="LIA, assistente virtual da Liame" width="240">'; }
```

## Imagens e vídeos para redes

Abra `index.html` (Estúdio), escolha a expressão, as cores e o enquadramento e clique em **Baixar PNG** ou **Gravar vídeo 5 s**. Os arquivos saem com fundo transparente, prontos para posts, stories e apresentações.

## Técnico

- Depende do three.js **r147** (licença MIT), carregado pelo CDN jsDelivr. Para não depender de CDN, baixe os três arquivos e sirva do seu domínio.
- Toda a personagem é gerada por código: não há arquivo 3D externo para carregar.
- Tamanho: cerca de 40 KB da LIA + 600 KB do three.js (comprimidos pelo servidor, bem menos).
- Fontes da marca: Poppins e JetBrains Mono (Google Fonts, licença OFL).

## Próximos passos sugeridos

Esta versão é a base de identidade e comportamento. Para uma versão com acabamento de animação de cinema, um artista 3D pode modelar a LIA no Blender seguindo este visual e exportar em GLB. A mesma API de expressões (`setState`) continua valendo, trocando só o modelo.
