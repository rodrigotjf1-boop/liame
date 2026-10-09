import type { AutonomyItem, AutonomyResponse, AutonomyThresholds, TeamActivityItem, TeamMember, TeamResponse, TeamShadowDecision, TeamShadowResponse } from '@liame/contracts';
import type { Frase, Trecho } from '@/components/resultados/textos';
import { quandoComHora } from '@/lib/formato';
import { acaoDa, alvoDe, diaDaLoja, modoEscrito, plataformaDe, type Portao, portoesDe } from './textos';

// Sua equipe com o modo Aprovação (A4 · X8; mockups/prototipo-equipe-aprovacao.html, P11 aprovado em 05/10/2026). O
// Gestor de tráfego deixa de ter um modo só: em cada conta e em cada ação ele está em Sombra (só registra e compara),
// em Sugerir (a recomendação aparece na Atenção e a pessoa pede a mudança) ou em Aprovação (ele mesmo faz o pedido,
// que espera a aprovação de uma pessoa com o código do app). Funções puras: o que `/v1/autonomy` e `/v1/team/shadow`
// mandam vira o que a pessoa lê. Quem decide se a proposta sai é o servidor; aqui só se escreve.

const b = (t: string): Trecho => ({ t, b: true });
const maiuscula = (s: string) => s.charAt(0).toLocaleUpperCase('pt-BR') + s.slice(1);
const vezes = (n: number, um: string, varios: string) => `${n} ${n === 1 ? um : varios}`;

/** A empresa tem o modo Aprovação: o servidor só manda os portões dele (`approval`) com a função ligada. */
export function temModoAprovacao(autonomia: AutonomyResponse | null): boolean {
  return autonomia?.items.some((a) => a.approval !== undefined) ?? false;
}

export const chaveDaLinha = (a: Pick<AutonomyItem, 'connected_account_id' | 'tool'>): string => `${a.connected_account_id}:${a.tool}`;

/** Os números dos portões da Aprovação (D-A4-25): quantos pedidos se olham, quantos precisam ter sido aprovados e quantos a mais depois de uma recusa. */
export function limitesDaAprovacao(t: AutonomyThresholds): { pedidos: number; aprovados: number; depoisDaRecusa: number } {
  return { pedidos: t.approval_requests ?? 10, aprovados: t.approval_min_approved ?? 8, depoisDaRecusa: t.requests_after_rejection ?? 10 };
}

const PLATAFORMA_CURTA: Record<string, { nome: string; na: string; da: string }> = {
  meta_ads: { nome: 'a Meta', na: 'na Meta', da: 'da Meta' },
  google_ads: { nome: 'o Google', na: 'no Google', da: 'do Google' },
};
const plat = (provider: string) => PLATAFORMA_CURTA[provider] ?? { nome: plataformaDe(provider), na: `em ${plataformaDe(provider)}`, da: `de ${plataformaDe(provider)}` };

/** "reduzir a verba de uma campanha", "pausar uma campanha": a ação recomendada, numa frase sobre qualquer campanha. */
const numaCampanha = (tool: string): string => (tool === 'campanha_pausar' ? 'pausar uma campanha' : `${acaoDa(tool, null)} de uma campanha`);

/** O Liame não muda campanhas desta plataforma: o modo vai só até Sugerir. */
const semEscritaNaPlataforma = (a: AutonomyItem) => a.approval?.blocked_by === 'plataforma_sem_escrita';
/** A escrita existe na plataforma, mas não está ligada para esta conta. */
const escritaDesligada = (a: AutonomyItem) => a.approval?.blocked_by === 'escrita_desligada';

/**
 * Os portões que valem para a linha: os cinco da sombra para sair de Sombra; para chegar à Aprovação, mais dois, tirados
 * dos pedidos mais recentes que nasceram de uma recomendação dele. Onde a Aprovação não existe (a plataforma em que o
 * Liame não escreve), ficam os cinco.
 */
export function portoesDaLinha(a: AutonomyItem, limites: AutonomyThresholds): Portao[] {
  const daSombra = portoesDe(a, limites);
  const ap = a.approval;
  if (a.mode === 'SHADOW' || !ap || semEscritaNaPlataforma(a)) return daSombra;
  const L = limitesDaAprovacao(limites);
  const faltam = L.pedidos - ap.sample_size;
  return [
    ...daSombra,
    {
      chave: 'aprovados',
      rotulo: `Dos ${L.pedidos} pedidos mais recentes, você aprovou`,
      valor: faltam > 0 ? `${ap.approved} de ${ap.sample_size} (${faltam === 1 ? 'falta 1 pedido' : `faltam ${faltam} pedidos`})` : `${ap.approved} de ${L.pedidos} (mín. ${L.aprovados})`,
      passou: !ap.missing.includes('pedidos') && !ap.missing.includes('aprovacao'),
      curto: 'pedidos aprovados',
    },
    {
      chave: 'erros',
      rotulo: 'Pedidos aprovados que terminaram em erro',
      valor: `${ap.failed} (máx. 0)`,
      // Sem nenhum pedido aprovado ainda, "sem erro" não quer dizer nada: o portão só passa com algum aprovado.
      passou: ap.approved > 0 && !ap.missing.includes('erro'),
      curto: 'execução sem erro',
    },
  ];
}

