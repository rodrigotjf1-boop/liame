import type { GoogleConversionAccount, GoogleConversionAction, GoogleConversionCounts, GoogleConversionsResponse } from '@liame/contracts';
import type { NomeIcone } from '@/components/ui/icone';
import { dataCompleta, diaHora, diasAte, horaDe, quandoComHora } from '@/lib/formato';

// Regras e frases de "Vendas informadas ao Google" (mockups/prototipo-contas-conversoes.html, P14, aprovado em
// 09/10/2026). Funções puras: o "agora" entra como parâmetro (LIC-006). Cada frase de consequência diz só o que o
// servidor faz (`apps/server/src/conversoes`): o pedido recusado não é tentado de novo, o que espera continua na fila,
// parar tira da fila o que esperava. A situação vem como texto (V23): valor desconhecido tem saída.

/**
 * A permissão do Google que deixa informar vendas, como ela aparece em `scopes` da autorização. É a mesma do contrato
 * (`GOOGLE_SALES_SCOPE`): o teste confere as duas, e a tela não carrega o pacote do contrato só por ela.
 */
export const ESCOPO_DE_INFORMAR_VENDAS = 'https://www.googleapis.com/auth/datamanager';

/** O que sai do Liame para o Google em cada venda (D-A5-5). */
export const ENVIA_AO_GOOGLE: readonly { rotulo: string; texto: string }[] = [
  { rotulo: 'O código do clique', texto: 'O identificador que o próprio Google pôs no link do anúncio quando a pessoa clicou.' },
  { rotulo: 'A hora do pedido', texto: 'Quando o pedido foi confirmado no caixa.' },
  { rotulo: 'O valor do pedido', texto: 'A receita confirmada, sem o que foi devolvido.' },
  { rotulo: 'Um número interno do pedido', texto: 'Criado pelo Liame, para o Google não contar a mesma venda duas vezes.' },
];

/** O que nunca sai. */
export const NUNCA_VAI_AO_GOOGLE: readonly string[] = [
  'Nome, telefone, e-mail ou endereço de quem comprou.',
  'O custo e a margem do pedido.',
  'Os itens do pedido.',
  'Pedido que não veio de um clique num anúncio do Google.',
];

const POR_EXTENSO = ['zero', 'uma', 'duas', 'três', 'quatro', 'cinco', 'seis'];

/** "duas horas", "uma hora", "12 horas", "45 minutos": o prazo entre a confirmação do pedido e o envio. */
export function esperaPorExtenso(minutos: number): string {
  if (minutos > 0 && minutos % 60 === 0) {
    const h = minutos / 60;
    return `${POR_EXTENSO[h] ?? h} ${h === 1 ? 'hora' : 'horas'}`;
  }
  if (minutos < 60) return minutos === 1 ? 'um minuto' : `${minutos} minutos`;
  return `${Math.floor(minutos / 60)} h ${minutos % 60} min`;
}

const primeiroNome = (nome: string): string => nome.trim().split(/\s+/)[0] || nome;

/** "hoje, 10:40" ou "08/10/2026": desde quando a conversão vale. */
function desde(iso: string, agora: Date): string {
  return diasAte(iso, agora) === 0 ? `hoje, ${horaDe(iso)}` : dataCompleta(iso);
}

/**
 * Quando a conta volta para a fila: "por volta das 11:05" (a rotina passa a cada poucos minutos, então a hora é
 * aproximada), "amanhã, por volta das 09:00", "em 12/10, 09:00" ou "em instantes" (já devia ter passado).
 */
export function porVoltaDe(iso: string | null, agora: Date): string {
  if (!iso || new Date(iso).getTime() <= agora.getTime()) return 'em instantes';
  const h = new Date(iso).getHours();
  const hora = `por volta ${h <= 1 ? 'da' : 'das'} ${horaDe(iso)}`;
  const dias = diasAte(iso, agora);
  if (dias === 0) return hora;
  if (dias === 1) return `amanhã, ${hora}`;
  return `em ${diaHora(iso, agora)}`;
}

/**
 * O motivo do Google em palavras, só quando o próprio texto dele não deixa dúvida (o código do clique que ele não
 * reconheceu). Qualquer outro motivo aparece como veio, no Pro.
 */
export function recusaEmPalavras(motivo: string): string | null {
  return /INVALID_(GCLID|GBRAID|WBRAID)/i.test(motivo) ? 'ele não reconheceu o clique deste pedido' : null;
}

