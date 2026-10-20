import { type AccountFreshness, type ConnectionResponse, type DiscoveredAccount, SEARCH_CONSOLE_SCOPE } from '@liame/contracts';
import { dia, diasAte, horaDe } from '@/lib/formato';
import type { NotaDoPerfil } from './perfil-google';
import { listaEmPalavras, type SituacaoConta } from './textos';

// O site do Search Console em "Contas conectadas" (mockups/prototipo-contas-search-console.html, P18 parte B, aprovado
// pelo dono em 15/10/2026). O site é mais uma conta da lista e vem pela autorização do Google que já existe: com a
// função ligada para a empresa (`search_console`), o Google pede uma permissão a mais, só de leitura. Sem a função, a
// tela é a de sempre. Funções puras: o "agora" entra como parâmetro.

/** O código do site do Search Console entre as contas (`provider`). */
export const PROVEDOR_DO_SITE = 'search_console';

/** A conta é um site do Search Console. */
export const ehSiteDoSearchConsole = (provider: string | null | undefined): boolean => provider === PROVEDOR_DO_SITE;

/** O site é a propriedade de domínio do Search Console (`sc-domain:`), que vale para o domínio inteiro. */
export const ehDominioInteiro = (externalId: string | null | undefined): boolean => Boolean(externalId?.startsWith('sc-domain:'));

/** A linha de baixo do nome do site na lista, no lugar do código do Google. */
export const subDoSite = (externalId: string | null | undefined): string =>
  `Site no Search Console · ${ehDominioInteiro(externalId) ? 'o domínio inteiro' : 'um endereço'}`;

/** O que "Desligar" confirma na linha do site, e o que o aviso diz depois. */
export const CONFIRMA_DESLIGAR_SITE = 'O Liame para de ler os cliques e as buscas deste site.';
export const AVISO_SITE_DESLIGADO = 'Site desligado. As buscas já lidas ficam guardadas por até 12 meses; para voltar a ler, ligue o site de novo.';

/** A leitura dos números por dia: é por ela que o site está em dia, esperando o Google ou ainda na primeira leitura. */
const DATASET_DOS_DIAS = 'buscas_dias';

/** "às 11:05" no mesmo dia; "amanhã, às 07:00" ou "em 16/10, às 07:00" depois. */
function quandoTenta(iso: string, agora: Date): string {
  const dias = diasAte(iso, agora);
  if (dias <= 0) return `às ${horaDe(iso)}`;
  if (dias === 1) return `amanhã, às ${horaDe(iso)}`;
  return `em ${dia(iso, agora)}, às ${horaDe(iso)}`;
}

/**
 * Situação do site na tabela: a conta primeiro (desconectada, sem permissão, com erro: como qualquer conta), depois a
 * leitura dos números por dia. `funcaoLigada`: o Search Console ligado para a empresa; desligado, o site continua
 * ligado e o Liame não lê (a rotina confere a mesma flag).
 */
export function situacaoDoSite(c: AccountFreshness, funcaoLigada: boolean, agora: Date): SituacaoConta {
  const dias = c.datasets.find((x) => x.dataset === DATASET_DOS_DIAS) ?? null;
  const ultimaLeituraEm = dias?.last_success_at ?? null;
  const base = { precisaDeVoce: false, reconectar: false, ultimaLeituraEm };
  if (c.status === 'desconectada') {
    return { ...base, rotulo: 'Desconectada', tom: 'perigo', motivo: c.status_reason ?? 'O Google recusou a autorização deste site.', precisaDeVoce: true, reconectar: true };
  }
  if (c.status === 'sem_permissao') {
    return { ...base, rotulo: 'Sem permissão', tom: 'atencao', motivo: c.status_reason ?? 'Falta a permissão do Search Console, ou a conta do Google perdeu o acesso ao site.', precisaDeVoce: true };
  }
  if (c.status === 'erro') {
    return { ...base, rotulo: 'Leitura falhando', tom: 'atencao', motivo: c.status_reason ?? 'A última leitura falhou; tentamos de novo sozinhos.' };
  }
  if (!funcaoLigada) {
    return { ...base, rotulo: 'Leitura parada', tom: 'espera', motivo: 'O Search Console não está ligado para a empresa: o Liame não lê este site agora.' };
  }
  // O Google pediu para esperar: a rotina guarda quando tenta de novo.
  if (dias?.last_error?.startsWith('limite') && dias.next_at) {
    return { ...base, rotulo: 'Esperando o Google', tom: 'atencao', motivo: `O Google pediu para esperar. O Liame tenta de novo ${quandoTenta(dias.next_at, agora)}; nenhuma busca se perde.` };
  }
  if (!ultimaLeituraEm) {
    return { ...base, rotulo: 'Primeira leitura', tom: 'lendo', motivo: 'Trazendo os cliques dos últimos 90 dias e as buscas das últimas 12 semanas. Leva alguns minutos.' };
  }
  if (dias?.freshness === 'fresh') return { ...base, rotulo: 'Buscas em dia', tom: 'ok', motivo: null };
  return { ...base, rotulo: 'Buscas atrasadas', tom: 'atencao', motivo: null };
}

