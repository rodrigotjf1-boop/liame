import type { AccountFreshness, ConnectedAccountResponse, ConnectionResponse, DiscoveredAccount } from '@liame/contracts';
import { dataCompleta, dia, diasAte, quandoComHora } from '@/lib/formato';
import { ESCOPO_DE_INFORMAR_VENDAS } from './vendas-google';

// Regras e frases de "Contas conectadas" (mockups/prototipo-contas.html). Funções puras: o "agora" entra
// como parâmetro (LIC-006). A API manda listas que crescem como texto (V23): valor desconhecido tem saída.

export type Autorizador = 'meta' | 'google' | 'regem';

const PLATAFORMAS: Record<string, { nome: string; classe: string }> = {
  meta_ads: { nome: 'Meta Ads', classe: 'meta' },
  google_ads: { nome: 'Google Ads', classe: 'google' },
  ga4: { nome: 'GA4', classe: 'ga4' },
  meta: { nome: 'Meta', classe: 'meta' },
  google: { nome: 'Google', classe: 'google' },
  // Produtos DMS (A2.5, protótipo P2): a loja do Regem e o número do RegemCast.
  regem: { nome: 'Regem', classe: 'regem' },
  regemcast: { nome: 'RegemCast', classe: 'regemcast' },
};

/** Nome e cor da plataforma (conta ou autorização). */
export function plataforma(provider: string | null): { nome: string; classe: string } {
  return (provider && PLATAFORMAS[provider]) || { nome: provider ?? 'Plataforma', classe: '' };
}

/** Quem autoriza a conta: a Meta (Meta Ads) ou o Google (Google Ads e GA4 numa autorização só). */
export function autorizadorDa(provider: string | null): Autorizador | null {
  if (provider === 'meta_ads' || provider === 'meta') return 'meta';
  if (provider === 'google_ads' || provider === 'ga4' || provider === 'google') return 'google';
  if (provider === 'regem') return 'regem';
  return null;
}

/** "A Meta" / "O Google" (ou em minúscula, no meio da frase). */
export function artigo(a: Autorizador | null, maiuscula = true): string {
  const t = a === 'meta' ? 'a Meta' : a === 'google' ? 'o Google' : a === 'regem' ? 'o Regem' : 'a plataforma';
  return maiuscula ? t[0]!.toUpperCase() + t.slice(1) : t;
}

/** "na Meta" / "no Google" / "no Regem". */
export function naPlataforma(a: Autorizador | null): string {
  return a === 'meta' ? 'na Meta' : a === 'google' ? 'no Google' : a === 'regem' ? 'no Regem' : 'na plataforma';
}

/** "da Meta" / "do Google" / "do Regem". */
export function daPlataforma(a: Autorizador | null): string {
  return a === 'meta' ? 'da Meta' : a === 'google' ? 'do Google' : a === 'regem' ? 'do Regem' : 'da plataforma';
}

/** Só endereço http(s) absoluto: a URL vem da nossa API, mas nada de `javascript:` por engano. */
export function enderecoSeguro(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null;
  } catch {
    return null;
  }
}

/**
 * O que a pessoa lê antes de ir autorizar: o que o Liame faz em cada plataforma com a autorização que ela vai dar.
 * `informaVendas`: a marca tem "vendas informadas ao Google" ligado, e a autorização do Google pede essa permissão.
 */
export function notaDeConectar(comRegem: boolean, informaVendas: boolean): string {
  const ida = 'Você vai para a página da plataforma, confirma lá e volta para cá.';
  const regem = comRegem ? ' No Regem, a única escrita possível é o cupom de campanha, sempre com aprovação.' : '';
  if (informaVendas) {
    return `${ida} Na Meta, o Liame só lê. No Google, lê e informa as vendas confirmadas no caixa, para a conversão que você escolher. Não cria, não muda e não gasta nada.${regem}`;
  }
  return comRegem ? `${ida} Na Meta e no Google, o Liame só lê: não cria, não muda e não gasta nada.${regem}` : `${ida} O Liame só lê: não cria, não muda e não gasta nada.`;
}

/** Id como a plataforma mostra: o Google Ads usa 444-555-6667. */
export function idDaConta(provider: string, externalId: string): string {
  if (provider === 'google_ads' && /^\d{10}$/.test(externalId)) return `${externalId.slice(0, 3)}-${externalId.slice(3, 6)}-${externalId.slice(6)}`;
  return externalId;
}