// ------------------------------------------------------------------ o modo em cada conta e ação

const CLASSE_DO_MODO: Record<string, string> = { SHADOW: 'modo-chip modo-chip--sombra', SUGGEST: 'modo-chip modo-chip--sugerir', APPROVAL: 'modo-chip modo-chip--aprovacao' };
export const classeDoModo = (mode: string): string => CLASSE_DO_MODO[mode] ?? 'modo-chip';

export const O_QUE_O_MODO_FAZ: Record<'SHADOW' | 'SUGGEST' | 'APPROVAL', string> = {
  SHADOW: 'Só registra o que faria e compara com o que você fez.',
  SUGGEST: 'A recomendação aparece na Atenção; você pede a mudança.',
  APPROVAL: 'Ele mesmo pede a mudança; você aprova com o código do app.',
};

/** "Meta Ads · Reduzir a verba"; com mais de uma conta da mesma plataforma na lista, o nome da conta entra junto. */
export function nomeDaLinha(a: AutonomyItem, itens: readonly AutonomyItem[]): string {
  const contas = new Set(itens.filter((x) => x.provider === a.provider).map((x) => x.connected_account_id));
  return contas.size > 1 ? `${plataformaDe(a.provider)} (${a.account_name}) · ${maiuscula(acaoDa(a.tool, null))}` : alvoDe(a);
}

export interface LinhaDosModos {
  chave: string;
  nome: string;
  modo: string;
  classe: string;
  oque: string;
}

export function linhaDosModos(a: AutonomyItem, itens: readonly AutonomyItem[]): LinhaDosModos {
  const oque = O_QUE_O_MODO_FAZ[a.mode as 'SHADOW' | 'SUGGEST' | 'APPROVAL'] ?? '';
  return {
    chave: chaveDaLinha(a),
    nome: nomeDaLinha(a, itens),
    modo: modoEscrito(a.mode),
    classe: classeDoModo(a.mode),
    oque: `${oque}${semEscritaNaPlataforma(a) ? ` ${maiuscula(plat(a.provider).na)}, ele vai só até Sugerir.` : ''}`,
  };
}

/** "1 em Aprovação · 2 em Sugerir · 1 em Sombra". */
export function resumoDosModos(itens: readonly AutonomyItem[]): string {
  return (['APPROVAL', 'SUGGEST', 'SHADOW'] as const)
    .map((m) => [m, itens.filter((a) => a.mode === m).length] as const)
    .filter(([, n]) => n > 0)
    .map(([m, n]) => `${n} em ${modoEscrito(m)}`)
    .join(' · ');
}

// ------------------------------------------------------------------ "Já pode fazer mais?": a linha escolhida

/** De onde vem o modo de agora, para a linha de baixo do título: quem aprovou e quando, ou a política em vigor. */
function desde(a: AutonomyItem, agora: Date): string {
  const p = a.proposal;
  const modo = modoEscrito(a.mode);
  if (p?.status === 'aprovada' && p.to_mode === a.mode && p.decided_at) {
    return `Em ${modo} desde ${quandoComHora(p.decided_at, agora)}${p.decided_by ? `, aprovado por ${p.decided_by.name}` : ''} · regra de autonomia, versão ${p.policy_version ?? a.mode_source.version ?? 1}.`;
  }
  const politica = a.mode_source.policy === 'marca' ? 'da marca' : a.mode_source.policy === 'empresa' ? 'da empresa' : 'em vigor';
  return `Em ${modo} pela política ${politica}${a.mode_source.version ? `, versão ${a.mode_source.version}` : ''}.`;
}

export interface CaixaDaLinha {
  titulo: string;
  sub: string | null;
  texto: Frase | null;
  pontos: Array<{ forte: string; texto: string }>;
  /** A proposta que espera decisão: os botões "Aprovar a promoção" e "Recusar". */
  proposta: { id: string; para: 'SUGGEST' | 'APPROVAL' } | null;
  /** O modo para onde o botão de voltar leva (um passo); nulo sem o botão. */
  voltar: 'Sugerir' | 'Sombra' | null;
  /** O título recebe o foco depois da decisão (a recusa e a volta). */
  aviso: boolean;
}

const caixa = (c: Partial<CaixaDaLinha> & Pick<CaixaDaLinha, 'titulo'>): CaixaDaLinha => ({ sub: null, texto: null, pontos: [], proposta: null, voltar: null, aviso: false, ...c });