// ------------------------------------------------------------------ a autorização do Google

/** A autorização do Google inclui a permissão do Search Console. */
export const incluiOSearchConsole = (c: Pick<ConnectionResponse, 'scopes'>): boolean => c.scopes.includes(SEARCH_CONSOLE_SCOPE);

/** Os sites que esta autorização alcança e que ainda não estão ligados a nenhuma marca da empresa. */
export function sitesPorLigar(c: Pick<ConnectionResponse, 'discovered'>): DiscoveredAccount[] {
  return c.discovered.filter((d) => ehSiteDoSearchConsole(d.provider) && !d.linked);
}

/**
 * O que o cartão da autorização do Google diz do Search Console, com a função ligada (nulo sem ela): se a autorização
 * inclui a permissão, o aviso de quando falta alguma coisa e a ação principal (escolher os sites ou autorizar de novo).
 */
export function searchConsoleNaAutorizacao(
  c: Pick<ConnectionResponse, 'scopes' | 'discovered' | 'site_search'>,
  funcaoLigada: boolean,
): { inclui: boolean; nota: NotaDoPerfil | null; acao: 'escolher' | 'autorizar' | null } | null {
  if (!funcaoLigada) return null;
  // Sem a permissão, o cartão só avisa: o convite do topo leva a autorizar de novo.
  if (!incluiOSearchConsole(c)) {
    return { inclui: false, nota: { icone: 'lock', destaque: null, texto: 'Esta autorização não inclui o Search Console. As contas de anúncio são lidas normalmente.' }, acao: null };
  }
  const s = c.site_search ?? null;
  const porLigar = sitesPorLigar(c).length;
  if (porLigar) {
    return {
      inclui: true,
      nota: {
        icone: 'info',
        destaque: `Esta autorização alcança ${porLigar === 1 ? '1 site do Search Console que ainda não está ligado' : `${porLigar} sites do Search Console que ainda não estão ligados`}.`,
        texto: `Ligue o site para o Liame ler os cliques e as buscas que levam a ele.`,
      },
      acao: 'escolher',
    };
  }
  if (s?.result === 'sem_permissao') {
    return {
      inclui: true,
      nota: {
        icone: 'alert',
        destaque: 'O Google recusou a leitura do Search Console.',
        texto:
          'A conta do Google que autorizou precisa ter acesso ao site. Confira no Search Console e procure as contas de novo, ou autorize com a conta que cuida do site. As contas de anúncio não foram afetadas.',
      },
      acao: 'autorizar',
    };
  }
  if (s?.result === 'falhou' || s?.result === 'limite') {
    // A procura dos sites que não deu certo não se repete sozinha (a do perfil se repete): a pessoa procura de novo.
    return {
      inclui: true,
      nota: {
        icone: 'alert',
        destaque: 'Não deu para procurar os sites agora.',
        texto: `${s.result === 'limite' ? 'O Google pediu para esperar.' : 'O Google não respondeu.'} As contas de anúncio não foram afetadas. Procure de novo em alguns minutos.`,
      },
      acao: null,
    };
  }
  if (s?.result === 'ok' && s.sites === 0) {
    return {
      inclui: true,
      nota: {
        icone: 'info',
        destaque: 'Esta conta do Google não tem site no Search Console.',
        texto:
          'Se o site da sua empresa está no Search Console de outra conta do Google, autorize de novo com ela; se ainda não está lá, verifique o site no Search Console. As contas de anúncio não foram afetadas.',
      },
      acao: 'autorizar',
    };
  }
  return { inclui: true, nota: null, acao: null };
}

/**
 * O convite do topo: com a função ligada, o Google conectado e nenhuma autorização do Google com a permissão do Search
 * Console, "Ligue o Search Console" (a marca da autorização mais nova, que é a que vai ser trocada). Nulo sem convite.
 */
export function conviteDoSearchConsole(
  autorizacoes: Pick<ConnectionResponse, 'provider' | 'status' | 'scopes' | 'brand_id' | 'created_at'>[],
  funcaoLigada: boolean,
): { brandId: string } | null {
  if (!funcaoLigada) return null;
  const doGoogle = autorizacoes.filter((c) => c.provider === 'google' && (c.status === 'ativa' || c.status === 'aguardando_escolha'));
  if (!doGoogle.length || doGoogle.some(incluiOSearchConsole)) return null;
  const maisNova = [...doGoogle].sort((x, y) => y.created_at.localeCompare(x.created_at))[0]!;
  return { brandId: maisNova.brand_id };
}

export const CONVITE_DO_SEARCH_CONSOLE = {
  titulo: 'Ligue o Search Console',
  texto:
    'É a ferramenta do Google que mostra as buscas que levam ao seu site. O Google já está conectado para os anúncios; para o Search Console, ele pede uma permissão a mais, só de leitura. As contas ligadas continuam como estão.',
  botao: 'Autorizar o Google de novo',
};