// ------------------------------------------------------------------ volta da autorização

export type ErroDaVolta = 'autorizacao_invalida' | 'autorizacao_expirada' | 'recusada_na_plataforma' | 'outro';
export type Volta = { conexao: string | null; erro: ErroDaVolta | null };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ERROS: ErroDaVolta[] = ['autorizacao_invalida', 'autorizacao_expirada', 'recusada_na_plataforma'];

/** Lê `?conexao=<id>` e `?erro=<código>` da volta do OAuth; id fora do formato é ignorado. */
export function lerVolta(params: { get(nome: string): string | null }): Volta {
  const id = params.get('conexao');
  const erro = params.get('erro');
  return {
    conexao: id && UUID.test(id) ? id.toLowerCase() : null,
    erro: erro ? (ERROS.includes(erro as ErroDaVolta) ? (erro as ErroDaVolta) : 'outro') : null,
  };
}

/** Conexão ainda sendo conferida pelo worker (troca do código e descoberta das contas). */
export function emConferencia(c: Pick<ConnectionResponse, 'status'>): boolean {
  return c.status === 'recebida' || c.status === 'processando';
}

/** Contas descobertas que ainda não estão ligadas a nenhuma marca da empresa. */
export function naoLigadas(c: Pick<ConnectionResponse, 'discovered'>): DiscoveredAccount[] {
  return c.discovered.filter((d) => !d.linked);
}

/** Conta já ligada na empresa (de `GET /v1/connections`), para saber se a autorização nova a reconecta. */
export type ContaExistente = Pick<ConnectedAccountResponse, 'provider' | 'external_id' | 'status' | 'connection_id' | 'disconnected_at'> & {
  /** Quando vence a autorização que hoje lê esta conta (Google em fase de teste); ausente ou nulo = não vence. */
  vence_em?: string | null;
  /** A autorização que hoje lê esta conta inclui a permissão de informar vendas ao Google; ausente = não se sabe. */
  informa_vendas?: boolean;
};

/** As contas já ligadas, cada uma com o vencimento e a permissão de informar vendas da autorização que a lê hoje. */
export function contasExistentes(conexoes: (Pick<ConnectionResponse, 'accounts' | 'refresh_expires_at'> & Partial<Pick<ConnectionResponse, 'scopes'>>)[]): ContaExistente[] {
  return conexoes.flatMap((c) =>
    c.accounts.map((a) => ({ ...a, vence_em: c.refresh_expires_at ?? null, ...(c.scopes ? { informa_vendas: c.scopes.includes(ESCOPO_DE_INFORMAR_VENDAS) } : {}) })),
  );
}

/** `renovar`: a autorização de hoje vence antes; `permissao`: esta inclui informar vendas ao Google e a de hoje não. */
export type Escolhivel = { conta: DiscoveredAccount; reconectar: boolean; renovar?: boolean; permissao?: boolean };

/**
 * O que a pessoa pode ligar com esta autorização: as contas novas e as que estão ligadas por outra
 * autorização que a plataforma recusou ("Desconectada"): ligar de novo passa a conta para a credencial
 * nova (a API faz isso quando a marca é a mesma). Também as que são lidas por outra autorização que VENCE
 * antes desta (Google em fase de teste): é assim que "conectar de novo antes" renova a leitura sem ela
 * parar (ERR-052). E as contas do Google lidas por outra autorização SEM a permissão de informar vendas, quando esta
 * a inclui: é assim que "autorizar o Google de novo" faz a conta poder informar (A5, Y1; no servidor, a autorização
 * nova assume a conta). As outras já ligadas ficam travadas.
 */
