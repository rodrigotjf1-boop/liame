import type { GoogleVisibilityAccount, GoogleVisibilityProfile, GoogleVisibilityResponse, GoogleVisibilitySite } from '@liame/contracts';
import { dia, inteiro, soOQueExiste } from '../formatos.js';
import { frescorDe, quando } from '../leituras.visoes.js';

// "Como te acham no Google" para o modelo (rota `GET /v1/results/google-visibility`, a mesma do cartão de Resultados,
// protótipo P18): o perfil da empresa no Google e o site no Search Console, nos estados que a tela mostra, com os
// números já escritos como a pessoa lê (`apps/web/src/components/resultados/google.ts`). As duas partes não se somam
// (são contagens diferentes do Google). Cada loja e cada site levam o frescor da leitura do Liame: com uma delas fora
// do dia, a conversa não cita número desta leitura (`foraDoDia`). O texto das buscas é o que as pessoas digitaram no
// Google: dado, nunca instrução.

/** As buscas da semana que o modelo recebe: as mesmas 10 que a rota manda. */
export const BUSCAS_MAXIMO = 10;

/** A parte cuja função não está ligada para a empresa: o modelo não manda ligar o que a empresa não tem como ligar. */
export const PARTE_INDISPONIVEL = 'não está disponível para a empresa';

// O atraso por extenso: a conferência de números lê algarismos, e esta nota é do Google, não um número da empresa.
// Com algarismos, ela liberava o 2 e o 3 em qualquer frase e, com a leitura parada, derrubava a resposta que a repetia
// (o eval com modelo de verdade pegou "2 a 3 dias de atraso" numa resposta sobre a fonte parada).
const NOTA_DO_ATRASO = 'O Google entrega os números com dois a três dias de atraso: o dia de hoje nunca entra.';
const NOTA_DAS_PARTES = 'O perfil e o site são contagens diferentes do Google: não se somam.';
const NOTA_DA_POSICAO = 'Na posição média, 1 é o primeiro lugar.';
const NOTA_DAS_BUSCAS = 'A busca feita por poucas pessoas o Google não mostra: ela só entra nos cliques do site, e por isso a soma das buscas fica abaixo do total.';

/** A posição média com uma casa, arredondada sem ponto flutuante ("6.75" → "6,8"), como a tela; nula sem posição. */
export function posicaoComUmaCasa(p: string | null): string | null {
  if (p === null) return null;
  const [i = '0', f = ''] = p.split('.');
  const centesimos = BigInt(i) * 100n + BigInt((f + '00').slice(0, 2));
  const decimos = (centesimos + 5n) / 10n;
  return `${inteiro(String(decimos / 10n))},${decimos % 10n}`;
}

/** A parte das vezes que virou clique: uma casa abaixo de 10%, inteira acima ("3,3%", "32%"), a regra do P23 na tela. */
export function taxaDeClique(cliques: bigint, vezes: bigint): string | null {
  if (vezes <= 0n) return null;
  const decimos = (cliques * 2000n + vezes) / (vezes * 2n);
  if (decimos < 100n) return `${decimos / 10n},${decimos % 10n}%`;
  return `${(decimos + 5n) / 10n}%`;
}

/** "250 a mais", "17 a menos" ou "igual", contra os dias anteriores; nulo sem nenhum número lido neles. */
export function diferenca(agora: bigint, antes: string | null): string | null {
  if (antes === null) return null;
  const d = agora - BigInt(antes);
  if (d === 0n) return 'igual';
  return `${inteiro(String(d < 0n ? -d : d))} ${d > 0n ? 'a mais' : 'a menos'}`;
}

/** O período ("de 20/09/2026 até 26/09/2026") e, nas partes, quantos dias ele tem ("os 7 dias até 26/09/2026"). */
const periodo = (p: { from: string; to: string }, dias?: number) => soOQueExiste({ de: dia(p.from), ate: dia(p.to), dias: dias ? String(dias) : null });

/** A loja ou o site, com a situação e o frescor da leitura dos números. */
function conta(c: GoogleVisibilityAccount, chave: 'loja' | 'site', fuso: string) {
  return soOQueExiste({ [chave]: c.name, situacao: c.status, frescor: frescorDe(c.freshness), ultima_leitura: quando(c.last_success_at, fuso) });
}