export type SeloDasVendas = { classe: 'st--concluido' | 'st--aguardando' | 'st--espera' | 'st--perigo'; rotulo: string };
export type AvisoDasVendas = {
  tom: 'atencao' | 'perigo';
  icone: NomeIcone;
  /** A primeira frase, em destaque. */
  forte?: string;
  texto: string;
  /** Só no Pro: o motivo como a plataforma respondeu. */
  tecnico?: { rotulo: string; valor: string };
};
/** O que a pessoa que conecta contas pode fazer no cartão. Quem só vê não recebe nenhuma (a não ser abrir Sua equipe). */
export type AcaoDasVendas = 'autorizar' | 'escolher' | 'trocar' | 'parar' | 'voltar' | 'equipe';
export type VendasDaConta = {
  selo: SeloDasVendas;
  /** "Contadas em <nome>" e, ao lado, desde quando e quem escolheu. */
  destino: { nome: string; meta: string } | null;
  avisos: AvisoDasVendas[];
  /** Mostra as quatro contagens da janela. */
  numeros: boolean;
  /** A linha de baixo das contagens: a janela, a última passagem e a próxima. */
  passagem: string | null;
  acoes: AcaoDasVendas[];
};

type Contexto = { agora: Date; esperaMin: number; janelaDias: number };

/** O aviso das recusas da janela: quantas, a última e o que acontece com elas. */
function avisoDasRecusas(c: GoogleConversionAccount, { agora, janelaDias }: Contexto): AvisoDasVendas | null {
  const n = c.counts.refused;
  if (!n) return null;
  const r = c.last_refusal;
  const emPalavras = r ? recusaEmPalavras(r.reason) : null;
  const ultima = r ? `A última, ${quandoComHora(r.at, agora)}${emPalavras ? `: ${emPalavras}` : ''}. ` : '';
  return {
    tom: 'atencao',
    icone: 'alert',
    forte: `O Google recusou ${n} ${n === 1 ? 'venda' : 'vendas'} nos últimos ${janelaDias} dias.`,
    texto: `${ultima}O Liame não tenta de novo sozinho, e essas vendas seguem contando nos seus Resultados.`,
    ...(r ? { tecnico: { rotulo: 'Motivo do Google', valor: r.reason } } : {}),
  };
}

