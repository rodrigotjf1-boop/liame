import type { ClosedLoopResponse, ConfirmedResult, ConnectionResponse, PlatformResult, SourceFreshness } from '@liame/contracts';
import { plataforma } from '@/components/contas/textos';
import type { NomeIcone } from '@/components/ui/icone';
import { inteiro, reaisDeMicros } from '@/lib/formato';

// Regras e frases de "Resultados" (mockups/prototipo-resultados.html, P1 aprovado em 29/09/2026). A conta
// é do servidor (ROAS, margem, cobertura e veredito vêm prontos da API); aqui só se escolhe o que mostrar.
// Dinheiro chega em micros (texto) e sai em reais sem ponto flutuante. Funções puras: o "agora" e o fuso
// entram como parâmetro (LIC-006). Listas que crescem chegam como texto (V23): valor novo tem saída.

// ------------------------------------------------------------------ período e fuso

export type Periodo = 'hoje' | '7' | '30';

export const PERIODOS: { id: Periodo; botao: string; rotulo: string }[] = [
  { id: 'hoje', botao: 'Hoje', rotulo: 'hoje' },
  { id: '7', botao: '7 dias', rotulo: 'últimos 7 dias' },
  { id: '30', botao: '30 dias', rotulo: 'últimos 30 dias' },
];

/** O mesmo padrão da API quando a loja não diz o fuso. */
export const FUSO_PADRAO = 'America/Sao_Paulo';

export function rotuloDoPeriodo(p: Periodo): string {
  return PERIODOS.find((x) => x.id === p)?.rotulo ?? p;
}

/** Fuso que o navegador reconhece; o que não reconhece cai no padrão (não quebra a tela). */
export function fusoValido(fuso: string | null | undefined): string {
  if (!fuso) return FUSO_PADRAO;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: fuso });
    return fuso;
  } catch {
    return FUSO_PADRAO;
  }
}

/** Dia (AAAA-MM-DD) daquele instante no fuso. */
export function dataNoFuso(instante: Date, fuso: string): string {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: fuso, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(instante);
  const v = (t: Intl.DateTimeFormatPartTypes) => p.find((x) => x.type === t)?.value ?? '';
  return `${v('year')}-${v('month')}-${v('day')}`;
}