export function escolhiveis(
  c: Pick<ConnectionResponse, 'id' | 'discovered'> & Partial<Pick<ConnectionResponse, 'refresh_expires_at' | 'scopes'>>,
  existentes: ContaExistente[],
): Escolhivel[] {
  const ganhamPermissao = new Set(
    c.scopes?.includes(ESCOPO_DE_INFORMAR_VENDAS)
      ? existentes
          .filter((e) => e.disconnected_at === null && e.connection_id !== c.id && (e.provider === 'google_ads' || e.provider === 'ga4') && e.informa_vendas === false)
          .map((e) => `${e.provider}:${e.external_id}`)
      : [],
  );
  const fimDesta = c.refresh_expires_at ? new Date(c.refresh_expires_at).getTime() : Number.POSITIVE_INFINITY;
  const renovaveis = new Set(
    existentes
      .filter((e) => e.disconnected_at === null && e.connection_id !== c.id && !!e.vence_em && new Date(e.vence_em).getTime() < fimDesta)
      .map((e) => `${e.provider}:${e.external_id}`),
  );
  const recusadas = new Set(
    existentes
      .filter((e) => e.disconnected_at === null && e.status === 'desconectada' && e.connection_id !== c.id)
      .map((e) => `${e.provider}:${e.external_id}`),
  );
  // Loja do Regem ligada por OUTRA autorização: esta troca o token dela (o antigo parou de valer no Regem
  // quando o novo nasceu), então ela entra de novo na escolha, como reconexão.
  const trocaDeToken = new Set(
    existentes.filter((e) => e.disconnected_at === null && e.provider === 'regem' && e.connection_id !== c.id).map((e) => `${e.provider}:${e.external_id}`),
  );
  return c.discovered.flatMap((d): Escolhivel[] => {
    if (!d.linked) return [{ conta: d, reconectar: false }];
    const k = `${d.provider}:${d.external_id}`;
    if (recusadas.has(k) || trocaDeToken.has(k)) return [{ conta: d, reconectar: true }];
    if (renovaveis.has(k)) return [{ conta: d, reconectar: true, renovar: true, ...(ganhamPermissao.has(k) ? { permissao: true } : {}) }];
    return ganhamPermissao.has(k) ? [{ conta: d, reconectar: true, permissao: true }] : [];
  });
}

export type Faixa =
  | { tipo: 'escolher'; titulo: string; texto: string; botao?: string }
  | { tipo: 'conferindo'; titulo: string; texto: string }
  | { tipo: 'demorando'; titulo: string; texto: string }
  | { tipo: 'erro'; titulo: string; texto: string; autorizador: Autorizador | null };

/** Texto da falha de uma conexão pelo código que a API guarda (`error_code`) ou devolve na volta. */
export function erroDaConexao(codigo: string | null, a: Autorizador | null): { titulo: string; texto: string } {
  switch (codigo) {
    case 'recusada_na_plataforma':
      return { titulo: `${artigo(a)} não autorizou a conexão.`, texto: 'A autorização foi recusada ou fechada antes do fim. Nada foi ligado.' };
    case 'autorizacao_expirada':
      return { titulo: 'A autorização demorou demais.', texto: `A volta ${daPlataforma(a)} chegou depois de 10 minutos. Nada foi ligado: conecte de novo.` };
    case 'autorizacao_invalida':
      return { titulo: 'Não reconhecemos essa autorização.', texto: 'O link de volta já foi usado, é de outra pessoa ou venceu. Nada foi ligado: conecte de novo.' };
    case 'troca_recusada':
    case 'credencial_recusada':
      return { titulo: `${artigo(a)} recusou a autorização.`, texto: 'A plataforma não aceitou a autorização. Nada foi ligado: conecte de novo.' };
    case 'sem_permissao':
      return {
        titulo: `Faltou permissão ${naPlataforma(a)}.`,
        texto: a === 'regem' ? 'A autorização não deu acesso às lojas. Conecte de novo.' : 'A autorização não deu acesso às contas. Conecte de novo e aceite as permissões pedidas.',
      };
    case 'plataforma_indisponivel':
      return { titulo: `${artigo(a)} não respondeu.`, texto: 'Tentamos algumas vezes e a plataforma não respondeu. Tente de novo em instantes.' };
    default:
      return { titulo: 'Não deu para concluir a conexão.', texto: 'Algo falhou ao buscar as contas. Tente de novo; se continuar, fale com o suporte.' };
  }
}

/**
 * A faixa do topo depois da volta da plataforma (protótipo: escolher, conferindo, recusada), a partir
 * dos parâmetros da URL e da conexão lida da API (nula enquanto não chegou ou se não existe).
 */