/** A caixa da linha escolhida: a proposta para decidir, o modo de agora com a volta de um passo, ou o que aconteceu com a última proposta. Nula em Sombra sem proposta. */
export function caixaDaLinha(a: AutonomyItem, itens: readonly AutonomyItem[], limites: AutonomyThresholds, agora: Date): CaixaDaLinha | null {
  const nome = nomeDaLinha(a, itens);
  const p = a.proposal;
  const pl = plat(a.provider);
  const L = limitesDaAprovacao(limites);
  const voltar = a.mode === 'APPROVAL' ? 'Sugerir' : a.mode === 'SUGGEST' ? 'Sombra' : null;

  if (p?.status === 'pendente') {
    if (p.to_mode === 'APPROVAL') {
      return caixa({
        titulo: `Proposta do sistema: ${nome}, de Sugerir para Aprovação`,
        texto: [
          { t: 'Os sete portões passaram. ' },
          b('O que muda:'),
          { t: ` quando ele recomendar ${numaCampanha(a.tool)} ${pl.da}, ele mesmo faz o pedido, na rodada da manhã. O pedido chega em Aprovações com o motivo e os números, e só é executado depois que uma pessoa aprova com o código do app.` },
        ],
        pontos: [
          { forte: 'Continua igual:', texto: `os limites da empresa (o passo por pedido, o teto por campanha e a verba do mês), a conferência ${pl.da} antes de mudar e o desfazer.` },
          { forte: 'Se ele não conseguir pedir', texto: `(${pl.nome} não respondeu, já existe um pedido igual, falta um limite), a recomendação fica na Atenção, com o motivo.` },
          // O que é só do Google (protótipo P13, parte 2): a mudança é na campanha, e verba dividida não se mexe.
          ...(a.provider === 'google_ads'
            ? [{ forte: 'No Google:', texto: 'o pedido é sempre na campanha inteira. Se a verba da campanha for dividida com outras campanhas, ele não pede a mudança: a recomendação fica na Atenção, com o motivo.' }]
            : []),
        ],
        proposta: { id: p.id, para: 'APPROVAL' },
      });
    }
    // De Sombra para Sugerir: onde o Liame escreve, quem pede a mudança é a pessoa; onde só lê, ela muda na plataforma.
    const quemMuda = a.approval && !a.approval.blocked_by ? 'Quem pede a mudança é você.' : `Quem decide e muda a campanha é você, ${pl.na}.`;
    return caixa({
      titulo: `Proposta do sistema: ${nome}, de Sombra para Sugerir`,
      texto: [{ t: 'Os cinco portões passaram. ' }, b('O que muda:'), { t: ` quando ele recomendar ${numaCampanha(a.tool)}, a recomendação aparece na Atenção, com o motivo e os números. ${quemMuda}` }],
      proposta: { id: p.id, para: 'SUGGEST' },
    });
  }

  if (a.mode === 'APPROVAL') {
    return caixa({
      titulo: `${nome} está em Aprovação`,
      sub: desde(a, agora),
      texto: [
        {
          t: `Quando ele recomenda ${numaCampanha(a.tool)} ${pl.da}, o pedido chega em Aprovações já feito, com o motivo e os números. Nada é executado sem a aprovação de uma pessoa com o código do app, e os limites da empresa valem para ele.`,
        },
      ],
      voltar,
    });
  }

  if (a.mode === 'SUGGEST' && semEscritaNaPlataforma(a)) {
    return caixa({
      titulo: `${nome} fica em Sugerir`,
      sub: `O Liame ainda não muda campanhas ${pl.da}: a recomendação aparece na Atenção, e quem muda é você, ${pl.na}. A Aprovação para ${pl.nome} entra numa fase futura.`,
      voltar,
    });
  }
  if (a.mode === 'SUGGEST' && escritaDesligada(a)) {
    return caixa({
      titulo: 'A Aprovação ainda não está disponível',
      sub: `A escrita ${pl.na} não está ligada para esta conta: o Liame só lê as campanhas. Em Sugerir, a recomendação aparece na Atenção e quem muda é você, ${pl.na}. Quem liga a escrita é a Liame, a pedido do dono.`,
      voltar,
    });
  }

  // O que aconteceu com a última proposta, enquanto o modo ainda é o de antes dela.
  if (p && p.from_mode === a.mode) {
    const paraAprovacao = p.to_mode === 'APPROVAL';
    const deNovo = paraAprovacao ? `mais ${vezes(L.depoisDaRecusa, 'pedido decidido', 'pedidos decididos')}` : `mais ${vezes(limites.sample_after_rejection, 'decisão comparável', 'decisões comparáveis')}`;
    const modo = modoEscrito(a.mode);
    if (p.status === 'desfeita') {
      return caixa({
        titulo: `${nome} voltou para ${modo}`,
        sub: `${p.undone_by ? `Por ${p.undone_by.name}` : 'Por uma pessoa da empresa'}${p.undone_at ? `, ${quandoComHora(p.undone_at, agora)}` : ''}.`,
        texto: [
          {
            t: `${
              paraAprovacao
                ? 'Ele volta a só mostrar a recomendação na Atenção. Os pedidos que ele já tinha feito continuam em Aprovações, esperando a sua decisão.'
                : 'Ele volta a só registrar e comparar. Nada mais aparece na Atenção por ele nesta ação.'
            } O sistema só propõe de novo depois de ${deNovo}.`,
          },
        ],
        voltar,
        aviso: true,
      });
    }
    if (p.status === 'recusada') {
      return caixa({
        titulo: `Promoção recusada${p.decided_by ? ` por ${p.decided_by.name}` : ''}`,
        sub: `Ele segue em ${modo} nesta ação. O sistema só propõe de novo depois de ${deNovo}.`,
        voltar,
        aviso: true,
      });
    }
    if (p.status === 'retirada') {
      const faltam = portoesDaLinha(a, limites)
        .filter((x) => !x.passou)
        .map((x) => x.curto);
      return caixa({
        titulo: 'Proposta retirada pelo sistema',
        sub: `A proposta de ${paraAprovacao ? 'Aprovação' : 'Sugerir'} saiu antes de alguém decidir: ${faltam.length ? `um portão deixou de passar (${faltam.join('; ')})` : 'os portões deixaram de passar'}. Ele segue em ${modo}. O sistema propõe de novo quando os portões voltarem a passar.`,
        voltar,
      });
    }
  }

  if (a.mode === 'SUGGEST') return caixa({ titulo: `${nome} está em Sugerir`, sub: desde(a, agora), voltar });
  return null;
}

