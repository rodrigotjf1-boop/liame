import {
  type AccountFreshness,
  type ConnectedAccountResponse,
  type ConnectionResponse,
  type DiscoveredAccount,
  META_INSTAGRAM_PUBLISH_SCOPE,
  META_PAGE_PUBLISH_SCOPE,
} from '@liame/contracts';
import type { NotaDoPerfil } from './perfil-google';
import { listaEmPalavras, type SituacaoConta } from './textos';

// A Página do Facebook e o Instagram em "Contas conectadas" (mockups/prototipo-contas-posts.html, P19 parte B, aprovado
// pelo dono em 01/11/2026). São mais duas contas da lista, ligadas à marca pela pessoa, e vêm pela autorização da Meta
// que já existe: com os posts ligados para a empresa (`posts` da lista de conexões), a Meta pede as permissões de
// publicar. A Página e o Instagram não são lidos: é neles que os posts aprovados da marca saem. Sem a função, a tela é a
// de sempre. Funções puras.

/** Os códigos da Página e do Instagram entre as contas (`provider`). */
export const PROVEDOR_DA_PAGINA = 'facebook_page';
export const PROVEDOR_DO_INSTAGRAM = 'instagram';

export const ehPagina = (provider: string | null | undefined): boolean => provider === PROVEDOR_DA_PAGINA;
export const ehInstagram = (provider: string | null | undefined): boolean => provider === PROVEDOR_DO_INSTAGRAM;
/** A conta é um canal dos posts (a Página ou o Instagram). */
export const ehCanalDaMeta = (provider: string | null | undefined): boolean => ehPagina(provider) || ehInstagram(provider);

/** A permissão de publicar do canal. */
const permissaoDo = (provider: string): string => (ehPagina(provider) ? META_PAGE_PUBLISH_SCOPE : META_INSTAGRAM_PUBLISH_SCOPE);

/**
 * A autorização tem a permissão de publicar no canal: `sim`, `nao` ou `nao_sei`. A coluna das permissões vazia (a
 * autorização anterior a 29/10/2026, ERR-179) é "não sei", nunca "não tem".
 */
export function publicaNo(provider: string, scopes: readonly string[] | null | undefined): 'sim' | 'nao' | 'nao_sei' {
  if (!scopes?.length) return 'nao_sei';
  return scopes.includes(permissaoDo(provider)) ? 'sim' : 'nao';
}

/** A autorização inclui publicar na Página, no Instagram, nos dois, em nenhum, ou não se sabe. */
export function oQueAAutorizacaoPublica(scopes: readonly string[] | null | undefined): 'os_dois' | 'pagina' | 'instagram' | 'nenhum' | 'nao_sei' {
  if (!scopes?.length) return 'nao_sei';
  const pagina = scopes.includes(META_PAGE_PUBLISH_SCOPE);
  const instagram = scopes.includes(META_INSTAGRAM_PUBLISH_SCOPE);
  return pagina && instagram ? 'os_dois' : pagina ? 'pagina' : instagram ? 'instagram' : 'nenhum';
}

// ------------------------------------------------------------------ a lista de contas

type SobreOCanal = Partial<Pick<DiscoveredAccount, 'has_instagram' | 'instagram_name' | 'page_name'>>;

/** O Instagram da Página, para a linha de baixo: "com o Instagram @x", "sem Instagram profissional ligado". */
function instagramDaPagina(c: SobreOCanal): string {
  if (c.instagram_name) return `com o Instagram ${c.instagram_name}`;
  return c.has_instagram ? 'com um Instagram profissional' : 'sem Instagram profissional ligado';
}

/** A Página do Instagram, para a linha de baixo: "ligado à Página X"; vazio quando não veio. */
function paginaDoInstagram(c: SobreOCanal): string {
  return c.page_name ? `ligado à Página ${c.page_name}` : '';
}