export function faixaDaVolta(
  volta: Volta,
  conexao: ConnectionResponse | null,
  marca: string,
  { esgotou = false, existentes = [] }: { esgotou?: boolean; existentes?: ContaExistente[] } = {},
): Faixa | null {
  const a = conexao ? autorizadorDa(conexao.provider) : null;
  if (volta.erro) {
    const codigo = volta.erro === 'outro' ? null : volta.erro;
    return { tipo: 'erro', autorizador: a, ...erroDaConexao(codigo, a) };
  }
  if (!conexao) return null;
  if (conexao.status === 'expirada') return { tipo: 'erro', autorizador: a, ...erroDaConexao('autorizacao_expirada', a) };
  if (conexao.status === 'erro') return { tipo: 'erro', autorizador: a, ...erroDaConexao(conexao.error_code, a) };
  if (emConferencia(conexao)) {
    if (esgotou) {
      return {
        tipo: 'demorando',
        titulo: `Ainda conferindo a autorização com ${artigo(a, false)}.`,
        texto: `Está levando mais que o normal. As ${a === 'regem' ? 'lojas' : 'contas'} aparecem aqui assim que a conferência terminar.`,
      };
    }
    return {
      tipo: 'conferindo',
      titulo: `Conferindo a autorização com ${artigo(a, false)}…`,
      texto: `Estamos buscando as ${a === 'regem' ? 'lojas' : 'contas'} que você liberou. Leva alguns segundos; pode continuar usando o Liame.`,
    };
  }
  if (escolhiveis(conexao, existentes).length && (conexao.status === 'aguardando_escolha' || conexao.status === 'ativa')) {
    if (a === 'regem') {
      const n = escolhiveis(conexao, existentes).length;
      return {
        tipo: 'escolher',
        titulo: `O Regem autorizou ${n === 1 ? '1 loja' : `${n} lojas`}.`,
        texto: `${n === 1 ? 'Ligue a loja' : 'Ligue cada uma'} a uma loja do Liame. A primeira leitura traz os pedidos dos últimos 90 dias.`,
        botao: 'Ligar lojas',
      };
    }
    const total = conexao.discovered.length;
    return {
      tipo: 'escolher',
      titulo: `${artigo(a)} autorizou. Encontramos ${total} ${total === 1 ? 'conta' : 'contas'}.`,
      texto: `${resumoDaDescoberta(conexao.discovered)}. Escolha quais ligar à marca ${marca}.`,
    };
  }
  return null;
}

/** "2 do Google Ads e 2 propriedades do GA4" / "3 contas de anúncio da Meta". */
export function resumoDaDescoberta(d: DiscoveredAccount[]): string {
  const n = (p: string) => d.filter((x) => x.provider === p).length;
  const partes: string[] = [];
  const meta = n('meta_ads');
  const ads = n('google_ads');
  const ga4 = n('ga4');
  if (meta) partes.push(`${meta} ${meta === 1 ? 'conta de anúncio' : 'contas de anúncio'} da Meta`);
  if (ads) partes.push(`${ads} do Google Ads`);
  if (ga4) partes.push(`${ga4} ${ga4 === 1 ? 'propriedade' : 'propriedades'} do GA4`);
  const outras = d.length - meta - ads - ga4;
  if (outras) partes.push(`${outras} de outra plataforma`);
  if (!partes.length) return 'Nenhuma conta';
  return partes.length === 1 ? partes[0]! : `${partes.slice(0, -1).join(', ')} e ${partes.at(-1)}`;
}

const TITULO_DO_GRUPO: Record<string, string> = { meta_ads: 'Meta Ads', google_ads: 'Google Ads', ga4: 'Google Analytics (GA4)', regem: 'Lojas do Regem', regemcast: 'RegemCast' };

/** As descobertas agrupadas por plataforma, na ordem Meta, Google Ads, GA4 (as ligadas primeiro não). */
export function gruposDaEscolha(d: DiscoveredAccount[]): { provider: string; titulo: string; contas: DiscoveredAccount[] }[] {
  const ordem = ['meta_ads', 'google_ads', 'ga4'];
  const provedores = [...new Set(d.map((x) => x.provider))].sort((x, y) => {
    const ix = ordem.indexOf(x);
    const iy = ordem.indexOf(y);
    return (ix < 0 ? 99 : ix) - (iy < 0 ? 99 : iy) || x.localeCompare(y);
  });
  return provedores.map((p) => ({
    provider: p,
    titulo: TITULO_DO_GRUPO[p] ?? p,
    contas: d.filter((x) => x.provider === p).sort((x, y) => x.name.localeCompare(y.name, 'pt-BR')),
  }));
}