/** A frase do Lite para a linha escolhida. */
export function fraseDaLinha(a: AutonomyItem, itens: readonly AutonomyItem[], limites: AutonomyThresholds, podeDecidir: boolean): Frase {
  const nome = nomeDaLinha(a, itens);
  const portoes = portoesDaLinha(a, limites);
  const [n, total] = [portoes.filter((x) => x.passou).length, portoes.length];
  const pl = plat(a.provider);
  const quem = podeDecidir ? 'você' : 'o Dono ou o Administrador';
  const em: Frase = [{ t: 'Em ' }, b(nome), { t: ', ' }];
  if (a.proposal?.status === 'pendente') {
    return a.proposal.to_mode === 'APPROVAL'
      ? [...em, { t: `ele passou nos sete portões. O sistema propõe que ele mesmo passe a fazer esse pedido. Quem decide é ${quem}, e cada pedido continua esperando a aprovação com o código do app.` }]
      : [...em, { t: `ele passou nos cinco portões. O sistema propõe que ele passe a mostrar essas recomendações para você. Quem decide é ${quem}.` }];
  }
  if (a.mode === 'APPROVAL') return [...em, { t: `ele já faz o pedido sozinho. Você aprova cada um com o código do app; sem isso, nada muda ${pl.na}.` }];
  if (a.mode === 'SUGGEST') {
    if (semEscritaNaPlataforma(a)) return [...em, { t: `ele mostra a recomendação na Atenção. ${maiuscula(pl.na)} ele não passa disso: quem muda a campanha é você.` }];
    if (escritaDesligada(a)) return [...em, { t: `ele mostra a recomendação na Atenção. Para ele mesmo pedir a mudança, a escrita ${pl.na} precisa estar ligada para esta conta.` }];
    if (!a.approval) return [...em, { t: 'ele já mostra a recomendação para você na Atenção.' }];
    if (n === total) return [...em, { t: 'ele mostra a recomendação e você pede a mudança. Os portões para ele mesmo pedir estão passando: quem propõe a mudança de modo é o sistema, depois da rodada da manhã.' }];
    const faltam = limitesDaAprovacao(limites).pedidos - a.approval.sample_size;
    return [
      b('Ainda não.'),
      { t: ' Em ' },
      b(nome),
      { t: `, ele mostra a recomendação e você pede a mudança. Para ele mesmo pedir: ${n} de ${total} portões` },
      ...(faltam > 0 ? [{ t: '; ' }, { t: faltam === 1 ? 'falta ' : 'faltam ' }, b(String(faltam)), { t: faltam === 1 ? ' pedido decidido por você' : ' pedidos decididos por você' }] : []),
      { t: '.' },
    ];
  }
  const faltam = Math.max(0, limites.sample_size - (a.readiness?.sample_size ?? 0));
  if (n === total) return [...em, { t: 'ele só registra e compara. Os cinco portões estão passando: quem propõe a mudança de modo é o sistema, depois da rodada da manhã.' }];
  return [
    b('Ainda não.'),
    { t: ' Em ' },
    b(nome),
    { t: `, ele só registra e compara: ${n} de ${total} portões` },
    ...(faltam > 0 ? [{ t: '; ' }, { t: faltam === 1 ? 'falta ' : 'faltam ' }, b(String(faltam)), { t: faltam === 1 ? ' decisão comparável' : ' decisões comparáveis' }] : []),
    { t: '.' },
  ];
}

