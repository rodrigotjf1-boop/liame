import { type AccountFreshness, type ConnectionResponse, type DiscoveredAccount, GOOGLE_BUSINESS_SCOPE } from '@liame/contracts';
import { dia, diasAte, horaDe } from '@/lib/formato';
import { avisoDeLigar, ehSiteDoSearchConsole, notaDaPrimeiraLeitura } from './search-console';
import { listaEmPalavras, type SituacaoConta } from './textos';

// A loja do Perfil da Empresa no Google em "Contas conectadas" (mockups/prototipo-contas-perfil.html, P17 parte B,
// aprovado pelo dono em 14/10/2026). A loja é mais uma conta da lista e vem pela autorização do Google que já existe:
// com a função ligada para a empresa (`business_profile`), o Google pede uma permissão a mais. Sem a função, a tela é a
// de sempre. Funções puras: o "agora" entra como parâmetro.

/** O código da loja do perfil entre as contas (`provider`). */
export const PROVEDOR_DO_PERFIL = 'google_business';

/** A conta é uma loja do perfil da empresa no Google. */
export const ehLojaDoPerfil = (provider: string | null | undefined): boolean => provider === PROVEDOR_DO_PERFIL;

/** A linha de baixo do nome da loja, no lugar do código do Google. */
export const SUB_DA_LOJA = 'Loja do perfil da empresa no Google';

/** O que "Desligar" confirma na linha da loja, e o que o aviso diz depois. */
export const CONFIRMA_DESLIGAR_LOJA = 'O Liame para de ler as avaliações e os números desta loja.';
export const AVISO_LOJA_DESLIGADA = 'Loja desligada. As avaliações já lidas ficam guardadas por até 12 meses; para voltar a ler, ligue a loja de novo.';

/** A leitura das avaliações: é por ela que a loja está em dia, esperando o Google ou ainda na primeira leitura. */
const DATASET_DAS_AVALIACOES = 'avaliacoes_perfil';

/** "às 11:05" no mesmo dia; "amanhã, às 07:00" ou "em 16/10, às 07:00" depois (o Google pede espera de minutos a horas). */
function quandoTenta(iso: string, agora: Date): string {
  const dias = diasAte(iso, agora);
  if (dias <= 0) return `às ${horaDe(iso)}`;
  if (dias === 1) return `amanhã, às ${horaDe(iso)}`;
  return `em ${dia(iso, agora)}, às ${horaDe(iso)}`;
}

/**
 * Situação da loja na tabela: a conta primeiro (desconectada, sem permissão, com erro: como qualquer conta), depois a
 * leitura das avaliações. `funcaoLigada`: o perfil ligado para a empresa; desligado, a loja continua ligada e o Liame
 * não lê (a rotina confere a mesma flag).
 */
export function situacaoDaLojaDoPerfil(c: AccountFreshness, funcaoLigada: boolean, agora: Date): SituacaoConta {
  const avaliacoes = c.datasets.find((x) => x.dataset === DATASET_DAS_AVALIACOES) ?? null;
  const ultimaLeituraEm = avaliacoes?.last_success_at ?? null;
  const base = { precisaDeVoce: false, reconectar: false, ultimaLeituraEm };
  if (c.status === 'desconectada') {
    return { ...base, rotulo: 'Desconectada', tom: 'perigo', motivo: c.status_reason ?? 'O Google recusou a autorização desta loja.', precisaDeVoce: true, reconectar: true };
  }
  if (c.status === 'sem_permissao') {
    return { ...base, rotulo: 'Sem permissão', tom: 'atencao', motivo: c.status_reason ?? 'Falta a permissão do perfil da empresa no Google.', precisaDeVoce: true };
  }
  if (c.status === 'erro') {
    return { ...base, rotulo: 'Leitura falhando', tom: 'atencao', motivo: c.status_reason ?? 'A última leitura falhou; tentamos de novo sozinhos.' };
  }
  if (!funcaoLigada) {
    return { ...base, rotulo: 'Leitura parada', tom: 'espera', motivo: 'O perfil da empresa no Google não está ligado para a empresa: o Liame não lê esta loja agora.' };
  }
  // O Google pediu para esperar (a cota do perfil é do app do Liame): a rotina guarda quando tenta de novo.
  if (avaliacoes?.last_error?.startsWith('limite') && avaliacoes.next_at) {
    return { ...base, rotulo: 'Esperando o Google', tom: 'atencao', motivo: `O Google pediu para esperar. O Liame tenta de novo ${quandoTenta(avaliacoes.next_at, agora)}; nenhuma avaliação se perde.` };
  }
  if (!ultimaLeituraEm) {
    return { ...base, rotulo: 'Primeira leitura', tom: 'lendo', motivo: 'Trazendo as avaliações dos últimos 12 meses e os números do perfil. Leva alguns minutos.' };
  }
  if (avaliacoes?.freshness === 'fresh') return { ...base, rotulo: 'Avaliações em dia', tom: 'ok', motivo: null };
  return { ...base, rotulo: 'Avaliações atrasadas', tom: 'atencao', motivo: null };
}