/** Rótulo do botão da escolha: "Ligar 2 contas" ou, sem nenhuma marcada, "Escolha ao menos uma". */
export function botaoLigar(n: number): string {
  if (!n) return 'Escolha ao menos uma';
  return `Ligar ${n} ${n === 1 ? 'conta' : 'contas'}`;
}

// ------------------------------------------------------------------ contas ligadas

export type Tom = 'ok' | 'atencao' | 'perigo' | 'espera' | 'lendo';
export type SituacaoConta = {
  rotulo: string;
  tom: Tom;
  motivo: string | null;
  /** Entra no filtro "Precisam de você" (a pessoa precisa agir). */
  precisaDeVoce: boolean;
  /** A plataforma recusou: a ação da linha é conectar de novo. */
  reconectar: boolean;
  ultimaLeituraEm: string | null;
};

/** Situação da conta como a tabela mostra: status da conta primeiro, depois o frescor dos números. */
export function situacaoDaConta(c: AccountFreshness): SituacaoConta {
  const metricas = c.datasets.find((x) => x.dataset === 'metricas') ?? c.datasets[0] ?? null;
  const ultimaLeituraEm = metricas?.last_success_at ?? null;
  if (c.status === 'desconectada') {
    return { rotulo: 'Desconectada', tom: 'perigo', motivo: c.status_reason ?? 'A plataforma recusou a autorização.', precisaDeVoce: true, reconectar: true, ultimaLeituraEm };
  }
  if (c.status === 'sem_permissao') {
    return { rotulo: 'Sem permissão', tom: 'atencao', motivo: c.status_reason ?? 'Falta permissão de leitura na plataforma.', precisaDeVoce: true, reconectar: false, ultimaLeituraEm };
  }
  if (c.status === 'erro') {
    return { rotulo: 'Leitura falhando', tom: 'atencao', motivo: c.status_reason ?? 'A última leitura falhou; tentamos de novo sozinhos.', precisaDeVoce: false, reconectar: false, ultimaLeituraEm };
  }
  switch (metricas?.freshness) {
    case 'fresh':
      return { rotulo: 'Em dia', tom: 'ok', motivo: null, precisaDeVoce: false, reconectar: false, ultimaLeituraEm };
    case 'delayed':
    case 'stale':
      return { rotulo: 'Atrasado', tom: 'atencao', motivo: null, precisaDeVoce: false, reconectar: false, ultimaLeituraEm };
    default:
      return { rotulo: 'Primeira leitura', tom: 'espera', motivo: 'A primeira leitura (90 dias) leva alguns minutos.', precisaDeVoce: false, reconectar: false, ultimaLeituraEm };
  }
}

/** "hoje, 06:12", "ontem, 06:20", "há 2 dias", a data, ou "nunca". */
export function ultimaLeitura(iso: string | null, agora: Date): string {
  if (!iso) return 'nunca';
  const dias = -diasAte(iso, agora);
  if (dias <= 1) return quandoComHora(iso, agora);
  if (dias < 30) return `há ${dias} dias`;
  return dia(iso, agora);
}

/**
 * Autorizações que a tela lista: as que valem (com contas ligadas ou esperando a escolha) e as que
 * falharam depois de já ter valido. Tentativa que nunca chegou a valer aparece só na faixa da volta.
 */
export function autorizacoesVisiveis(conexoes: ConnectionResponse[]): ConnectionResponse[] {
  return conexoes.filter((c) => {
    if (c.status === 'revogada' || c.status === 'expirada' || c.status === 'aguardando_autorizacao') return false;
    if (c.status === 'ativa' || c.status === 'aguardando_escolha') return true;
    return c.completed_at !== null || c.accounts.some((a) => a.disconnected_at === null);
  });
}

/** Primeiro nome de quem autorizou ("Autorizada por Rodrigo"), ou nulo quando a API não devolve o nome. */
export function quemAutorizou(c: Pick<ConnectionResponse, 'authorized_by'>): string | null {
  return c.authorized_by?.trim().split(/\s+/)[0] || null;
}