/** A coluna "O que falta" da tabela de prontidão (Pro). `ok`: o texto sai em verde. */
export function faltaDaLinha(a: AutonomyItem, limites: AutonomyThresholds): { portoes: string; texto: string; ok: boolean; falta: boolean } {
  const portoes = portoesDaLinha(a, limites);
  const [n, total] = [portoes.filter((x) => x.passou).length, portoes.length];
  const conta = `${n} de ${total}`;
  if (a.mode === 'APPROVAL') return { portoes: '—', texto: 'No modo mais alto desta fase', ok: true, falta: false };
  if (a.proposal?.status === 'pendente') return { portoes: conta, texto: 'Proposta esperando a decisão', ok: true, falta: false };
  if (a.mode === 'SUGGEST' && semEscritaNaPlataforma(a)) return { portoes: conta, texto: `${maiuscula(plat(a.provider).na)}, vai só até Sugerir`, ok: false, falta: false };
  if (a.mode === 'SUGGEST' && escritaDesligada(a)) return { portoes: conta, texto: `A escrita ${plat(a.provider).na} não está ligada`, ok: false, falta: false };
  if (a.mode === 'SUGGEST' && !a.approval) return { portoes: conta, texto: 'Já mostra as recomendações', ok: true, falta: false };
  if (n === total) return { portoes: conta, texto: 'Portões passando', ok: false, falta: false };
  return {
    portoes: conta,
    texto: portoes
      .filter((x) => !x.passou)
      .map((x) => x.curto)
      .join('; '),
    ok: false,
    falta: true,
  };
}

/** A nota de baixo do bloco. */
export function notaDosPortoes(limites: AutonomyThresholds): string {
  return `Prontidão não é uma nota: são portões objetivos, por conta e por ação. Cinco para sair de Sombra; para a Aprovação, mais dois, tirados dos ${limitesDaAprovacao(limites).pedidos} pedidos mais recentes que nasceram de uma recomendação dele. Quando todos passam, o sistema propõe e uma pessoa aprova.`;
}

/** O que a tela diz depois de cada decisão (o aviso que some sozinho). */
export function avisoDaDecisao(a: AutonomyItem, oque: 'aprovar' | 'recusar' | 'voltar'): string {
  const acao = acaoDa(a.tool, null);
  const pl = plat(a.provider);
  if (oque === 'aprovar') {
    return a.proposal?.to_mode === 'APPROVAL'
      ? `Promoção aprovada. A partir da próxima rodada, ele mesmo pede ${acao} ${pl.na}; cada pedido espera a aprovação com o código do app.`
      : `Promoção aprovada. As recomendações de ${acao} na conta ${a.account_name} (${plataformaDe(a.provider)}) passam a aparecer na Atenção.`;
  }
  if (oque === 'recusar') return `Promoção recusada. Ele segue em ${modoEscrito(a.mode)}.`;
  return `De volta para ${a.mode === 'APPROVAL' ? 'Sugerir' : 'Sombra'}. A mudança ficou registrada na auditoria.`;
}

/** A confirmação da volta de um passo. */
export function confirmacaoDaVolta(a: AutonomyItem): { texto: string; rotulo: string } {
  return a.mode === 'APPROVAL'
    ? { texto: 'Ele volta a só mostrar a recomendação. Os pedidos que já fez continuam esperando.', rotulo: 'Voltar para Sugerir' }
    : { texto: 'Ele volta a só registrar e comparar nesta ação.', rotulo: 'Voltar para Sombra' };
}

// ------------------------------------------------------------------ a rodada da manhã

export interface RodadaDoGestor {
  titulo: string;
  nota: string;
  frase: Frase;
  passos: Array<{ texto: string; ferramentas: string[]; falhou: boolean }>;
  /** O pedido para abrir em Aprovações (um só), ou a tela de Aprovações (vários); nulo sem pedido dele na rodada. */
  aprovacoes: { pedido: string | null } | null;
  /** Há recomendação desta rodada na Atenção. */
  naAtencao: boolean;
  aviso: string | null;
  /** A linha dele na lista de funcionários: "Pediu 1 mudança hoje". */
  resumo: string;
  /** A rotina terminou hoje (o selo dele na lista é "Concluído"). */
  hoje: boolean;
}