// ------------------------------------------------------------------ a autorização do Google

/** A autorização do Google inclui a permissão do perfil. */
export const incluiOPerfil = (c: Pick<ConnectionResponse, 'scopes'>): boolean => c.scopes.includes(GOOGLE_BUSINESS_SCOPE);

/** Contas de anúncio, lojas do perfil e sites do Search Console ligados por esta autorização (os desligados não contam). */
export function ligadasDaAutorizacao(c: Pick<ConnectionResponse, 'accounts'>): { contas: number; lojas: number; sites: number } {
  const ativas = c.accounts.filter((a) => a.disconnected_at === null);
  const lojas = ativas.filter((a) => ehLojaDoPerfil(a.provider)).length;
  const sites = ativas.filter((a) => ehSiteDoSearchConsole(a.provider)).length;
  return { contas: ativas.length - lojas - sites, lojas, sites };
}

/** "3 contas", "3 contas e 1 loja", "1 loja", "3 contas e 1 site", "3 contas, 1 loja e 1 site" (o cabeçalho do cartão). */
export function contasELojas({ contas, lojas, sites = 0 }: { contas: number; lojas: number; sites?: number }): string {
  const c = contas === 1 ? '1 conta' : `${contas} contas`;
  const partes = [
    contas || (!lojas && !sites) ? c : '',
    lojas ? (lojas === 1 ? '1 loja' : `${lojas} lojas`) : '',
    sites ? (sites === 1 ? '1 site' : `${sites} sites`) : '',
  ].filter(Boolean);
  return listaEmPalavras(partes);
}

/** As lojas que esta autorização alcança e que ainda não estão ligadas a nenhuma marca da empresa. */
export function lojasPorLigar(c: Pick<ConnectionResponse, 'discovered'>): DiscoveredAccount[] {
  return c.discovered.filter((d) => ehLojaDoPerfil(d.provider) && !d.linked);
}

export type NotaDoPerfil = { icone: 'lock' | 'info' | 'clock' | 'alert'; destaque: string | null; texto: string };

/**
 * O que o cartão da autorização do Google diz do perfil, com a função ligada (nulo sem ela): se a autorização inclui a
 * permissão, o aviso de quando falta alguma coisa e a ação principal (escolher as lojas ou autorizar de novo).
 */
export function perfilNaAutorizacao(
  c: Pick<ConnectionResponse, 'scopes' | 'discovered' | 'profile_search'>,
  funcaoLigada: boolean,
): { inclui: boolean; nota: NotaDoPerfil | null; acao: 'escolher' | 'autorizar' | null } | null {
  if (!funcaoLigada) return null;
  // Sem a permissão, o cartão só avisa: o convite do topo leva a autorizar de novo.
  if (!incluiOPerfil(c)) {
    return { inclui: false, nota: { icone: 'lock', destaque: null, texto: 'Esta autorização não inclui o perfil da empresa no Google. As contas de anúncio são lidas normalmente.' }, acao: null };
  }
  const p = c.profile_search ?? null;
  const porLigar = lojasPorLigar(c).length;
  if (porLigar) {
    return {
      inclui: true,
      nota: {
        icone: 'info',
        destaque: `Esta autorização alcança ${porLigar === 1 ? '1 loja do perfil da empresa que ainda não está ligada' : `${porLigar} lojas do perfil da empresa que ainda não estão ligadas`}.`,
        texto: 'Ligue a loja para o Liame ler as avaliações e os números do perfil.',
      },
      acao: 'escolher',
    };
  }
  if (p?.result === 'limite') {
    return {
      inclui: true,
      nota: {
        icone: 'clock',
        destaque: 'O Google ainda não liberou o acesso do Liame ao perfil da empresa.',
        texto: 'Você já autorizou; falta o Google, que não informa o prazo. As contas de anúncio são lidas normalmente. O Liame procura as lojas de novo todo dia e avisa em Atenção quando elas aparecerem.',
      },
      acao: null,
    };
  }
  if (p?.result === 'sem_permissao') {
    return {
      inclui: true,
      nota: {
        icone: 'alert',
        destaque: 'O Google recusou a leitura do perfil da empresa.',
        texto: 'A conta do Google que autorizou precisa ter acesso ao perfil. Confira no Google e procure as contas de novo, ou autorize com a conta que cuida do perfil. As contas de anúncio não foram afetadas.',
      },
      acao: 'autorizar',
    };
  }
  if (p?.result === 'falhou') {
    return {
      inclui: true,
      nota: {
        icone: 'alert',
        destaque: 'Não deu para procurar as lojas do perfil agora.',
        texto: 'O Google não respondeu. As contas de anúncio não foram afetadas. O Liame procura de novo todo dia; se quiser, procure agora.',
      },
      acao: null,
    };
  }
  if (p?.result === 'ok' && p.stores === 0) {
    return {
      inclui: true,
      nota: {
        icone: 'info',
        destaque: 'Esta conta do Google não tem perfil de empresa.',
        texto: 'Se o perfil da sua empresa está em outra conta do Google, autorize de novo com ela. As contas de anúncio não foram afetadas.',
      },
      acao: 'autorizar',
    };
  }
  return { inclui: true, nota: null, acao: null };
}