/** Contas ligadas (ainda não desligadas) de uma autorização. */
export function contasDaAutorizacao(c: ConnectionResponse): number {
  return c.accounts.filter((a) => a.disconnected_at === null).length;
}

/** "Vence em 29/09/2026 (app do Google em fase de teste)…", ou nulo quando a autorização não vence. */
export function vencimentoDaAutorizacao(c: Pick<ConnectionResponse, 'refresh_expires_at'>, agora: Date): { venceu: boolean; texto: string } | null {
  if (!c.refresh_expires_at) return null;
  const venceu = new Date(c.refresh_expires_at).getTime() <= agora.getTime();
  const data = dataCompleta(c.refresh_expires_at);
  return venceu
    ? { venceu, texto: `Venceu em ${data} (app do Google em fase de teste). Conecte de novo para a leitura voltar.` }
    : { venceu, texto: `Vence em ${data} (app do Google em fase de teste). Conecte de novo antes para a leitura não parar.` };
}

// ------------------------------------------------------------------ lojas do Regem (protótipo P2, aprovado em 29/09/2026)

/** O que o Liame pede ao Regem, na ordem do protótipo. `financeiro`: só sai com permissão financeira; `escrita`: fica desligado no Liame. */
const ESCOPOS_REGEM: { cod: string; rotulo: string; texto: string; financeiro?: boolean; escrita?: boolean }[] = [
  { cod: 'pedidos.ler', rotulo: 'Pedidos', texto: 'Pedidos confirmados e cancelados, com itens, canal, cupom usado e a origem do clique.' },
  { cod: 'custos.ler', rotulo: 'Custo dos itens', texto: 'Custo de cada item, para calcular a margem. Sem ele, a margem fica desconhecida, nunca zero.', financeiro: true },
  { cod: 'clientes.anonimizacao.ler', rotulo: 'Aviso de cliente anonimizado', texto: 'Quando o Regem anonimiza um cliente, o Liame apaga o identificador dele.' },
  { cod: 'cupons.ler', rotulo: 'Cupons', texto: 'Cupons da loja, com regra e validade.' },
  { cod: 'cupons.uso.ler', rotulo: 'Usos dos cupons', texto: 'Em qual pedido cada cupom foi usado, quando e com que valor.' },
  { cod: 'cupons.criar', rotulo: 'Criar cupom de campanha', texto: 'Criar e desativar cupom pelo Liame, sempre com aprovação. Fica desligado até a sua empresa ligar.', escrita: true },
];
/** Liberados que o protótipo não lista: aparecem só quando a loja libera. */
const ESCOPOS_EXTRAS: Record<string, { rotulo: string; texto: string }> = {
  'clientes.telefone.ler': {
    rotulo: 'Telefone do cliente, pseudonimizado',
    texto: 'O telefone vira um identificador pseudonimizado na chegada e não fica guardado; liga a conversa do anúncio ao pedido.',
  },
};

export type EscopoDaLoja = { cod: string; rotulo: string; texto: string; estado: 'liberado' | 'nao_liberado' | 'desligado' };

/** A loja não libera o custo dos itens (sem ele, a margem fica desconhecida). */
export function semCusto(scopes: string[]): boolean {
  return !scopes.includes('custos.ler');
}

/** Por que o custo não veio: quem autorizou não tinha permissão financeira, ou o token da distribuição saiu sem ele. */
export function motivoSemCusto(origem: string): string {
  return origem === 'distribuicao'
    ? 'O token desta loja foi emitido sem o custo dos itens.'
    : 'Quem autorizou não tem permissão financeira no Regem. Para liberar, um presidente autoriza de novo.';
}