/** A linha de baixo do nome na lista, no lugar do código da Meta. */
export function subDoCanal(provider: string, c: SobreOCanal | null | undefined): string {
  if (ehPagina(provider)) return `Página do Facebook · ${instagramDaPagina(c ?? {})}`;
  const pagina = paginaDoInstagram(c ?? {});
  return pagina ? `Instagram profissional · ${pagina}` : 'Instagram profissional';
}

/** A linha de baixo no diálogo de escolher: o Instagram da Página, ou a Página do Instagram. */
export function subDaEscolhaDoCanal(d: DiscoveredAccount): string {
  return ehPagina(d.provider) ? instagramDaPagina(d) : paginaDoInstagram(d) || 'Instagram profissional';
}

/** A coluna "Última leitura": a Página e o Instagram não são lidos agora (o alcance de cada post é outra leitura). */
export const QUANDO_DO_CANAL = 'só publica';

/** O que "Desligar" confirma na linha, e o que o aviso diz depois (os posts já publicados continuam nas redes). */
export const confirmaDesligarCanal = (provider: string): string =>
  ehPagina(provider) ? 'Os posts deixam de sair nesta Página; os já marcados para ela não saem nela.' : 'Os posts deixam de sair neste Instagram; os já marcados para ele não saem nele.';
export const avisoCanalDesligado = (provider: string): string =>
  ehPagina(provider) ? 'Página desligada. Os posts já publicados nela continuam lá.' : 'Instagram desligado. Os posts já publicados nele continuam lá.';

/**
 * Situação da Página ou do Instagram na tabela: a conta primeiro (desconectada, como qualquer conta), depois a
 * permissão de publicar nele, pela autorização que o alcança (`scopes`), e a função dos posts. A permissão tirada na Meta
 * vira problema, com "Autorizar a Meta de novo"; a desconhecida não (ERR-179).
 */
export function situacaoDoCanal(c: AccountFreshness, scopes: readonly string[] | null | undefined, funcaoLigada: boolean): SituacaoConta {
  const pagina = ehPagina(c.provider);
  const base = { precisaDeVoce: false, reconectar: false, ultimaLeituraEm: null };
  if (c.status === 'desconectada') {
    return { ...base, rotulo: 'Desconectada', tom: 'perigo', motivo: c.status_reason ?? 'A Meta recusou a autorização deste canal.', precisaDeVoce: true, reconectar: true };
  }
  if (c.status === 'sem_permissao' || publicaNo(c.provider, scopes) === 'nao') {
    return {
      ...base,
      rotulo: 'Sem permissão',
      tom: 'perigo',
      motivo: pagina
        ? 'A permissão de publicar nesta Página foi tirada na Meta. Os posts marcados para ela não saem nela até você autorizar a Meta de novo.'
        : 'A permissão de publicar neste Instagram foi tirada na Meta. Os posts marcados para ele não saem nele até você autorizar a Meta de novo.',
      precisaDeVoce: true,
      reconectar: true,
    };
  }
  if (c.status === 'erro') {
    return { ...base, rotulo: 'Com problema', tom: 'atencao', motivo: c.status_reason ?? 'A última tentativa de publicar falhou.' };
  }
  if (!funcaoLigada) {
    return { ...base, rotulo: 'Posts parados', tom: 'espera', motivo: 'Os posts não estão ligados para a empresa: o Liame não publica aqui agora.' };
  }
  return { ...base, rotulo: pagina ? 'Pronta para publicar' : 'Pronto para publicar', tom: 'ok', motivo: 'Os posts aprovados da marca saem aqui.' };
}

/** O canal ligado que perdeu a permissão de publicar na Meta: o primeiro, para o aviso do topo. Nulo sem nenhum. */
export function canalSemPermissao(linhas: { nome: string; provider: string; brandId: string; situacao: SituacaoConta }[]): { nome: string; provider: string; brandId: string } | null {
  const l = linhas.find((x) => ehCanalDaMeta(x.provider) && x.situacao.rotulo === 'Sem permissão');
  return l ? { nome: l.nome, provider: l.provider, brandId: l.brandId } : null;
}