const SUBSTANTIVO: Record<string, string> = { orcamento_reduzir: 'A redução da verba', orcamento_aumentar: 'O aumento da verba', campanha_pausar: 'A pausa' };
const daCampanha = (d: TeamShadowDecision) => `da campanha “${d.campaign.name}”`;
/** "reduzir a verba da campanha “X”", "pausar a campanha “X”". */
function oQueFaria(d: TeamShadowDecision): string {
  return d.tool === 'campanha_pausar' ? `pausar a campanha “${d.campaign.name}”` : `${acaoDa(d.tool, d.percent)} ${daCampanha(d)}`;
}

/**
 * O bloco "Rodada de hoje": o que ele fez com cada recomendação do último dia em que a rotina terminou. Em Aprovação,
 * pediu (ou não conseguiu pedir, e o motivo fica); em Sugerir, deixou na Atenção; em Sombra, só registrou. Com a equipe
 * parada, ninguém pede nada. Nulo sem a lista da sombra ou antes da primeira rodada.
 */
export function rodadaDoGestor(sombra: TeamShadowResponse | null, itens: readonly AutonomyItem[], equipe: Pick<TeamResponse, 'stop'>, agora: Date): RodadaDoGestor | null {
  if (equipe.stop) {
    return {
      titulo: 'Rodada de hoje',
      nota: 'não rodou',
      frase: [b('Com a equipe parada, ele não recomenda nem pede nada.'), { t: ' Os pedidos que já estavam em Aprovações continuam lá, mas nenhum é executado enquanto a equipe estiver parada.' }],
      passos: [],
      aprovacoes: null,
      naAtencao: false,
      aviso: null,
      resumo: 'Parado com a equipe',
      hoje: false,
    };
  }
  if (!sombra?.last_run?.on) return null;
  const dia = sombra.last_run.on;
  const quando = diaDaLoja(dia, agora);
  const modoDe = (d: TeamShadowDecision) => itens.find((a) => a.connected_account_id === d.connected_account_id && a.tool === d.tool) ?? null;
  const doDia = sombra.items.filter((d) => d.decided_on === dia);
  const pedidas = doDia.filter((d) => d.request?.agent_key === 'trafego');
  const semPedido = doDia.filter((d) => d.not_requested && d.request?.agent_key !== 'trafego');
  const mostradas = doDia.filter((d) => !pedidas.includes(d) && !semPedido.includes(d) && (modoDe(d)?.mode ?? 'SHADOW') !== 'SHADOW');
  const registradas = doDia.filter((d) => !pedidas.includes(d) && !semPedido.includes(d) && !mostradas.includes(d));
  const [P, N, S, R] = [pedidas.length, semPedido.length, mostradas.length, registradas.length];

  const noDia = quando === 'hoje' ? 'hoje' : `em ${quando}`;
  let resumo: string;
  if (P > 0) resumo = `Pediu ${vezes(P, 'mudança', 'mudanças')} ${noDia}`;
  else if (N > 0) resumo = `Não conseguiu fazer ${N === 1 ? 'o pedido' : `${N} pedidos`} ${noDia}`;
  else if (S > 0) resumo = `Deixou ${vezes(S, 'recomendação', 'recomendações')} na Atenção ${noDia}`;
  else if (R > 0) resumo = `Registrou ${vezes(R, 'recomendação', 'recomendações')} ${noDia}, sem mexer em nada`;
  else resumo = `Nenhuma campanha pediu mudança ${noDia}`;

  let frase: Frase;
  if (P > 0) {
    const outras = S + N;
    const primeiro = pedidas[0]!;
    const doPedido =
      P > 1
        ? 'Cada pedido espera a aprovação de uma pessoa com o código do app'
        : primeiro.request?.status === 'aguardando_aprovacao'
          ? `${SUBSTANTIVO[primeiro.tool] ?? 'A mudança'} ${daCampanha(primeiro)} espera a sua aprovação com o código do app`
          : `O pedido de ${oQueFaria(primeiro)} já foi decidido: está em Aprovações`;
    const daAtencao =
      outras === 0
        ? ''
        : outras === 1
          ? `; a recomendação de ${oQueFaria((mostradas[0] ?? semPedido[0])!)} está na Atenção${N ? ', com o motivo de ele não ter pedido' : ', para você pedir se concordar'}`
          : `; as outras ${outras} recomendações estão na Atenção${N ? ', com o motivo das que ele não conseguiu pedir' : ', para você pedir se concordar'}`;
    frase = [b(`Ele pediu ${vezes(P, 'mudança', 'mudanças')}${outras ? ` e sugeriu ${outras === 1 ? 'outra' : `outras ${outras}`}` : ''}.`), { t: ` ${doPedido}${daAtencao}.` }];
  } else if (N > 0) {
    const motivo = N === 1 ? ` ${semPedido[0]!.not_requested!.detail}` : ' O motivo de cada um está na Atenção.';
    frase = [
      b(N === 1 ? 'Ele não conseguiu fazer o pedido desta rodada.' : `Ele não conseguiu fazer os ${N} pedidos desta rodada.`),
      { t: `${motivo} ${N + S === 1 ? 'A recomendação ficou' : 'As recomendações ficaram'} na Atenção${N === 1 ? ', com o motivo' : ''}: se você concordar, peça a mudança por lá.` },
    ];
  } else if (S > 0) {
    const lista = S <= 2 ? ` ${maiuscula(mostradas.map(oQueFaria).join(' e '))}.` : '';
    // Onde o Liame escreve, a pessoa pede a mudança pela Atenção; onde só lê, ela muda na plataforma.
    const daParaPedir = mostradas.some((d) => {
      const a = modoDe(d);
      return a?.approval !== undefined && !a.approval.blocked_by;
    });
    frase = [
      b(`Ele deixou ${vezes(S, 'recomendação', 'recomendações')} na Atenção.`),
      { t: `${lista} ${daParaPedir ? 'Se você concordar, peça a mudança por lá; ela ainda passa pela aprovação com o código do app.' : 'Se você concordar, quem muda a campanha é você, na plataforma.'}` },
    ];
  } else if (R > 0) {
    frase = [b(`Ele registrou ${vezes(R, 'recomendação', 'recomendações')}, sem mexer em nada.`), { t: ' Em Sombra, nada aparece na Atenção: ele só compara com o que você fizer.' }];
  } else {
    frase = [b('Nenhuma campanha pediu mudança nesta rodada.'), { t: ' Ele leu os resultados e comparou cada campanha com as regras.' }];
  }

  const passos: RodadaDoGestor['passos'] = [
    { texto: 'Leu os resultados de 7 dias das campanhas', ferramentas: ['Resultados · leitura'], falhou: false },
    { texto: 'Comparou cada campanha com as regras da sombra', ferramentas: ['Cálculo por código'], falhou: false },
  ];
  if (P > 3) passos.push({ texto: `Pediu ${P} mudanças`, ferramentas: ['Aprovação · pedido'], falhou: false });
  else for (const d of pedidas) passos.push({ texto: `Pediu ${oQueFaria(d)}`, ferramentas: ['Aprovação · pedido'], falhou: false });
  if (N > 3) passos.push({ texto: `Não conseguiu fazer ${N} pedidos`, ferramentas: ['Aprovação · pedido'], falhou: true });
  else for (const d of semPedido) passos.push({ texto: `Não conseguiu pedir: ${oQueFaria(d)}`, ferramentas: ['Aprovação · pedido'], falhou: true });
  if (S + N > 0) passos.push({ texto: `Deixou ${vezes(S + N, 'recomendação', 'recomendações')} na Atenção${N ? ', com o motivo' : ''}`, ferramentas: ['Sugerir · Atenção'], falhou: false });
  if (R > 0) passos.push({ texto: `Registrou ${vezes(R, 'recomendação', 'recomendações')}, sem mexer em nada`, ferramentas: ['Sombra · registro'], falhou: false });
  if (P + N + S + R === 0) passos.push({ texto: 'Não registrou recomendação nova: nenhuma campanha pediu', ferramentas: ['Sombra · registro'], falhou: false });
  passos.push({ texto: 'Conferiu o que mudou nas contas desde a rodada anterior', ferramentas: ['Meta Ads e Google Ads · leitura'], falhou: false });

  return {
    titulo: quando === 'hoje' ? 'Rodada de hoje' : 'Última rodada',
    nota: `${quando} · regras da sombra, versão ${sombra.rule_version}`,
    frase,
    passos,
    aprovacoes: P > 0 ? { pedido: P === 1 ? (pedidas[0]!.request?.id ?? null) : null } : null,
    naAtencao: S + N > 0,
    aviso:
      sombra.last_run.status === 'dado_velho'
        ? `A última tentativa${sombra.last_run.at ? ` (${quandoComHora(sombra.last_run.at, agora)})` : ''} não rodou: os dados das contas não estavam em dia.`
        : null,
    resumo,
    hoje: quando === 'hoje',
  };
}