/**
 * O convite do topo: com a função ligada, o Google conectado e nenhuma autorização do Google com a permissão do perfil,
 * "Ligue o perfil da empresa no Google" (a marca da autorização mais nova, que é a que vai ser trocada). Nulo sem convite.
 */
export function conviteDoPerfil(autorizacoes: Pick<ConnectionResponse, 'provider' | 'status' | 'scopes' | 'brand_id' | 'created_at'>[], funcaoLigada: boolean): { brandId: string } | null {
  if (!funcaoLigada) return null;
  const doGoogle = autorizacoes.filter((c) => c.provider === 'google' && (c.status === 'ativa' || c.status === 'aguardando_escolha'));
  if (!doGoogle.length || doGoogle.some(incluiOPerfil)) return null;
  const maisNova = [...doGoogle].sort((x, y) => y.created_at.localeCompare(x.created_at))[0]!;
  return { brandId: maisNova.brand_id };
}

export const CONVITE_DO_PERFIL = {
  titulo: 'Ligue o perfil da empresa no Google',
  texto: 'É o perfil que aparece na busca e no Maps, com as avaliações. O Google já está conectado para os anúncios; para o perfil, ele pede uma permissão a mais. As contas ligadas continuam como estão.',
  botao: 'Autorizar o Google de novo',
};

// ------------------------------------------------------------------ conectar e escolher

/** O aviso do diálogo de conectar, logo abaixo da opção do Google, com a função ligada. */
export const NOTA_DA_PERMISSAO_DO_PERFIL = {
  destaque: 'O Google vai pedir uma permissão a mais: a do perfil da empresa,',
  texto:
    'o que aparece na busca e no Maps, com as avaliações. Ele a mostra como a de gerenciar o perfil, porque não oferece uma só de leitura. O Liame lê as lojas, as avaliações e os números do perfil, e não muda horário, endereço nem cardápio. Se essa permissão não for concedida lá, os anúncios conectam do mesmo jeito, sem o perfil.',
};

/** O site da loja como o diálogo de escolher mostra ("misterburgers.com.br"), ou "sem site no perfil". */
export function siteDaLoja(site: string | null | undefined): string {
  if (!site) return 'sem site no perfil';
  return site.replace(/^https?:\/\//i, '').replace(/\/$/, '') || 'sem site no perfil';
}

/** A nota do diálogo de escolher quando há loja do perfil para ligar (sem loja, fica a de sempre). */
export function notaDaEscolhaComLoja(temContas: boolean): string {
  return notaDaPrimeiraLeitura({ contas: temContas, lojas: true, sites: false });
}

/** O aviso depois de ligar, quando havia loja do perfil para ligar. `contas`/`lojas`: quantas desta vez. */
export function avisoDeLigarComLoja(contas: number, lojas: number): string {
  return avisoDeLigar({ contas, lojas, sites: 0 }, { lojas: true, sites: false });
}

/**
 * "da conta", "das 3 contas", "da loja do perfil", "das 3 contas e da loja do perfil", "das 3 contas e do site"
 * (o diálogo de revogar).
 */
export function oQueParaDeLer({ contas, lojas, sites = 0 }: { contas: number; lojas: number; sites?: number }): string {
  const partes = [
    contas || (!lojas && !sites) ? (contas === 1 ? 'da conta' : `das ${contas} contas`) : '',
    lojas ? (lojas === 1 ? 'da loja do perfil' : `das ${lojas} lojas do perfil`) : '',
    sites ? (sites === 1 ? 'do site' : `dos ${sites} sites`) : '',
  ].filter(Boolean);
  return listaEmPalavras(partes);
}