/** O aviso do topo quando um canal perdeu a permissão de publicar: o que parou e o que segue. */
export function faixaDoCanalSemPermissao(canal: { nome: string; provider: string }, outroSegue: boolean): { titulo: string; texto: string } {
  const pagina = ehPagina(canal.provider);
  const parou = pagina ? 'Os posts marcados para a Página não saem nela' : 'Os posts marcados para o Instagram não saem nele';
  const segue = outroSegue ? (pagina ? '; os do Instagram seguem' : '; os da Página seguem') : '';
  return {
    titulo: pagina ? `A Página ${canal.nome} não aceita mais posts do Liame` : `O Instagram ${canal.nome} não aceita mais posts do Liame`,
    texto: `A permissão de publicar ${pagina ? 'nela' : 'nele'} foi tirada na Meta. ${parou}${segue}. Autorize a Meta de novo para voltar.`,
  };
}

// ------------------------------------------------------------------ a autorização da Meta

/** As Páginas e os Instagram que esta autorização alcança e que ainda não estão ligados a nenhuma marca da empresa. */
export function canaisPorLigar(c: Pick<ConnectionResponse, 'discovered'>): { paginas: number; instagrams: number } {
  const livres = c.discovered.filter((d) => !d.linked);
  return { paginas: livres.filter((d) => ehPagina(d.provider)).length, instagrams: livres.filter((d) => ehInstagram(d.provider)).length };
}

/** "2 Páginas e 1 Instagram", "1 Página", "1 Instagram". */
export function paginasEInstagram({ paginas, instagrams }: { paginas: number; instagrams: number }): string {
  return listaEmPalavras([paginas ? (paginas === 1 ? '1 Página' : `${paginas} Páginas`) : '', instagrams ? `${instagrams} Instagram` : ''].filter(Boolean));
}

/**
 * O que o cartão da autorização da Meta diz dos posts, com a função ligada (nulo sem ela): o que ela inclui de publicar,
 * o aviso de quando falta alguma coisa e a ação principal (escolher a Página e o Instagram, ou autorizar de novo).
 * `ligadas`: a Página e o Instagram ligados por esta autorização (para dizer que a Página tirada parou e o Instagram segue).
 */