/** "O que o Liame recebe": cada escopo do protótipo com a situação dele, mais os liberados fora da lista. */
export function escoposDoRegem(scopes: string[], origem: string, escritaLigada = false): EscopoDaLoja[] {
  const lista: EscopoDaLoja[] = ESCOPOS_REGEM.map((e) => {
    if (!scopes.includes(e.cod)) return { cod: e.cod, rotulo: e.rotulo, texto: e.financeiro ? motivoSemCusto(origem) : e.texto, estado: 'nao_liberado' };
    // A escrita (criar cupom) só vale quando a empresa a tem ligada no Liame; a loja já ter liberado não basta.
    if (e.escrita && escritaLigada) return { cod: e.cod, rotulo: e.rotulo, texto: 'Criar cupom de campanha pelo Liame, sempre com aprovação de alguém da sua empresa.', estado: 'liberado' };
    return { cod: e.cod, rotulo: e.rotulo, texto: e.texto, estado: e.escrita ? 'desligado' : 'liberado' };
  });
  const conhecidos = new Set(ESCOPOS_REGEM.map((e) => e.cod));
  for (const cod of scopes) {
    if (conhecidos.has(cod)) continue;
    const extra = ESCOPOS_EXTRAS[cod];
    lista.push({ cod, rotulo: extra?.rotulo ?? cod, texto: extra?.texto ?? 'Liberado pela loja no Regem.', estado: 'liberado' });
  }
  return lista;
}

/** Os pedidos chegam a cada 15 minutos: atraso só depois de 2 horas sem leitura (o mesmo limite da Atenção, F9). */
const PEDIDOS_ATRASADOS_MS = 2 * 3_600_000;

/** Situação da loja do Regem na tabela: a conexão primeiro, depois a leitura dos pedidos e o que a loja libera. */
export function situacaoDaLoja(c: AccountFreshness, loja: { scopes: string[]; origem: string }, agora: Date): SituacaoConta {
  const pedidos = c.datasets.find((x) => x.dataset === 'pedidos') ?? null;
  const ultimaLeituraEm = pedidos?.last_success_at ?? null;
  if (c.status === 'desconectada') {
    return { rotulo: 'Desconectada', tom: 'perigo', motivo: c.status_reason ?? 'A autorização foi revogada no Regem — conecte de novo.', precisaDeVoce: true, reconectar: true, ultimaLeituraEm };
  }
  if (c.status === 'sem_permissao') {
    return { rotulo: 'Sem permissão', tom: 'atencao', motivo: c.status_reason ?? 'A loja não liberou a leitura dos pedidos.', precisaDeVoce: true, reconectar: false, ultimaLeituraEm };
  }
  if (c.status === 'erro') {
    return { rotulo: 'Leitura falhando', tom: 'atencao', motivo: c.status_reason ?? 'A última leitura falhou; tentamos de novo sozinhos.', precisaDeVoce: false, reconectar: false, ultimaLeituraEm };
  }
  if (!ultimaLeituraEm) {
    return { rotulo: 'Primeira leitura', tom: 'lendo', motivo: 'Trazendo os pedidos dos últimos 90 dias. Leva alguns minutos.', precisaDeVoce: false, reconectar: false, ultimaLeituraEm };
  }
  if (agora.getTime() - new Date(ultimaLeituraEm).getTime() > PEDIDOS_ATRASADOS_MS) {
    return { rotulo: 'Pedidos atrasados', tom: 'atencao', motivo: null, precisaDeVoce: false, reconectar: false, ultimaLeituraEm };
  }
  if (semCusto(loja.scopes)) {
    const motivo =
      loja.origem === 'distribuicao'
        ? 'O token desta loja foi emitido sem o custo dos itens: a margem desta loja fica desconhecida.'
        : 'Quem autorizou não tem permissão financeira no Regem: a margem desta loja fica desconhecida.';
    return { rotulo: 'Sem custos', tom: 'atencao', motivo, precisaDeVoce: true, reconectar: false, ultimaLeituraEm };
  }
  return { rotulo: 'Pedidos em dia', tom: 'ok', motivo: null, precisaDeVoce: false, reconectar: false, ultimaLeituraEm };
}

/** "Loja no Liame: Centro · token próprio da loja" (a linha de baixo do nome, na tabela). */
export function subDaLoja(unitName: string | null): string {
  return unitName ? `Loja no Liame: ${unitName} · token próprio da loja` : 'Sem loja no Liame · token próprio da loja';
}

/** `botao`: o que a faixa oferece quando dá para conectar o Regem ("Conectar o Regem de novo", "Autorizar de novo"). */
export type FaixaDoRegem = { tipo: 'perigo' | 'atencao'; titulo: string; texto: string; botao: string };