/** "14:20" no fuso. */
export function horaNoFuso(instante: Date, fuso: string): string {
  return new Intl.DateTimeFormat('pt-BR', { timeZone: fuso, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(instante);
}

/** Soma dias a uma data AAAA-MM-DD (conta de calendário, sem fuso). */
export function somarDias(data: string, dias: number): string {
  const [a, m, d] = data.split('-').map(Number);
  return new Date(Date.UTC(a!, m! - 1, d! + dias)).toISOString().slice(0, 10);
}

/**
 * Datas que a API recebe, no fuso da loja: "Hoje" é o dia de hoje até agora; 7 e 30 dias são os últimos
 * dias completos, sem hoje (como no protótipo: em 29/09, "7 dias" = 22/09 a 28/09).
 */
export function intervaloDo(periodo: Periodo, fuso: string, agora: Date): { from: string; to: string } {
  const hoje = dataNoFuso(agora, fuso);
  if (periodo === 'hoje') return { from: hoje, to: hoje };
  const dias = periodo === '7' ? 7 : 30;
  return { from: somarDias(hoje, -dias), to: somarDias(hoje, -1) };
}

/** "28/09" a partir de AAAA-MM-DD. */
export function diaMes(data: string): string {
  const [, m, d] = data.split('-');
  return `${d}/${m}`;
}

/** "hoje, 06:12", "ontem, 23:10" ou "28/09, 06:12", no fuso da loja. */
export function quandoNoFuso(iso: string, fuso: string, agora: Date): string {
  const instante = new Date(iso);
  const dia = dataNoFuso(instante, fuso);
  const hoje = dataNoFuso(agora, fuso);
  const hora = horaNoFuso(instante, fuso);
  if (dia === hoje) return `hoje, ${hora}`;
  if (dia === somarDias(hoje, -1)) return `ontem, ${hora}`;
  return `${diaMes(dia)}${dia.slice(0, 4) === hoje.slice(0, 4) ? '' : `/${dia.slice(0, 4)}`}, ${hora}`;
}

/** "28/09, 21:03" no fuso da loja (lista de pedidos e linha do tempo). */
export function diaHoraNoFuso(iso: string, fuso: string): string {
  const instante = new Date(iso);
  return `${diaMes(dataNoFuso(instante, fuso))}, ${horaNoFuso(instante, fuso)}`;
}

const NOMES_DE_FUSO: Record<string, string> = { 'America/Sao_Paulo': 'Brasília' };

/** "Brasília", "Los Angeles", "Manaus". */
export function nomeDoFuso(fuso: string): string {
  return NOMES_DE_FUSO[fuso] ?? (fuso.split('/').pop() ?? fuso).replaceAll('_', ' ');
}

/** Deslocamento do fuso em minutos naquele instante (−180 em Brasília); nulo se o navegador não souber. */
export function deslocamentoDoFuso(fuso: string, instante: Date): number | null {
  try {
    const nome = new Intl.DateTimeFormat('en-US', { timeZone: fuso, timeZoneName: 'longOffset' })
      .formatToParts(instante)
      .find((p) => p.type === 'timeZoneName')?.value;
    if (nome === 'GMT') return 0;
    // "GMT-07:00" ou "GMT+05:30" (formato fixo do Intl; lido por posição, sem regex).
    if (!nome || nome.length !== 9 || !nome.startsWith('GMT')) return null;
    const minutos = Number(nome.slice(4, 6)) * 60 + Number(nome.slice(7, 9));
    if (!Number.isFinite(minutos)) return null;
    return nome[3] === '-' ? -minutos : minutos;
  } catch {
    return null;
  }
}

/** "UTC−3", "UTC+5:30", "UTC". */
export function utc(minutos: number): string {
  if (minutos === 0) return 'UTC';
  const a = Math.abs(minutos);
  const resto = a % 60;
  return `UTC${minutos < 0 ? '−' : '+'}${Math.floor(a / 60)}${resto ? `:${String(resto).padStart(2, '0')}` : ''}`;
}

/** "04:00" do dia da conta, no horário da loja: onde começa o dia de gasto de uma conta em outro fuso. */
export function inicioDoDiaDaConta(minutosConta: number, minutosLoja: number): string {
  const inicio = (((minutosLoja - minutosConta) % 1440) + 1440) % 1440;
  return `${String(Math.floor(inicio / 60)).padStart(2, '0')}:${String(inicio % 60).padStart(2, '0')}`;
}

/** Um minuto antes (fim do dia da conta): "03:59". */
function minutoAntes(hora: string): string {
  const [h, m] = hora.split(':').map(Number);
  const t = (h! * 60 + m! + 1439) % 1440;
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}

// ------------------------------------------------------------------ números da API (texto) → tela

/** "2.53" → 253 centésimos (exato). */
export function centesimosDe(razao: string): bigint {
  const negativo = razao.startsWith('-');
  const [inteira = '0', fracao = ''] = (negativo ? razao.slice(1) : razao).split('.');
  const valor = BigInt(inteira) * 100n + BigInt((fracao + '00').slice(0, 2));
  return negativo ? -valor : valor;
}

/** ROAS como no protótipo, com uma casa: "2.53" → "2,5×" (arredondado, sem ponto flutuante). */
export function vezes(razao: string | null): string {
  if (razao === null) return '—';
  const c = centesimosDe(razao);
  const negativo = c < 0n;
  const decimos = ((negativo ? -c : c) + 5n) / 10n;
  return `${negativo && decimos > 0n ? '-' : ''}${decimos / 10n},${decimos % 10n}×`;
}

/** "Para cada R$ 1, voltaram R$ 2,53": a razão lida como reais. */
export function reaisPorReal(razao: string): string {
  return reaisDeMicros(centesimosDe(razao) * 10_000n);
}

/** "83.4" → 834 décimos de ponto percentual. */
export function decimosDe(porcento: string): number {
  const [inteira = '0', fracao = '0'] = porcento.split('.');
  return Number(inteira) * 10 + Number(fracao.slice(0, 1) || '0');
}

/** "83.4" → "83%" (como o protótipo, sem casa decimal). */
export function porcentagem(porcento: string | null): string {
  if (porcento === null) return '—';
  return `${Math.floor((decimosDe(porcento) + 5) / 10)}%`;
}

/** Parte inteira de uma porcentagem de contagens ("9 de 141" → "6%"), com inteiros exatos. */
export function parte(n: bigint | number, de: bigint | number): string {
  const total = BigInt(de);
  if (total <= 0n) return '—';
  return `${((BigInt(n) * 200n + total) / (total * 2n)).toString()}%`;
}

const reais = (micros: string | bigint) => reaisDeMicros(micros);
const plural = (n: number | bigint, um: string, varios: string) => `${inteiro(n)} ${BigInt(n) === 1n ? um : varios}`;

/** Cobertura mínima para dizer "dá lucro / dá prejuízo" (D-A2.5-7), em décimos de ponto percentual. */
export const COBERTURA_MINIMA = 800;

// ------------------------------------------------------------------ texto rico mínimo (negrito)

/** Trecho de frase: `b` = negrito (o que a pessoa lê primeiro). */
export type Trecho = { t: string; b?: true };
export type Frase = Trecho[];
const n = (t: string): Trecho => ({ t, b: true });
/** Texto corrido de uma frase (testes e leitores). */
export function textoDe(f: Frase | null | undefined): string {
  return (f ?? []).map((x) => x.t).join('');
}

// ------------------------------------------------------------------ plataformas e fontes

type Nomes = { nome: string; classe: string; artigo: string; de: string; por: string };

/** Nome, cor e artigo de quem informa ("a Meta", "do Google Ads", "pela Meta"). */
export function nomesDe(provider: string): Nomes {
  const p = plataforma(provider);
  switch (provider) {
    case 'meta_ads':
      return { ...p, artigo: 'a Meta', de: 'da Meta', por: 'pela Meta' };
    case 'google_ads':
      return { ...p, artigo: 'o Google Ads', de: 'do Google Ads', por: 'pelo Google Ads' };
    case 'regem':
      return { ...p, artigo: 'o Regem', de: 'do Regem', por: 'pelo Regem' };
    case 'regemcast':
      return { ...p, artigo: 'o RegemCast', de: 'do RegemCast', por: 'pelo RegemCast' };
    default:
      return { ...p, artigo: p.nome, de: `de ${p.nome}`, por: `por ${p.nome}` };
  }
}

const MIDIA = new Set(['meta_ads', 'google_ads']);
export const ehMidia = (provider: string) => MIDIA.has(provider);

/** Janela da plataforma na comparação (a API manda a chave; valor novo aparece como veio). */
export function janelaDa(provider: string, janela: string): string {
  if (janela === '7d_click') return '7 dias após o clique';
  if (janela === '1d_click') return '1 dia após o clique';
  if (janela === '28d_click') return '28 dias após o clique';
  if (janela === 'padrao') return provider === 'google_ads' ? 'janela de cada conversão' : 'janela da plataforma';
  return janela.replaceAll('_', ' ');
}

export type SituacaoFonte = 'ok' | 'atraso' | 'sem_leitura' | 'problema' | 'nao_conectada';

export type Fonte = {
  id: string;
  provider: string;
  nome: string;
  /** Nome da conta quando há mais de uma da mesma plataforma. */
  conta: string | null;
  oque: string;
  fuso: string | null;
  situacao: SituacaoFonte;
  /** Última leitura boa ("hoje, 06:12"); nula sem leitura. */
  ultima: string | null;
  /** Coluna "quando" do cartão de fontes (Pro). */
  quando: string;
  /** Selo da hora quando a fonte está atrasada ou com problema ("Caixa até 09:42"). */
  selo: string | null;
};

const O_QUE: Record<string, string> = {
  meta_ads: 'gasto, conversas e o valor de venda que a Meta informa',
  google_ads: 'gasto e o valor de conversão que o Google Ads informa',
  regem: 'pedidos, receita, custo e cupons (a autoridade do caixa)',
  regemcast: 'conversas abertas por anúncio',
};

const STATUS_DA_CONTA: Record<string, string> = {
  desconectada: 'Desconectada',
  sem_permissao: 'Sem permissão',
  erro: 'Com erro',
};

function situacaoDa(s: SourceFreshness): SituacaoFonte {
  if (s.status !== 'ativa') return 'problema';
  if (s.freshness === 'delayed' || s.freshness === 'stale') return 'atraso';
  if (!s.last_success_at) return 'sem_leitura';
  return 'ok';
}

/** Hora curta para o selo e o chip: "09:42" hoje; "ontem, 09:42" ou "28/09, 09:42" antes. */
function horaCurta(iso: string, fuso: string, agora: Date): string {
  const q = quandoNoFuso(iso, fuso, agora);
  return q.startsWith('hoje, ') ? q.slice(6) : q;
}

/**
 * Fontes da tela com o frescor de cada uma (A2-5): mídia pelas métricas, Regem pelos pedidos. O Regem
 * não conectado entra como linha própria, porque é ele que confirma o caixa.
 */
export function fontesDe(r: Pick<ClosedLoopResponse, 'sources'>, fuso: string, agora: Date): Fonte[] {
  const porProvider = new Map<string, number>();
  for (const s of r.sources) porProvider.set(s.provider, (porProvider.get(s.provider) ?? 0) + 1);
  const fontes = r.sources.map((s): Fonte => {
    const nomes = nomesDe(s.provider);
    const caixa = s.provider === 'regem' || s.provider === 'regemcast';
    const situacao = situacaoDa(s);
    const conta = (porProvider.get(s.provider) ?? 0) > 1 ? s.name : null;
    const ultima = s.last_success_at;
    const quandoFoi = ultima ? quandoNoFuso(ultima, fuso, agora) : null;
    const curta = ultima ? horaCurta(ultima, fuso, agora) : null;
    let quando: string;
    let selo: string | null = null;
    if (situacao === 'problema') {
      const st = STATUS_DA_CONTA[s.status] ?? 'Com problema';
      quando = quandoFoi ? `${st} · última leitura ${quandoFoi}` : st;
      selo = curta ? `${caixa ? 'Caixa' : 'Gasto'} até ${curta}` : null;
    } else if (situacao === 'atraso') {
      quando = `Dados desatualizados · última ${caixa ? 'sincronização' : 'leitura'} ${curta}`;
      selo = `${caixa ? 'Caixa' : 'Gasto'} até ${curta}`;
    } else if (situacao === 'sem_leitura') {
      quando = 'Ainda sem leitura';
    } else {
      quando = quandoFoi!;
    }
    const fusoDaFonte = s.timezone ? `fuso ${caixa ? 'da loja' : 'da conta'}: ${nomeDoFuso(s.timezone)}` : null;
    return {
      id: s.connected_account_id,
      provider: s.provider,
      nome: nomes.nome,
      conta,
      oque: O_QUE[s.provider] ?? 'dados da plataforma',
      fuso: fusoDaFonte,
      situacao,
      ultima: quandoFoi,
      quando,
      selo,
    };
  });
  if (!r.sources.some((s) => s.provider === 'regem')) {
    fontes.push({
      id: 'regem-nao-conectado',
      provider: 'regem',
      nome: 'Regem',
      conta: null,
      oque: O_QUE.regem!,
      fuso: null,
      situacao: 'nao_conectada',
      ultima: null,
      quando: 'Não conectado',
      selo: null,
    });
  }
  return fontes;
}

// ------------------------------------------------------------------ veredito

export type Veredito = { rotulo: string; classe: 'bom' | 'atencao' | 'ruim' | 'incompleta' };

/**
 * O veredito vem do servidor (D-A2.5-7). A tela só o nomeia, e diz "Margem incompleta" quando ele não veio
 * por falta de margem: havia pedido e gasto, mas menos de 80% da receita tem custo conhecido (no piloto,
 * sem `custos.ler`, fica assim até o custo ser liberado). Em "Hoje" não há veredito: o gasto sai amanhã.
 */
export function vereditoDe(c: Pick<ConfirmedResult, 'orders' | 'verdict'>, gastoMicros: string, hoje: boolean): Veredito | null {
  if (hoje || c.orders === 0) return null;
  if (c.verdict === 'lucro') return { rotulo: 'Dá lucro', classe: 'bom' };
  if (c.verdict === 'empata') return { rotulo: 'Empata', classe: 'atencao' };
  if (c.verdict === 'prejuizo') return { rotulo: 'Dá prejuízo', classe: 'ruim' };
  if (c.verdict === null && BigInt(gastoMicros) > 0n) return { rotulo: 'Margem incompleta', classe: 'incompleta' };
  return null;
}

/** Margem conhecida menos o investimento; nula sem margem conhecida (desconhecida ≠ zero). */
export function sobraDe(c: Pick<ConfirmedResult, 'margin_known_micros'>, gastoMicros: string): bigint | null {
  return c.margin_known_micros === null ? null : BigInt(c.margin_known_micros) - BigInt(gastoMicros);
}

/** Cobertura de margem abaixo dos 80% (ou nenhuma). */
export function coberturaBaixa(c: Pick<ConfirmedResult, 'margin_coverage_pct'>): boolean {
  return c.margin_coverage_pct !== null && decimosDe(c.margin_coverage_pct) < COBERTURA_MINIMA;
}

// ------------------------------------------------------------------ base da tela

export type Base = {
  hoje: boolean;
  fuso: string;
  agora: Date;
  semRegem: boolean;
  semMidia: boolean;
  /** Regem conectado e nenhum pedido confirmado no período. */
  semPedido: boolean;
  janela: number;
  rotuloPeriodo: string;
};

export function baseDe(r: ClosedLoopResponse, periodo: Periodo, agora: Date): Base {
  const hoje = periodo === 'hoje';
  const semRegem = !r.sources.some((s) => s.provider === 'regem');
  const semMidia = !r.sources.some((s) => ehMidia(s.provider));
  return {
    hoje,
    fuso: fusoValido(r.period.timezone),
    agora,
    semRegem,
    semMidia,
    semPedido: !semRegem && r.totals.orders_confirmed === 0,
    janela: r.model.window_days,
    rotuloPeriodo: rotuloDoPeriodo(periodo),
  };
}

/** Nada conectado: nem mídia nem Regem (a tela inteira vira um convite para conectar). */
export function nadaConectado(r: Pick<ClosedLoopResponse, 'sources'>): boolean {
  return r.sources.length === 0;
}

// ------------------------------------------------------------------ linha de contexto

/** `curto` é o complemento do modo simples: sem os fusos (quem os diz, quando importam, é a faixa do topo). */
export type LinhaDeContexto = { datas: string; complemento: string; curto: string; modelo: string };

/** "22/09 a 28/09"; um dia só, "28/09". */
export function intervaloEscrito(inicio: string, fim: string): string {
  return inicio === fim ? diaMes(inicio) : `${diaMes(inicio)} a ${diaMes(fim)}`;
}

export function contextoDe(r: ClosedLoopResponse, b: Base, local: string | null): LinhaDeContexto {
  const { from: inicio, to: fim } = r.period;
  const datas = b.hoje ? `${diaMes(inicio)}, até ${horaNoFuso(new Date(r.generated_at), b.fuso)}` : intervaloEscrito(inicio, fim);
  const outros = r.sources.filter((s) => ehMidia(s.provider) && s.timezone && s.timezone !== r.period.timezone);
  const loja = nomeDoFuso(b.fuso);
  const fuso = outros.length
    ? `pedidos no fuso da loja (${loja}) · gasto ${outros.map((s) => `${nomesDe(s.provider).de} no fuso da conta (${nomeDoFuso(s.timezone!)})`).join(' · ')}`
    : `pedidos no fuso da loja (${loja}) · gasto no fuso de cada conta`;
  const partes = [b.hoje ? null : 'dias completos', local, fuso].filter(Boolean);
  const m = r.model;
  const modelo = `Modelo: ${m.key === 'ultimo_toque' ? 'último toque' : m.key.replaceAll('_', ' ')} · v${m.version} · ${m.window_days} dias · ${m.counts_views ? 'com visualização' : 'sem visualização'}`;
  return { datas, complemento: partes.join(' · '), curto: partes.slice(0, -1).join(' · '), modelo };
}

// ------------------------------------------------------------------ avisos (faixas do topo)

export type Aviso = {
  id: string;
  tipo: 'acao' | 'atencao' | 'perigo';
  icone: NomeIcone;
  titulo: string;
  texto: string;
};

/**
 * As faixas do Pro, na ordem do protótipo P1: fuso da conta, margem incompleta, plataforma sem valor de venda e "o
 * gasto de hoje sai amanhã". Só entra o que a API permite afirmar. O que impede ou data os números (conectar, fonte
 * com problema ou sem leitura nova) é da faixa única do topo, nos dois modos (`faixaDe`, em graficos.ts).
 */
export function avisosDe(r: ClosedLoopResponse, b: Base): Aviso[] {
  const avisos: Aviso[] = [];
  const vistos = new Set<string>();
  const minLoja = deslocamentoDoFuso(b.fuso, b.agora);
  for (const s of r.sources) {
    if (!ehMidia(s.provider) || !s.timezone || s.timezone === r.period.timezone) continue;
    const chave = `${s.provider}:${s.timezone}`;
    if (vistos.has(chave)) continue;
    vistos.add(chave);
    const nomes = nomesDe(s.provider);
    const minConta = deslocamentoDoFuso(s.timezone, b.agora);
    const offConta = minConta === null ? '' : ` (${utc(minConta)})`;
    const offLoja = minLoja === null ? '' : ` (${utc(minLoja)})`;
    const inicio = minConta !== null && minLoja !== null ? inicioDoDiaDaConta(minConta, minLoja) : null;
    avisos.push({
      id: `fuso-${chave}`,
      tipo: 'atencao',
      icone: 'clock',
      titulo: `A conta ${nomes.de} usa outro fuso: ${nomeDoFuso(s.timezone)}${offConta}`,
      texto:
        `A loja usa o de ${nomeDoFuso(b.fuso)}${offLoja}. Os pedidos seguem o fuso da loja e o gasto segue o da conta, porque é assim que a plataforma fecha o dia` +
        (inicio ? `: cada dia de gasto ${nomes.de} vai das ${inicio} às ${minutoAntes(inicio)} no horário da loja.` : '.') +
        ' Em 7 ou 30 dias a diferença é pequena; em “Hoje”, pesa.',
    });
  }
  const t = r.totals.confirmed;
  if (!b.semRegem && !b.hoje && t.orders > 0 && coberturaBaixa(t)) {
    const nenhuma = t.margin_known_micros === null;
    avisos.push({
      id: 'margem',
      tipo: 'atencao',
      icone: 'alert',
      titulo: nenhuma ? 'Nenhuma venda dos anúncios tem custo conhecido no Regem' : `Só ${porcentagem(t.margin_coverage_pct)} da receita tem custo cadastrado no Regem`,
      texto: nenhuma
        ? 'Sem o custo dos itens, o Liame mostra a receita, mas não diz se deu lucro ou prejuízo. O custo vem da ficha técnica do Regem, com a leitura de custos liberada na conexão.'
        : 'Com menos de 80%, o Liame mostra a margem conhecida, mas não diz se deu lucro ou prejuízo. Cadastre o custo dos itens que faltam na ficha técnica do Regem.',
    });
  }
  if (!b.hoje && !b.semRegem) {
    for (const p of r.platforms) {
      if (!ehMidia(p.provider) || !ehDeMensagem(p.platform)) continue;
      const nomes = nomesDe(p.provider);
      avisos.push({
        id: `mensagem-${p.provider}`,
        tipo: 'acao',
        icone: 'message',
        titulo: `${capitalizar(nomes.artigo)} não informa valor de venda para campanhas de mensagem`,
        texto: `Por isso o ROAS ${nomes.de} fica em branco. Compare o custo por conversa com o custo por pedido confirmado no caixa.`,
        });
    }
  }
  if (b.hoje && !b.semRegem && !b.semMidia) {
    const midia = r.sources.filter((s) => ehMidia(s.provider));
    const quem = [...new Set(midia.map((s) => nomesDe(s.provider).artigo))];
    const leituras = midia.map((s) => s.last_success_at).filter((x): x is string => Boolean(x)).sort();
    const ultima = leituras.at(-1);
    avisos.push({
      id: 'hoje',
      tipo: 'acao',
      icone: 'clock',
      titulo: 'O gasto de hoje sai amanhã',
      texto:
        `${capitalizar(juntar(quem))} ${quem.length > 1 ? 'são lidos' : 'é lido'} uma vez por dia` +
        (ultima ? ` (última leitura ${quandoNoFuso(ultima, b.fuso, b.agora)})` : '') +
        '. Até lá, “Hoje” mostra os pedidos e a receita do caixa; o ROAS e o custo por pedido de hoje saem amanhã.',
    });
  }
  return avisos;
}

function capitalizar(t: string): string {
  return t ? t[0]!.toLocaleUpperCase('pt-BR') + t.slice(1) : t;
}

/** "a Meta e o Google Ads"; "a Meta, o Google Ads e o GA4". */
function juntar(itens: string[]): string {
  if (itens.length <= 1) return itens[0] ?? '';
  return `${itens.slice(0, -1).join(', ')} e ${itens.at(-1)}`;
}

/** Campanha (ou plataforma) de mensagem: conversas, gasto, e a plataforma sem valor de venda. */
export function ehDeMensagem(p: PlatformResult['platform']): boolean {
  return p.value_micros === null && p.conversations !== null && BigInt(p.conversations) > 0n && BigInt(p.spend_micros) > 0n;
}

// ------------------------------------------------------------------ cartão do ROAS (herói)

export type Valor = { texto: string; vazio?: boolean };

export type LinhaPlataforma = {
  provider: string;
  nome: string;
  classe: string;
  investido: string;
  janela: string;
  plataforma: Valor;
  caixa: Valor;
  rotuloCaixa: string;
  veredito: Veredito | null;
};

export type LinhaMensagem = { id: string; campanha: string; porConversa: string; porPedido: string; taxa: string };

export type CartaoRoas = {
  titulo: string;
  numero: string;
  vazio: boolean;
  /** Frase do estado vazio ou de "hoje" (no modo simples, quem diz é o desenho). */
  frase: Frase | null;
  selos: string[];
  explicacao: Frase;
  plataformas: LinhaPlataforma[];
  mensagens: LinhaMensagem[];
};

function valorDaPlataforma(p: PlatformResult['platform'], hoje: boolean): Valor {
  if (hoje) return { texto: 'sai amanhã', vazio: true };
  if (p.roas !== null) return { texto: vezes(p.roas) };
  if (p.value_micros === null) return { texto: 'não informa', vazio: true };
  return { texto: '—', vazio: true };
}

function valorDoCaixa(c: ConfirmedResult, b: Base): Valor {
  if (b.hoje) return { texto: 'sai amanhã', vazio: true };
  if (b.semRegem) return { texto: 'conecte o Regem', vazio: true };
  if (c.roas !== null) return { texto: vezes(c.roas) };
  return { texto: '—', vazio: true };
}

export function roasDe(r: ClosedLoopResponse, b: Base, fontes: Fonte[]): CartaoRoas {
  const t = r.totals.confirmed;
  const titulo = `ROAS confirmado no caixa · ${b.rotuloPeriodo}`;
  let numero = '—';
  let frase: Frase | null = null;
  if (b.semRegem) {
    frase = [n('Falta conectar o Regem'), { t: ' para saber quanto os anúncios venderam de verdade no caixa.' }];
  } else if (r.totals.orders_confirmed === 0) {
    frase = [n(`Nenhum pedido confirmado ${b.hoje ? 'hoje, até agora' : 'no período'}.`), { t: ' Quando entrar pedido, ele aparece aqui com a origem.' }];
  } else if (b.semMidia) {
    frase = [n('Conecte a Meta ou o Google'), { t: ' para saber quanto cada R$ 1 em anúncio trouxe de volta.' }];
  } else if (t.orders === 0 && (b.hoje || t.roas === null)) {
    frase = [n(`Nenhum pedido com prova de anúncio ${b.hoje ? 'hoje, até agora' : 'no período'}.`), { t: ' Os pedidos sem origem e os dos canais sem clique aparecem abaixo, separados.' }];
  } else if (t.orders === 0) {
    // Houve gasto e pedido, mas nenhum com prova de anúncio: o confirmado no caixa é zero, e isso é informação.
    numero = vezes(t.roas);
    frase = [n('Nenhum pedido com prova de anúncio no período.'), { t: ' Os pedidos sem origem e os dos canais sem clique aparecem abaixo, separados.' }];
  } else if (b.hoje) {
    frase = [
      { t: 'Hoje, até agora, ' },
      n(`${plural(t.orders, 'pedido veio', 'pedidos vieram')} de anúncios`),
      { t: ` (${reais(t.revenue_micros)}). Quanto voltou para cada R$ 1 sai amanhã, com o gasto do dia.` },
    ];
  } else if (t.roas === null) {
    frase = [n('Sem gasto com anúncios no período.'), { t: ' O ROAS compara a receita confirmada com o investimento; os pedidos aparecem abaixo, com a origem.' }];
  } else {
    numero = vezes(t.roas);
  }

  const midia = r.platforms.filter((p) => ehMidia(p.provider));
  const plataformas = midia.map((p): LinhaPlataforma => {
    const nomes = nomesDe(p.provider);
    return {
      provider: p.provider,
      nome: nomes.nome,
      classe: nomes.classe,
      investido: b.hoje ? 'gasto de hoje sai amanhã' : `${reais(p.platform.spend_micros)} investidos`,
      janela: `Plataforma · ${janelaDa(p.provider, p.platform.window)}`,
      plataforma: valorDaPlataforma(p.platform, b.hoje),
      caixa: valorDoCaixa(p.confirmed, b),
      rotuloCaixa: `Confirmado no caixa · ${b.janela} dias`,
      veredito: b.semRegem ? null : vereditoDe(p.confirmed, p.platform.spend_micros, b.hoje),
    };
  });

  const mensagens =
    b.hoje || b.semRegem
      ? []
      : r.campaigns
          .filter((c) => ehDeMensagem(c.platform))
          .map((c): LinhaMensagem => {
            const conversas = BigInt(c.platform.conversations!);
            const pedidos = c.confirmed.orders;
            return {
              id: c.campaign_id,
              campanha: c.name,
              porConversa: c.platform.cost_per_conversation_micros ? reais(c.platform.cost_per_conversation_micros) : '—',
              porPedido: c.confirmed.cost_per_order_micros ? reais(c.confirmed.cost_per_order_micros) : '—',
              taxa: pedidos
                ? `${parte(pedidos, conversas)} das conversas viraram pedido (${inteiro(pedidos)} de ${inteiro(conversas)})`
                : 'Nenhuma conversa virou pedido ainda',
            };
          });

  const explicacao: Frase = [
    { t: 'Janela do Liame: ' },
    n(`${b.janela} dias`),
    { t: ` do clique ou da conversa até o pedido, ${r.model.counts_views ? 'com' : 'sem'} visualização. Só conta evidência de confiança alta ou média; pedido sem evidência fica sem origem.` },
  ];

  return {
    titulo,
    numero,
    vazio: numero === '—',
    frase,
    // Duas contas lidas na mesma hora dariam o mesmo selo: um basta.
    selos: [...new Set(fontes.map((f) => f.selo).filter((s): s is string => Boolean(s)))],
    explicacao,
    plataformas,
    mensagens,
  };
}

// ------------------------------------------------------------------ "Do anúncio ao caixa"

export type Kpi = { rotulo: string; valor: string; sub: string; vazio: boolean; atencao: boolean };
export type CartaoCiclo = { kpis: Kpi[] };

/** Número que ainda não existe ("—" ou "Sai amanhã") aparece apagado, como no protótipo. */
const kpi = (rotulo: string, valor: string, sub = '', atencao = false): Kpi => ({ rotulo, valor, sub, vazio: valor === '—' || valor === 'Sai amanhã', atencao });

export function cicloDe(r: ClosedLoopResponse, b: Base): CartaoCiclo {
  const t = r.totals.confirmed;
  const gasto = r.totals.spend_micros;
  const precisa = 'precisa do Regem';
  const midia = r.platforms.filter((p) => ehMidia(p.provider));
  const conversas = midia.map((p) => p.platform.conversations).filter((c): c is string => c !== null);
  const totalConversas = conversas.reduce((s, c) => s + BigInt(c), 0n);
  const quemConversa = midia.filter((p) => p.platform.conversations !== null).map((p) => nomesDe(p.provider).por);
  const semClique = r.totals.no_click_channels.reduce((s, c) => s + c.orders, 0);
  const comClique = r.totals.orders_confirmed - semClique;
  const cobertura = t.margin_coverage_pct;
  const kpis: Kpi[] = [
    kpi(
      'Investimento',
      b.hoje ? 'Sai amanhã' : b.semMidia ? '—' : reais(gasto),
      b.hoje ? 'lido amanhã cedo' : b.semMidia ? 'conecte a Meta ou o Google' : midia.map((p) => `${nomesDe(p.provider).nome} ${reais(p.platform.spend_micros)}`).join(' · '),
    ),
    kpi(
      'Conversas por anúncio',
      b.hoje ? 'Sai amanhã' : conversas.length ? inteiro(totalConversas) : '—',
      b.hoje ? 'lidas amanhã cedo' : conversas.length ? `informado ${juntar(quemConversa)}` : '',
    ),
    kpi('Pedidos confirmados', b.semRegem ? '—' : inteiro(t.orders), b.semRegem ? precisa : 'com evidência de confiança alta ou média'),
    kpi('Receita confirmada', b.semRegem ? '—' : reais(t.revenue_micros), b.semRegem ? precisa : 'pela definição de faturamento do Regem'),
    kpi(
      'Margem conhecida',
      b.semRegem || t.margin_known_micros === null ? '—' : reais(t.margin_known_micros),
      b.semRegem ? precisa : cobertura === null ? 'sem pedidos' : `em ${porcentagem(cobertura)} da receita${coberturaBaixa(t) ? ' · abaixo de 80%' : ''}`,
      !b.semRegem && coberturaBaixa(t),
    ),
    kpi(
      'Custo por pedido',
      b.hoje && t.orders ? 'Sai amanhã' : b.semRegem || !t.cost_per_order_micros ? '—' : reais(t.cost_per_order_micros),
      b.semRegem ? precisa : 'investimento ÷ pedidos confirmados',
    ),
    kpi(
      'Pedidos sem origem',
      b.semRegem ? '—' : porcentagem(r.totals.without_origin.share_pct),
      b.semRegem
        ? precisa
        : r.totals.without_origin.share_pct === null
          ? 'sem pedidos no período'
          : `${inteiro(r.totals.without_origin.orders)} de ${inteiro(comClique)} do cardápio e do WhatsApp`,
    ),
    kpi(
      'Vendas da loja (todos os canais)',
      b.semRegem ? '—' : reais(r.totals.revenue_micros),
      b.semRegem ? precisa : `${plural(r.totals.orders_confirmed, 'pedido confirmado', 'pedidos confirmados')} no período`,
    ),
  ];
  return { kpis };
}

// ------------------------------------------------------------------ por campanha

const SITUACAO_DA_CAMPANHA: Record<string, string> = {
  ativa: 'ativa',
  pausada: 'pausada',
  arquivada: 'arquivada',
  removida: 'removida',
  desconhecida: 'situação desconhecida',
};

/** "ativa", "pausada"… (valor novo da API aparece como veio, sem o sublinhado). */
export function situacaoDaCampanha(status: string): string {
  return SITUACAO_DA_CAMPANHA[status] ?? status.replaceAll('_', ' ');
}

export type Celula = { texto: string; sub?: string; subAtencao?: boolean; forte?: boolean };

export type LinhaCampanha = {
  id: string;
  nome: string;
  provider: string;
  nomePlataforma: string;
  classe: string;
  situacao: string;
  celulas: {
    investimento: Celula;
    conversas: Celula;
    pedidos: Celula;
    receita: Celula;
    margem: Celula;
    custoPorPedido: Celula;
    roasPlataforma: Celula;
    roasCaixa: Celula;
  };
  /** Pontos do gráfico plataforma × caixa (nulo = não dá para desenhar). */
  halteres: { plataforma: number | null; caixa: number } | null;
  rotuloHalteres: string;
};

export type LinhaSoPlataforma = { provider: string; titulo: string; pedidos: string; receita: string; nota: string; frase: Frase };

export type CartaoCampanhas = {
  linhas: LinhaCampanha[];
  soPlataforma: LinhaSoPlataforma[];
  total: LinhaCampanha['celulas'];
  vazio: string | null;
};

function celulaMargem(c: ConfirmedResult, b: Base): Celula {
  if (b.semRegem || c.orders === 0) return { texto: '—' };
  const sub = c.margin_coverage_pct === null ? undefined : `${porcentagem(c.margin_coverage_pct)} com custo`;
  return { texto: c.margin_known_micros === null ? '—' : reais(c.margin_known_micros), sub, subAtencao: coberturaBaixa(c) };
}

function numeroDe(razao: string | null): number | null {
  if (razao === null) return null;
  const v = Number(razao);
  return Number.isFinite(v) ? v : null;
}

export function campanhasDe(r: ClosedLoopResponse, b: Base): CartaoCampanhas {
  const linhas = r.campaigns.map((c): LinhaCampanha => {
    const nomes = nomesDe(c.provider);
    const p = c.platform;
    const k = c.confirmed;
    const mensagem = ehDeMensagem(p);
    const caixa = b.hoje || b.semRegem ? null : numeroDe(k.roas);
    const plat = b.hoje ? null : numeroDe(p.roas);
    const rotuloHalteres =
      caixa === null
        ? ''
        : plat === null
          ? `${c.name}: a plataforma não informa; confirmado no caixa ${vezes(k.roas).replace('×', '')}`
          : `${c.name}: plataforma ${vezes(p.roas).replace('×', '')}, confirmado no caixa ${vezes(k.roas).replace('×', '')}`;
    return {
      id: c.campaign_id,
      nome: c.name,
      provider: c.provider,
      nomePlataforma: nomes.nome,
      classe: nomes.classe,
      situacao: SITUACAO_DA_CAMPANHA[c.status] ?? c.status.replaceAll('_', ' '),
      celulas: {
        investimento: b.hoje ? { texto: '—', sub: 'sai amanhã' } : { texto: reais(p.spend_micros) },
        conversas:
          b.hoje || p.conversations === null
            ? { texto: '—' }
            : { texto: inteiro(p.conversations), sub: p.cost_per_conversation_micros ? `${reais(p.cost_per_conversation_micros)} cada` : undefined },
        pedidos: { texto: b.semRegem ? '—' : inteiro(k.orders) },
        receita: { texto: b.semRegem ? '—' : reais(k.revenue_micros) },
        margem: celulaMargem(k, b),
        custoPorPedido: { texto: b.hoje || b.semRegem || !k.cost_per_order_micros ? '—' : reais(k.cost_per_order_micros) },
        roasPlataforma: b.hoje
          ? { texto: '—', sub: 'sai amanhã' }
          : p.roas !== null
            ? { texto: vezes(p.roas), sub: janelaDa(c.provider, p.window) }
            : p.value_micros === null
              ? { texto: 'não informa', sub: mensagem ? 'campanha de mensagem' : 'sem valor de venda' }
              : { texto: '—' },
        roasCaixa: { texto: b.hoje || b.semRegem ? '—' : vezes(k.roas), forte: true },
      },
      halteres: caixa === null ? null : { plataforma: plat, caixa },
      rotuloHalteres,
    };
  });

  // Pedidos provados só na plataforma (id de clique sem campanha): contam no total dela, fora das campanhas
  // (ADR-020 item 4). A receita deles é a da plataforma menos a das campanhas dela (conta exata em BigInt).
  const soPlataforma = b.semRegem
    ? []
    : r.platforms
        .filter((p) => p.platform_only_orders > 0)
        .map((p): LinhaSoPlataforma => {
          const nomes = nomesDe(p.provider);
          const dasCampanhas = r.campaigns.filter((c) => c.provider === p.provider).reduce((s, c) => s + BigInt(c.confirmed.revenue_micros), 0n);
          const resto = BigInt(p.confirmed.revenue_micros) - dasCampanhas;
          const receita = resto >= 0n ? reais(resto) : '—';
          const pedidos = inteiro(p.platform_only_orders);
          return {
            provider: p.provider,
            titulo: `${nomes.nome.replace(' Ads', '')} · sem campanha identificada`,
            pedidos,
            receita,
            nota: `conta no total ${nomes.de}`,
            frase: [
              { t: 'Mais ' },
              n(plural(p.platform_only_orders, 'pedido', 'pedidos')),
              { t: ` ${p.platform_only_orders === 1 ? 'veio' : 'vieram'} ${nomes.de} sem dizer a campanha${resto >= 0n ? ` (${receita})` : ''}: ${p.platform_only_orders === 1 ? 'conta' : 'contam'} no total ${nomes.de}, fora das campanhas.` },
            ],
          };
        });

  const t = r.totals.confirmed;
  const midia = r.platforms.filter((p) => ehMidia(p.provider));
  const conversas = midia.map((p) => p.platform.conversations).filter((c): c is string => c !== null);
  const total: LinhaCampanha['celulas'] = {
    investimento: b.hoje ? { texto: '—', sub: 'sai amanhã' } : { texto: reais(r.totals.spend_micros) },
    conversas: b.hoje || !conversas.length ? { texto: '—' } : { texto: inteiro(conversas.reduce((s, c) => s + BigInt(c), 0n)) },
    pedidos: { texto: b.semRegem ? '—' : inteiro(t.orders) },
    receita: { texto: b.semRegem ? '—' : reais(t.revenue_micros) },
    margem: celulaMargem(t, b),
    custoPorPedido: { texto: b.hoje || b.semRegem || !t.cost_per_order_micros ? '—' : reais(t.cost_per_order_micros) },
    roasPlataforma: { texto: '—', sub: 'janelas diferentes' },
    roasCaixa: { texto: b.hoje || b.semRegem ? '—' : vezes(t.roas), forte: true },
  };

  let vazio: string | null = null;
  if (!r.campaigns.length) vazio = b.semMidia ? 'Conecte a Meta ou o Google para ver o resultado de cada campanha.' : 'Nenhuma campanha gastou ou vendeu no período.';
  return { linhas, soPlataforma, total, vazio };
}

// ------------------------------------------------------------------ de onde vieram os pedidos

const GRUPOS_DE_CANAL: Record<string, string> = {
  marketplace: 'Marketplaces',
  presencial: 'Balcão e presencial',
  outro: 'Outros canais',
  cardapio: 'Cardápio online',
  whatsapp: 'WhatsApp',
};

export function grupoDeCanal(g: string): string {
  return GRUPOS_DE_CANAL[g] ?? g.replaceAll('_', ' ');
}

export type LinhaCanal = { grupo: string; pedidos: string; receita: string };

export type CartaoOrigem =
  | { tipo: 'sem-regem' }
  | { tipo: 'sem-pedido'; titulo: string; texto: string }
  | {
      tipo: 'ok';
      semOrigem: { porcentagem: string; frase: string };
      canais: LinhaCanal[];
      totalCanais: LinhaCanal;
      loja: string;
      cancelados: string | null;
    };

export function origemDe(r: ClosedLoopResponse, b: Base, fontes: Fonte[]): CartaoOrigem {
  if (b.semRegem) return { tipo: 'sem-regem' };
  const tot = r.totals;
  if (tot.orders_confirmed === 0) {
    const regem = fontes.find((f) => f.provider === 'regem');
    const leitura = !regem?.ultima
      ? ''
      : regem.situacao === 'ok'
        ? `O Regem está em dia (última leitura ${regem.ultima}). `
        : `A última leitura do Regem foi ${regem.ultima}: pedidos de depois ainda não entraram. `;
    return {
      tipo: 'sem-pedido',
      titulo: b.hoje ? 'Nenhum pedido confirmado hoje, até agora' : 'Nenhum pedido confirmado no período',
      texto: `${leitura}Quando entrar pedido, ele aparece aqui com a origem.`,
    };
  }
  const semClique = tot.no_click_channels.reduce((s, c) => ({ pedidos: s.pedidos + c.orders, receita: s.receita + BigInt(c.revenue_micros) }), { pedidos: 0, receita: 0n });
  const comClique = tot.orders_confirmed - semClique.pedidos;
  return {
    tipo: 'ok',
    semOrigem: {
      porcentagem: porcentagem(tot.without_origin.share_pct),
      frase: `${inteiro(tot.without_origin.orders)} de ${inteiro(comClique)} pedidos do cardápio online e do WhatsApp não têm evidência de anúncio. Pedido sem evidência fica sem origem: o Liame não chuta.`,
    },
    canais: tot.no_click_channels.map((c) => ({ grupo: grupoDeCanal(c.channel_group), pedidos: inteiro(c.orders), receita: reais(c.revenue_micros) })),
    totalCanais: { grupo: 'Total', pedidos: inteiro(semClique.pedidos), receita: reais(semClique.receita) },
    loja: `Loja inteira no período, todos os canais: ${plural(tot.orders_confirmed, 'pedido', 'pedidos')} · ${reais(tot.revenue_micros)} (definição de faturamento do Regem).`,
    cancelados: tot.cancelled.orders
      ? `${plural(tot.cancelled.orders, 'pedido cancelado', 'pedidos cancelados')} depois ${tot.cancelled.orders === 1 ? 'saiu' : 'saíram'} do ROAS no recálculo e não ${tot.cancelled.orders === 1 ? 'entra' : 'entram'} nesta conta.`
      : null,
  };
}

// ------------------------------------------------------------------ marca e loja

export type Loja = { id: string; nome: string };

/** Lojas do Regem ligadas à marca (uma por loja do Liame), para o seletor de loja. */
export function lojasDoRegem(conexoes: Pick<ConnectionResponse, 'accounts'>[]): Loja[] {
  const lojas = new Map<string, string>();
  for (const c of conexoes) {
    for (const a of c.accounts) {
      if (a.provider === 'regem' && a.unit_id && !a.disconnected_at && !lojas.has(a.unit_id)) lojas.set(a.unit_id, a.name);
    }
  }
  return [...lojas].map(([id, nome]) => ({ id, nome })).sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
}

/** Onde, na linha de contexto: a loja escolhida, a única loja do Regem, "N lojas" ou, sem Regem, a marca. */
export function localDe(r: Pick<ClosedLoopResponse, 'sources'>, loja: Loja | null, marca: string | null): string | null {
  if (loja) return loja.nome;
  const regem = r.sources.filter((s) => s.provider === 'regem');
  if (regem.length === 1) return regem[0]!.name;
  if (regem.length > 1) return `${regem.length} lojas`;
  return marca;
}

// ------------------------------------------------------------------ tudo junto

export type TelaDeResultados = {
  base: Base;
  contexto: LinhaDeContexto;
  fontes: Fonte[];
  avisos: Aviso[];
  roas: CartaoRoas;
  ciclo: CartaoCiclo;
  campanhas: CartaoCampanhas;
  origem: CartaoOrigem;
};

/** Tudo o que a tela mostra, a partir da resposta da API (a tela não calcula métrica nenhuma). */
export function montarTela(r: ClosedLoopResponse, periodo: Periodo, agora: Date, local: string | null): TelaDeResultados {
  const base = baseDe(r, periodo, agora);
  const fontes = fontesDe(r, base.fuso, agora);
  return {
    base,
    contexto: contextoDe(r, base, local),
    fontes,
    avisos: avisosDe(r, base),
    roas: roasDe(r, base, fontes),
    ciclo: cicloDe(r, base),
    campanhas: campanhasDe(r, base),
    origem: origemDe(r, base, fontes),
  };
}