/**
 * O Gestor de tráfego na lista de funcionários, com o modo Aprovação: o que ele fez na rodada e o selo ("Concluído" se
 * a rotina terminou hoje, "Em espera" se não). Nulo quando a situação é outra (parado, desligado): vale a de sempre.
 */
export function gestorNaLista(m: Pick<TeamMember, 'key' | 'status'>, rodada: RodadaDoGestor | null): { atividade: string; selo: { rotulo: string; classe: string; ponto: boolean } } | null {
  if (m.key !== 'trafego' || m.status !== 'sombra') return null;
  return {
    atividade: rodada?.resumo ?? 'Compara cada campanha com as regras, todo dia',
    selo: rodada?.hoje ? { rotulo: 'Concluído', classe: 'st st--concluido', ponto: true } : { rotulo: 'Em espera', classe: 'st st--espera', ponto: true },
  };
}

export const SUBTITULO_DA_EQUIPE =
  'Cada funcionário é um assistente de IA, com cargo, limites e histórico. Nada muda numa campanha sem a aprovação de uma pessoa: quem cuida de anúncio começa em sombra e só faz mais quando você deixa.';

// ------------------------------------------------------------------ o que pode e o que não pode

export const LIMITES_DO_GESTOR = {
  faz: 'registra o que faria e compara com o que você fez; em Sugerir, mostra a recomendação na Atenção; em Aprovação, faz o pedido de mudar a verba ou pausar, na Meta e no Google.',
  /** O que é só do Google (protótipo P13, parte 2). */
  noGoogle: 'o pedido é sempre na campanha inteira, com os mesmos limites da Meta (10% por pedido, teto por campanha e verba do mês).',
  nunca: 'mudar qualquer coisa sem a aprovação de uma pessoa com o código do app; passar dos limites da empresa; criar ou apagar campanha; mexer em verba dividida entre campanhas do Google.',
};