/** A faixa do topo para as lojas do Regem: a revogada primeiro; depois, a que não libera o custo. */
export function faixaDoRegem(lojas: { nome: string; desconectada: boolean; semCusto: boolean; origem: string }[]): FaixaDoRegem | null {
  const fora = lojas.find((l) => l.desconectada);
  if (fora) {
    return {
      tipo: 'perigo',
      titulo: 'A autorização foi revogada no Regem — conecte de novo',
      texto: `Os pedidos da ${fora.nome} pararam de chegar. Até conectar de novo, os Resultados mostram o caixa só até a última leitura.`,
      botao: 'Conectar o Regem de novo',
    };
  }
  const sem = lojas.find((l) => l.semCusto);
  if (!sem) return null;
  const porque = sem.origem === 'distribuicao' ? 'O token da loja foi emitido sem o custo dos itens.' : 'Quem autorizou não tem permissão financeira no Regem.';
  const comoLiberar = sem.origem === 'distribuicao' ? '' : ' Para liberar, um presidente autoriza de novo.';
  return {
    tipo: 'atencao',
    titulo: 'O Regem liberou os pedidos, mas não o custo dos itens',
    texto: `${porque} Sem o custo, a margem fica desconhecida e os Resultados não dizem se deu lucro.${comoLiberar}`,
    botao: 'Autorizar de novo',
  };
}

/** A autorização do Regem foi revogada do lado de lá: todas as lojas dela estão desconectadas (ou a conexão falhou). */
export function regemRevogado(c: ConnectionResponse): boolean {
  const lojas = c.accounts.filter((a) => a.disconnected_at === null);
  return c.status === 'erro' || (lojas.length > 0 && lojas.every((a) => a.status === 'desconectada'));
}

// ------------------------------------------------------------------ conectar o Regem e ligar as lojas (P2, parte 2)

/**
 * "O que o Liame pede" no diálogo de conectar: o que vai sempre e o que o presidente decide na página do
 * Regem (o custo, que exige permissão financeira lá, e o cupom de campanha).
 */
export function pedidosAoRegem(): { cod: string; rotulo: string; texto: string; opcional: boolean; nota: string | null }[] {
  return ESCOPOS_REGEM.map((e) => ({
    cod: e.cod,
    rotulo: e.rotulo,
    texto: e.texto,
    opcional: Boolean(e.financeiro || e.escrita),
    nota: e.financeiro ? 'só com permissão financeira' : e.escrita ? 'com aprovação' : null,
  }));
}

/** O que a autorização pelo Regem nunca entrega (a página de lá diz o mesmo). */
export const NUNCA_VEM_DO_REGEM = [
  'Nome, telefone, e-mail e endereço de cliente.',
  'Equipe, escala, ponto, estoque e caixa da loja.',
  'Senha ou acesso à sua conta do Regem.',
];

/** As etiquetas do que a loja libera, no diálogo de ligar as lojas: liberado, desligado no Liame ou não liberado. */
export function chipsDoRegem(scopes: string[], origem: string, escritaLigada = false): { cod: string; texto: string; classe: string }[] {
  return escoposDoRegem(scopes, origem, escritaLigada).map((e) => ({
    cod: e.cod,
    texto: e.estado === 'nao_liberado' ? `${e.rotulo}: não liberado` : e.estado === 'desligado' ? `${e.rotulo} · desligado no Liame` : e.rotulo,
    classe: e.estado === 'nao_liberado' ? 'st--aguardando' : e.estado === 'desligado' ? 'st--espera' : 'st--concluido',
  }));
}

/** A loja do Liame que já vem escolhida para uma loja do Regem: a de mesmo nome; sem ela, "Criar loja no Liame" (vazio). */
export function lojaSugerida(nomeNoRegem: string, lojas: { id: string; name: string }[]): string {
  const chave = (s: string) => s.trim().toLowerCase();
  return lojas.find((u) => chave(u.name) === chave(nomeNoRegem))?.id ?? '';
}

/** As lojas do Regem que apontam para a MESMA loja do Liame ("criar loja", vazio, nunca repete). */
export function lojasRepetidas(escolha: Record<string, string>): Set<string> {
  const porLoja = new Map<string, string[]>();
  for (const [doRegem, doLiame] of Object.entries(escolha)) {
    if (!doLiame) continue;
    porLoja.set(doLiame, [...(porLoja.get(doLiame) ?? []), doRegem]);
  }
  return new Set([...porLoja.values()].filter((l) => l.length > 1).flat());
}