/** O cartão de uma conta do Google Ads: a situação, os avisos, o que mostrar e o que oferecer. */
export function vendasDaConta(c: GoogleConversionAccount, contexto: Contexto): VendasDaConta {
  const { agora, esperaMin, janelaDias } = contexto;
  const d = c.destination;
  const quem = d?.set_by ? primeiroNome(d.set_by.name) : null;
  const destino = d ? { nome: d.conversion_action_name, meta: [`desde ${desde(d.starts_at, agora)}`, quem ? `escolhida por ${quem}` : null].filter(Boolean).join(' · ') } : null;
  const ativo = d !== null && d.stopped_at === null;
  const janela = `Últimos ${janelaDias} dias`;

  if (c.status === 'equipe_parada') {
    const desdeQuando = c.team_stopped_at ? ` desde ${quandoComHora(c.team_stopped_at, agora)}` : '';
    return {
      selo: { classe: 'st--perigo', rotulo: 'Parado' },
      destino,
      avisos: [
        {
          tom: 'perigo',
          icone: 'alert-circle',
          texto: `A equipe está parada${desdeQuando}. Enquanto estiver, nenhuma venda é informada${ativo ? '; as que esperam saem quando ela for retomada' : ''}.`,
        },
      ],
      numeros: d !== null,
      passagem: null,
      acoes: ['equipe'],
    };
  }

  if (c.status === 'sem_permissao') {
    // Duas causas: a autorização não inclui o envio (falta a permissão), ou o Google recusou a que o Liame tem.
    const aviso: AvisoDasVendas = c.authorized
      ? {
          tom: 'atencao',
          icone: 'alert',
          texto: 'O Google recusou a autorização que o Liame usa para informar as vendas: ela foi revogada, venceu ou não alcança mais a conta. Autorize o Google de novo e, na volta, confirme as contas: nada é desligado.',
          ...(c.last_failure ? { tecnico: { rotulo: 'Motivo do Google', valor: c.last_failure.reason } } : {}),
        }
      : {
          tom: 'atencao',
          icone: 'alert',
          texto: 'Para informar as vendas, o Liame precisa de uma permissão a mais do Google, além da de leitura. Autorize o Google de novo e, na volta, confirme as contas: nada é desligado.',
        };
    return {
      selo: { classe: 'st--aguardando', rotulo: c.authorized ? 'Autorize de novo' : 'Falta uma permissão' },
      destino,
      avisos: [aviso],
      numeros: d !== null,
      passagem: null,
      acoes: ativo ? ['autorizar', 'parar'] : ['autorizar'],
    };
  }

  if (c.status === 'sem_destino' || !d) {
    return {
      selo: { classe: 'st--aguardando', rotulo: 'Falta escolher' },
      destino: null,
      avisos: [{ tom: 'atencao', icone: 'info', texto: 'Escolha onde o Google conta essas vendas. O Liame só envia para a conversão que você escolher, e nada sai antes disso.' }],
      numeros: false,
      passagem: null,
      acoes: ['escolher'],
    };
  }

  if (c.status === 'parado') {
    const parou = d.stopped_by ? ` por ${primeiroNome(d.stopped_by.name)}` : '';
    const quando = d.stopped_at ? ` em ${dataCompleta(d.stopped_at)}, ${horaDe(d.stopped_at)}` : '';
    return {
      selo: { classe: 'st--espera', rotulo: 'Parado' },
      destino: { nome: d.conversion_action_name, meta: `${quem ? `escolhida por ${quem} em` : 'escolhida em'} ${dataCompleta(d.starts_at)}` },
      avisos: [{ tom: 'atencao', icone: 'info', texto: `Parado${parou}${quando}. Nenhuma venda nova é informada; as que já foram informadas continuam no Google.` }],
      numeros: true,
      passagem: null,
      acoes: ['voltar'],
    };
  }

  const recusas = avisoDasRecusas(c, contexto);
  const ultima = c.last_run_at ? `última passagem ${quandoComHora(c.last_run_at, agora)}` : null;

  if (c.status === 'esperando_a_plataforma') {
    const esperar = c.last_failure?.kind !== 'outro';
    const volta = `O Liame tenta de novo ${porVoltaDe(c.next_run_at, agora)}; as vendas que esperam continuam na fila.`;
    const aviso: AvisoDasVendas = esperar
      ? { tom: 'atencao', icone: 'clock', texto: `O Google pediu para esperar ou estava fora do ar. ${volta}` }
      : { tom: 'atencao', icone: 'alert', texto: `A última passagem falhou antes do fim. ${volta}` };
    if (c.last_failure) aviso.tecnico = { rotulo: 'Motivo', valor: c.last_failure.reason };
    return {
      selo: { classe: 'st--aguardando', rotulo: esperar ? 'Esperando o Google' : 'Tentando de novo' },
      destino,
      avisos: recusas ? [aviso, recusas] : [aviso],
      numeros: true,
      passagem: [janela, ultima, `a próxima ${porVoltaDe(c.next_run_at, agora)}`].filter(Boolean).join(' · '),
      acoes: ['trocar', 'parar'],
    };
  }

  if (c.status === 'informando') {
    // Nada pode ter saído ainda: só entram os pedidos confirmados depois do começo, e cada um espera o prazo.
    const comecou = agora.getTime() - new Date(d.starts_at).getTime() < esperaMin * 60_000;
    const avisos: AvisoDasVendas[] = [];
    if (comecou) {
      avisos.push({
        tom: 'atencao',
        icone: 'clock',
        texto: `Começou ${quandoComHora(d.starts_at, agora)}. O primeiro pedido confirmado a partir de então sai ${esperaPorExtenso(esperaMin)} depois da confirmação. Os pedidos de antes não são informados.`,
      });
    }
    if (recusas) avisos.push(recusas);
    const semPassagem = !c.last_run_at || new Date(c.last_run_at).getTime() < new Date(d.starts_at).getTime();
    return {
      selo: { classe: 'st--concluido', rotulo: 'Informando' },
      destino,
      avisos,
      numeros: true,
      passagem: semPassagem ? 'A primeira passagem acontece em até uma hora.' : [janela, ultima, `a próxima ${porVoltaDe(c.next_run_at, agora)}`].filter(Boolean).join(' · '),
      acoes: ['trocar', 'parar'],
    };
  }

  // Situação que esta versão da tela não conhece: mostra o que há, sem oferecer o que pode não valer.
  return {
    selo: { classe: 'st--espera', rotulo: 'Conferindo' },
    destino,
    avisos: [{ tom: 'atencao', icone: 'info', texto: 'O Liame não reconheceu a situação desta conta. Atualize a página; se continuar, fale com o suporte.' }],
    numeros: true,
    passagem: null,
    acoes: [],
  };
}