export function canaisNaAutorizacao(
  c: Pick<ConnectionResponse, 'scopes' | 'discovered' | 'accounts' | 'channel_search'>,
  funcaoLigada: boolean,
): { inclui: string | null; nota: NotaDoPerfil | null; acao: 'escolher' | 'autorizar' | null } | null {
  if (!funcaoLigada) return null;
  const publica = oQueAAutorizacaoPublica(c.scopes);
  // As permissões não foram lidas nesta autorização (anterior a 29/10/2026): a procura de novo as lê, sem afirmar nada.
  if (publica === 'nao_sei') {
    return {
      inclui: null,
      nota: { icone: 'info', destaque: null, texto: 'Para saber se esta autorização inclui publicar na Página e no Instagram, procure as contas de novo.' },
      acao: null,
    };
  }
  if (publica === 'nenhum') {
    return { inclui: null, nota: { icone: 'lock', destaque: null, texto: 'Esta autorização não inclui publicar na Página e no Instagram. As contas de anúncio são lidas normalmente.' }, acao: null };
  }
  const inclui =
    publica === 'os_dois'
      ? 'Inclui publicar na Página e no Instagram, sempre com a aprovação de uma pessoa.'
      : publica === 'pagina'
        ? 'Inclui publicar na Página, sempre com a aprovação de uma pessoa.'
        : 'Inclui publicar no Instagram, sempre com a aprovação de uma pessoa.';
  // A permissão de um canal ligado foi tirada na Meta: o que parou e o que segue.
  const ligadas = c.accounts.filter((a) => a.disconnected_at === null && ehCanalDaMeta(a.provider));
  const tirada = ligadas.find((a) => publicaNo(a.provider, c.scopes) === 'nao');
  if (tirada) {
    const pagina = ehPagina(tirada.provider);
    const outroSegue = ligadas.some((a) => a.provider !== tirada.provider && publicaNo(a.provider, c.scopes) === 'sim');
    return {
      inclui,
      nota: {
        icone: 'alert-circle',
        perigo: true,
        destaque: `A permissão de publicar ${pagina ? 'na Página' : 'no Instagram'} ${tirada.name} foi tirada na Meta.`,
        texto: `${pagina ? 'Os posts marcados para a Página não saem nela' : 'Os posts marcados para o Instagram não saem nele'}${
          outroSegue ? (pagina ? '; os do Instagram seguem' : '; os da Página seguem') : ''
        }. Autorize a Meta de novo para voltar.`,
      },
      acao: 'autorizar',
    };
  }
  const s = c.channel_search ?? null;
  if (s?.result === 'falhou' || s?.result === 'limite' || s?.result === 'sem_permissao') {
    // A procura que não deu certo não se repete sozinha: a pessoa procura de novo.
    return {
      inclui,
      nota: {
        icone: 'alert',
        destaque: 'Não deu para procurar as Páginas agora.',
        texto: `${s.result === 'limite' ? 'A Meta pediu para esperar.' : s.result === 'sem_permissao' ? 'A Meta recusou a procura.' : 'A Meta não respondeu.'} As contas de anúncio não foram afetadas. Procure de novo em alguns minutos.`,
      },
      acao: null,
    };
  }
  const porLigar = canaisPorLigar(c);
  // A Página que a autorização alcança sem Instagram profissional ligado a ela na Meta: o Liame não chega ao Instagram.
  const paginaSemInstagram = c.discovered.find((d) => ehPagina(d.provider) && d.has_instagram === false);
  const temInstagram = c.discovered.some((d) => ehInstagram(d.provider));
  if (paginaSemInstagram && !temInstagram && publica !== 'pagina') {
    return {
      inclui,
      nota: {
        icone: 'info',
        destaque: `A Página ${paginaSemInstagram.name} não tem um Instagram profissional ligado a ela na Meta.`,
        texto: 'O Liame só alcança o Instagram pela Página: ligue o Instagram profissional à Página na Meta e procure as contas de novo. A Página pode ser ligada sem ele.',
      },
      acao: porLigar.paginas ? 'escolher' : null,
    };
  }
  if (porLigar.paginas || porLigar.instagrams) {
    const quantos = paginasEInstagram(porLigar);
    const um = porLigar.paginas + porLigar.instagrams === 1;
    return {
      inclui,
      nota: {
        icone: 'info',
        destaque: `Esta autorização alcança ${quantos} que ainda não ${um ? 'está ligado' : 'estão ligados'}.`,
        texto: 'Ligue a Página e o Instagram da marca para os posts aprovados saírem neles.',
      },
      acao: 'escolher',
    };
  }
  if (s?.result === 'ok' && s.pages === 0 && s.instagrams === 0) {
    return {
      inclui,
      nota: {
        icone: 'info',
        destaque: 'Esta autorização não alcança nenhuma Página.',
        texto: 'Na tela da Meta, escolha a Página da marca (e o Instagram ligado a ela). Autorize a Meta de novo para escolher. As contas de anúncio não foram afetadas.',
      },
      acao: 'autorizar',
    };
  }
  return { inclui, nota: null, acao: null };
}

/**
 * O convite do topo: com a função ligada, a Meta conectada e nenhuma autorização da Meta que se saiba publicar, "Ligue os
 * posts na Página e no Instagram" (a marca da autorização mais nova). A autorização cujas permissões não se sabem
 * (anterior a 29/10/2026) não chama o convite: o cartão dela manda procurar de novo. Nulo sem convite.
 */