// ------------------------------------------------------------------ conectar e escolher

/** O aviso do diálogo de conectar, logo abaixo da opção do Google, com a função ligada. */
export const NOTA_DA_PERMISSAO_DO_SEARCH_CONSOLE = {
  destaque: 'O Google vai pedir uma permissão a mais: a do Search Console, só de leitura.',
  texto:
    'É a ferramenta do Google que mostra as buscas que levam ao site da empresa. O Liame lê os sites e as buscas, e não muda nada no Search Console. Se essa permissão não for concedida lá, os anúncios conectam do mesmo jeito, sem os sites.',
};

/** O acesso da conta do Google ao site, em palavras ("você é dono", "acesso completo"); nulo quando não veio. */
export function acessoAoSite(acesso: string | null | undefined): string | null {
  if (acesso === 'dono') return 'você é dono';
  if (acesso === 'completo') return 'acesso completo';
  if (acesso === 'restrito') return 'acesso restrito';
  return null;
}

/** A linha de baixo do site no diálogo de escolher: "o domínio inteiro · você é dono", "um endereço · acesso completo". */
export function subDaEscolhaDoSite(d: Pick<DiscoveredAccount, 'external_id' | 'site_access'>): string {
  const tipo = ehDominioInteiro(d.external_id) ? 'o domínio inteiro' : 'um endereço';
  const acesso = acessoAoSite(d.site_access);
  return acesso ? `${tipo} · ${acesso}` : tipo;
}

/** O que a primeira leitura traz, no diálogo de escolher, conforme o que há para ligar (contas, lojas do perfil, sites). */
export function notaDaPrimeiraLeitura({ contas, lojas, sites }: { contas: boolean; lojas: boolean; sites: boolean }): string {
  const partes: string[] = [];
  if (contas) partes.push('Das contas de anúncio, a primeira leitura traz os últimos 90 dias.');
  if (lojas) partes.push('Da loja do perfil, as avaliações dos últimos 12 meses e os números do perfil; o Liame não guarda o nome nem a foto de quem avaliou.');
  if (sites) partes.push('Do site, os cliques dos últimos 90 dias e as buscas das últimas 12 semanas.');
  if (!contas && lojas && sites) {
    return 'A primeira leitura traz, da loja do perfil, as avaliações dos últimos 12 meses e os números do perfil (o Liame não guarda o nome nem a foto de quem avaliou) e, do site, os cliques dos últimos 90 dias e as buscas das últimas 12 semanas. Leva alguns minutos.';
  }
  if (!contas && lojas) {
    return 'A primeira leitura da loja do perfil traz as avaliações dos últimos 12 meses e os números do perfil; o Liame não guarda o nome nem a foto de quem avaliou. Leva alguns minutos.';
  }
  if (!contas && sites) return 'A primeira leitura do site traz os cliques dos últimos 90 dias e as buscas das últimas 12 semanas. Leva alguns minutos.';
  if (!partes.length) return 'A primeira leitura traz os últimos 90 dias e leva alguns minutos. Depois, os números são atualizados todo dia.';
  return `${partes.join(' ')} Leva alguns minutos.`;
}

/**
 * O aviso depois de ligar, quando havia loja do perfil ou site para ligar. `ligadas`: quantas de cada desta vez.
 * `havia`: o que estava para ligar (a parte que ficou sem ligar entra no aviso).
 */
export function avisoDeLigar(ligadas: { contas: number; lojas: number; sites: number }, havia: { lojas: boolean; sites: boolean }): string {
  const { contas, lojas, sites } = ligadas;
  const faltou = listaEmPalavras([havia.lojas && !lojas ? 'as lojas do perfil' : '', havia.sites && !sites ? 'os sites do Search Console' : ''].filter(Boolean));
  const seguem = faltou ? `${faltou.charAt(0).toUpperCase()}${faltou.slice(1)} seguem sem ligar.` : '';
  if (!lojas && !sites) return `${contas === 1 ? 'Conta ligada' : 'Contas ligadas'}.${seguem ? ` ${seguem}` : ''}`;
  const nomes = [
    contas ? (contas === 1 ? 'conta' : 'contas') : '',
    lojas ? (lojas === 1 ? 'loja' : 'lojas') : '',
    sites ? (sites === 1 ? 'site' : 'sites') : '',
  ].filter(Boolean);
  // O site é masculino: com ele, o plural é "ligados"; só contas e lojas, "ligadas".
  const um = contas + lojas + sites === 1;
  const adjetivo = sites ? (um ? 'ligado' : 'ligados') : um ? 'ligada' : 'ligadas';
  const frase = `${listaEmPalavras(nomes)} ${adjetivo}`;
  return `${frase.charAt(0).toUpperCase()}${frase.slice(1)}. A primeira leitura começou e leva alguns minutos.${seguem ? ` ${seguem}` : ''}`;
}