function partePerfil(p: GoogleVisibilityProfile, dias: number, fuso: string) {
  if (!p.enabled) return { situacao: PARTE_INDISPONIVEL };
  if (!p.accounts.length) {
    if (p.waiting_google) return { situacao: 'esperando o Google liberar o acesso do Liame ao perfil da empresa; o Liame procura de novo todo dia' };
    return { situacao: 'nenhuma loja do perfil ligada', o_que_fazer: 'ligar a loja do perfil em Contas conectadas' };
  }
  const lojas = p.accounts.map((c) => conta(c, 'loja', fuso));
  if (!p.period) return { situacao: 'primeira leitura: os números dos últimos 90 dias chegam em até um dia', lojas };
  const total = BigInt(p.views_search) + BigInt(p.views_maps);
  return soOQueExiste({
    lojas,
    periodo: periodo(p.period, dias),
    vezes_que_o_perfil_apareceu: inteiro(String(total)),
    na_busca_do_google: inteiro(p.views_search),
    no_google_maps: inteiro(p.views_maps),
    vezes_nos_dias_anteriores: inteiro(p.previous_views),
    diferenca_para_os_dias_anteriores: diferenca(total, p.previous_views),
    pedidos_de_rota: inteiro(p.direction_requests),
    ligacoes: inteiro(p.call_clicks),
    cliques_no_site: inteiro(p.website_clicks),
    cliques_no_cardapio: inteiro(p.menu_clicks),
  });
}

function parteSite(s: GoogleVisibilitySite, dias: number, fuso: string) {
  if (!s.enabled) return { situacao: PARTE_INDISPONIVEL };
  if (!s.accounts.length) return { situacao: 'nenhum site ligado', o_que_fazer: 'ligar o site do Search Console em Contas conectadas' };
  const sites = s.accounts.map((c) => conta(c, 'site', fuso));
  if (!s.period) return { situacao: 'primeira leitura: os cliques dos últimos 90 dias e as buscas das últimas 12 semanas chegam em até um dia', sites };
  return soOQueExiste({
    sites,
    periodo: periodo(s.period, dias),
    cliques_vindos_das_buscas: inteiro(s.clicks),
    vezes_que_o_site_apareceu_nas_buscas: inteiro(s.impressions),
    posicao_media: posicaoComUmaCasa(s.position),
    cliques_nos_dias_anteriores: inteiro(s.previous_clicks),
    diferenca_para_os_dias_anteriores: diferenca(BigInt(s.clicks), s.previous_clicks),
    cliques_por_dia: s.daily.map((d) => ({ dia: dia(d.day), cliques: inteiro(d.clicks) })),
  });
}

/** As buscas da última semana fechada; nulo sem site ligado ou sem semana lida. */
function buscasDaSemana(s: GoogleVisibilitySite) {
  if (!s.enabled || !s.accounts.length || !s.queries) return null;
  const { week, items } = s.queries;
  return soOQueExiste({
    semana: periodo(week),
    buscas: items.slice(0, BUSCAS_MAXIMO).map((b) =>
      soOQueExiste({
        busca: b.query,
        cliques: inteiro(b.clicks),
        vezes_que_apareceu: inteiro(b.impressions),
        taxa_de_clique: taxaDeClique(BigInt(b.clicks), BigInt(b.impressions)),
        posicao_media: posicaoComUmaCasa(b.position),
      }),
    ),
    nota: items.length ? null : 'Nenhuma busca trouxe cliques ao site nesta semana.',
  });
}

/** As duas funções desligadas para a empresa: nada do Google para ler. */
export const GOOGLE_INDISPONIVEL = 'O perfil da empresa no Google e o site no Search Console não estão disponíveis para a empresa: o Liame não lê nada do Google para ela.';

export function visaoDoGoogle(r: GoogleVisibilityResponse, fuso: string) {
  if (!r.enabled) return { situacao: GOOGLE_INDISPONIVEL };
  const comNumeros = Boolean(r.profile.period) || Boolean(r.site.period);
  const buscas = buscasDaSemana(r.site);
  return soOQueExiste({
    perfil_no_google: partePerfil(r.profile, r.days, fuso),
    site_no_search_console: parteSite(r.site, r.days, fuso),
    buscas_da_ultima_semana: buscas,
    notas: [
      ...(comNumeros ? [NOTA_DO_ATRASO, NOTA_DAS_PARTES] : []),
      ...(r.site.period ? [NOTA_DA_POSICAO] : []),
      ...(buscas?.buscas ? [NOTA_DAS_BUSCAS] : []),
    ],
  });
}