export function conviteDosPosts(
  autorizacoes: Pick<ConnectionResponse, 'provider' | 'status' | 'scopes' | 'brand_id' | 'created_at'>[],
  funcaoLigada: boolean,
): { brandId: string } | null {
  if (!funcaoLigada) return null;
  const daMeta = autorizacoes.filter((c) => c.provider === 'meta' && (c.status === 'ativa' || c.status === 'aguardando_escolha'));
  if (!daMeta.length || daMeta.some((c) => oQueAAutorizacaoPublica(c.scopes) !== 'nenhum')) return null;
  const maisNova = [...daMeta].sort((x, y) => y.created_at.localeCompare(x.created_at))[0]!;
  return { brandId: maisNova.brand_id };
}

export const CONVITE_DOS_POSTS = {
  titulo: 'Ligue os posts na Página e no Instagram',
  texto:
    'O Liame publica o post que uma pessoa aprova com o código do app, na hora marcada. A Meta já está conectada para os anúncios; para publicar, ela pede permissões a mais. As contas ligadas continuam como estão.',
  botao: 'Autorizar a Meta de novo',
};

// ------------------------------------------------------------------ conectar e escolher

/** A opção da Meta no diálogo de conectar, com a função ligada: os anúncios e os posts numa autorização só. */
export const META_COM_POSTS = {
  titulo: 'Meta Ads, Página e Instagram',
  texto: 'Os anúncios e os posts numa autorização só. Você escolhe as contas, a Página e o Instagram na tela da Meta.',
};

/** O aviso do diálogo de conectar, logo abaixo da opção da Meta, com a função ligada. */
export const NOTA_DAS_PERMISSOES_DE_PUBLICAR = {
  destaque: 'A Meta vai pedir permissões a mais: publicar na Página e no Instagram.',
  texto:
    'O Liame só publica o post que uma pessoa aprova com o código do app, na hora marcada, e nunca publica sozinho. Na tela da Meta, escolha também a Página e o Instagram da marca. Se essas permissões não forem concedidas lá, os anúncios conectam do mesmo jeito, sem os posts.',
};

/** A nota do diálogo de escolher sobre os canais (eles não são lidos; é neles que os posts saem). */
export const NOTA_DA_ESCOLHA_DOS_CANAIS =
  'A Página e o Instagram não são lidos agora: é neles que os posts aprovados da marca saem, um por vez, depois da aprovação com o código do app.';

/** O aviso depois de ligar a Página e o Instagram: "Página e Instagram ligados. Os posts aprovados da marca saem neles." */
export function avisoDosCanaisLigados(paginas: number, instagrams: number): string {
  if (!paginas && !instagrams) return '';
  if (paginas && instagrams) {
    return `${paginas === 1 ? 'Página' : 'Páginas'} e Instagram ligados. Os posts aprovados da marca saem neles.`;
  }
  if (instagrams) return `${instagrams === 1 ? 'Instagram ligado' : 'Instagram ligados'}. Os posts aprovados da marca saem ${instagrams === 1 ? 'nele' : 'neles'}.`;
  return paginas === 1 ? 'Página ligada. Os posts aprovados da marca saem nela.' : 'Páginas ligadas. Os posts aprovados da marca saem nelas.';
}

/** Os canais (Página e Instagram) contados à parte, entre as contas ligadas de uma autorização. */
export function canaisLigados(accounts: Pick<ConnectedAccountResponse, 'provider' | 'disconnected_at'>[]): { paginas: number; instagrams: number } {
  const ativas = accounts.filter((a) => a.disconnected_at === null);
  return { paginas: ativas.filter((a) => ehPagina(a.provider)).length, instagrams: ativas.filter((a) => ehInstagram(a.provider)).length };
}