/** As quatro contagens da janela, na ordem do cartão. A de recusadas chama atenção quando não é zero. */
export function numerosDasVendas(n: GoogleConversionCounts, esperaMin: number): { valor: number; rotulo: string; atencao: boolean }[] {
  return [
    { valor: n.informed, rotulo: n.informed === 1 ? 'venda informada' : 'vendas informadas', atencao: false },
    // O protótipo fala do prazo de duas horas; com outro prazo, a frase não promete uma conta que não fecha.
    { valor: n.waiting, rotulo: esperaMin === 120 ? 'esperando as duas horas' : 'esperando a vez', atencao: false },
    { valor: n.corrected, rotulo: 'com o valor corrigido', atencao: false },
    { valor: n.refused, rotulo: n.refused === 1 ? 'recusada pelo Google' : 'recusadas pelo Google', atencao: n.refused > 0 },
  ];
}

/** A etiqueta de cada conversão na escolha: o Google usa nos lances, ou só acompanha. */
export function notaDaConversao(a: Pick<GoogleConversionAction, 'primary'>): string {
  return a.primary ? 'usada nos lances' : 'só para acompanhar';
}

/**
 * A nota do diálogo de escolher: de quando em diante, o prazo e o que acontece com o cancelado. Ao TROCAR uma
 * conversão que está informando, o que esperava a vez para a antiga não sai (é o que o servidor faz): a nota diz.
 */
export function notaDaEscolha(esperaMin: number, trocando: boolean): string {
  const prazo = esperaPorExtenso(esperaMin);
  return (
    `Só entram os pedidos confirmados a partir de agora; os de antes não são informados. Cada pedido sai ${prazo} depois de confirmado no caixa. ` +
    'Se ele for cancelado depois disso, o valor é corrigido para zero: o Google não deixa retirar uma venda já informada.' +
    (trocando ? ' Ao trocar a conversão, as vendas que esperavam a vez para a antiga não são informadas.' : '')
  );
}

/** Uma conta do Google Ads com o que a resposta da marca dela diz: quem pode mexer, o prazo e a janela das contagens. */
export type ContaDasVendas = { conta: GoogleConversionAccount; brandId: string; podeGerir: boolean; esperaMin: number; janelaDias: number };

/**
 * As respostas de `GET /v1/conversions/google`, uma por marca, juntas: as marcas com a função ligada (a autorização
 * do Google delas pede também a permissão de informar vendas) e as contas, na ordem em que vieram.
 */
export function juntarVendas(respostas: GoogleConversionsResponse[]): { marcas: Set<string>; contas: ContaDasVendas[] } {
  const ligadas = respostas.filter((r) => r.enabled);
  return {
    marcas: new Set(ligadas.map((r) => r.brand_id)),
    contas: ligadas.flatMap((r) => r.accounts.map((conta) => ({ conta, brandId: r.brand_id, podeGerir: r.can_manage, esperaMin: r.wait_minutes, janelaDias: r.window_days }))),
  };
}

/**
 * Onde cada cartão entra na lista das autorizações: logo depois da autorização que lê a conta (como no protótipo). A
 * conta cuja autorização não está entre as que a tela mostra fica na chave vazia e vai para o fim da lista.
 */
export function vendasPorAutorizacao(
  contas: ContaDasVendas[],
  conexoes: { id: string; accounts: { id: string }[] }[],
  visiveis: { id: string }[],
): Map<string, ContaDasVendas[]> {
  const naTela = new Set(visiveis.map((c) => c.id));
  const conexaoDa = new Map(conexoes.flatMap((c) => c.accounts.map((a) => [a.id, c.id] as const)));
  const grupos = new Map<string, ContaDasVendas[]>();
  for (const v of contas) {
    const conexao = conexaoDa.get(v.conta.connected_account_id);
    const chave = conexao && naTela.has(conexao) ? conexao : '';
    grupos.set(chave, [...(grupos.get(chave) ?? []), v]);
  }
  return grupos;
}

/** A resposta de escolher ou parar (a situação das contas de UMA marca) entra no lugar das contas daquela marca. */
export function trocarAMarca(atual: GoogleConversionsResponse[], nova: GoogleConversionsResponse): GoogleConversionsResponse[] {
  return atual.some((r) => r.brand_id === nova.brand_id) ? atual.map((r) => (r.brand_id === nova.brand_id ? nova : r)) : [...atual, nova];
}