export const RESUMO_DO_GESTOR =
  'Todo dia, depois da leitura da manhã, compara cada campanha com as regras e decide o que recomendaria. O que ele faz com a recomendação depende do modo de cada conta e de cada ação: só registrar (Sombra), mostrar para você (Sugerir) ou fazer o pedido (Aprovação). Em nenhum modo ele muda uma campanha sem a aprovação de uma pessoa.';

// ------------------------------------------------------------------ o histórico (os tipos do modo Aprovação)

const NAO_PEDIU: Record<string, string> = {
  plataforma_indisponivel: 'A plataforma não respondeu na hora de ler a campanha, e sem essa leitura nada é pedido.',
  acao_duplicada: 'Já existia um pedido igual esperando decisão.',
  sem_responsavel: 'Quem liberou o modo Aprovação não está mais na empresa, ou não pode mais pedir ações.',
  sem_pedido_possivel: 'Não dá para pedir esta mudança pelo Liame nesta campanha.',
  erro_interno: 'O Liame teve uma falha ao fazer o pedido.',
};

/** As linhas do histórico que só existem com o modo Aprovação; nulo nos outros tipos (a tela usa os textos de sempre). */
export function historicoDaAprovacao(i: Pick<TeamActivityItem, 'kind' | 'subject' | 'detail' | 'count' | 'by' | 'mine'>): { titulo: string; texto: string } | null {
  const quem = (verbo: string, semNome: string) => (i.mine ? `Você ${verbo}` : i.by ? `${i.by.name} ${verbo}` : semNome);
  const acao = acaoDa(i.detail, null);
  const onde = i.subject ? `${i.subject}: ` : '';
  switch (i.kind) {
    case 'pediu':
      return { titulo: `Pediu ${acaoDa(i.detail, i.count)}${i.subject ? `: ${i.subject}` : ''}`, texto: 'Pedido feito por ele, no modo Aprovação. Só é executado depois que uma pessoa aprova com o código do app.' };
    case 'nao_pediu':
      return { titulo: `Não conseguiu fazer o pedido${i.subject ? `: ${i.subject}` : ''}`, texto: `${NAO_PEDIU[i.detail ?? ''] ?? 'Um limite ou uma regra da empresa não deixou o pedido entrar.'} A recomendação ficou na Atenção, com o motivo.` };
    case 'aprovacao_proposta':
      return { titulo: `O sistema propôs que ele mesmo peça: ${acao}`, texto: `${onde}os sete portões passaram. Quem decide é uma pessoa.` };
    case 'aprovacao_aprovada':
      return { titulo: `Modo Aprovação liberado: ${acao}`, texto: `${quem('aprovou', 'Aprovado')}. Ele passa a fazer o pedido; cada um espera a aprovação com o código do app.` };
    case 'aprovacao_recusada':
      return { titulo: `Modo Aprovação recusado: ${acao}`, texto: `${quem('recusou', 'Recusado')}. Ele segue em Sugerir nessa ação.` };
    case 'aprovacao_retirada':
      return { titulo: `Proposta de Aprovação retirada: ${acao}`, texto: 'Um portão deixou de passar antes de alguém decidir.' };
    case 'saiu_da_aprovacao':
      return { titulo: `De volta para Sugerir: ${acao}`, texto: `${quem('voltou a ação para Sugerir', 'A ação voltou para Sugerir')}. Os pedidos que ele já tinha feito continuam esperando decisão.` };
    default:
      return null;
  }
}
