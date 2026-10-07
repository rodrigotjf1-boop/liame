import { describe, expect, it } from 'vitest';
import { problemaDaLeitura, recursoNaoEncontrado } from '../src/actions/leitura-na-plataforma.js';
import { ferramentasPara } from '../src/actions/opcoes-do-pedido.service.js';
import { PlanoRecusado, type ResourceState, TOOLS } from '../src/actions/tools.js';
import { ErroConector } from '../src/connectors/cliente-http.js';

// A4 · X8 (parte 1), sem banco: o que a tela do pedido de mudança oferece em cada objeto cabe no que a ferramenta
// aceita planejar nele (a regra mora em `tools.ts`: a oferta não pode prometer o que o pedido recusa), e a falha da
// leitura na plataforma sai nas mesmas palavras do pedido.

const REAL = 1_000_000;
type Tipo = 'campanha' | 'conjunto' | 'anuncio';
const DA_META = Object.values(TOOLS)
  .filter((t) => t.providers.includes('meta_ads'))
  .map((t) => t.name);

const estado = (tipo: Tipo, status: string, verba: number | null): ResourceState => ({
  tipo,
  id: '120210000000001',
  nome: 'Combo sexta',
  status,
  status_efetivo: null,
  daily_budget_micros: verba,
  lifetime_budget_micros: null,
  moeda: 'BRL',
});

/** A ferramenta aceita planejar neste estado? Na de verba, com um valor diferente do de agora. */
function planeja(ferramenta: string, s: ResourceState): boolean {
  const params = ferramenta === 'orcamento_ajustar' ? { daily_budget_micros: (typeof s.daily_budget_micros === 'number' ? s.daily_budget_micros : 30 * REAL) - REAL } : {};
  try {
    TOOLS[ferramenta]!.plan(s, params);
    return true;
  } catch (err) {
    if (err instanceof PlanoRecusado) return false;
    // A ferramenta de verba estoura (não recusa) quando o estado nem tem o campo da verba: para a tela, é "não cabe".
    if (ferramenta === 'orcamento_ajustar' && s.daily_budget_micros === null) return false;
    throw err;
  }
}

describe('o que dá para pedir num objeto de anúncio (A4 · X8)', () => {
  it('ativo: mudar a verba onde ela mora, e pausar; em pausa: retomar; arquivado, removido ou desconhecido: nada', () => {
    const oferta = (tipo: Tipo, status: string, verba: number | null) => ferramentasPara('meta_ads', { tipo, status, daily_budget_micros: verba });
    expect(oferta('campanha', 'ativo', 30 * REAL)).toEqual(['orcamento_ajustar', 'campanha_pausar']);
    expect(oferta('campanha', 'ativo', null)).toEqual(['campanha_pausar']);
    expect(oferta('conjunto', 'ativo', 25 * REAL)).toEqual(['orcamento_ajustar', 'conjunto_pausar']);
    expect(oferta('conjunto', 'ativo', null)).toEqual(['conjunto_pausar']);
    expect(oferta('anuncio', 'ativo', null)).toEqual(['anuncio_pausar']);
    // O anúncio nunca tem verba própria, nem que o estado traga um número.
    expect(oferta('anuncio', 'ativo', 30 * REAL)).toEqual(['anuncio_pausar']);
    expect(oferta('campanha', 'pausado', 30 * REAL)).toEqual(['campanha_retomar']);
    expect(oferta('conjunto', 'pausado', null)).toEqual(['conjunto_retomar']);
    expect(oferta('anuncio', 'pausado', null)).toEqual(['anuncio_retomar']);
    for (const morto of ['arquivado', 'removido', 'desconhecido', 'situacao_nova']) expect(oferta('campanha', morto, 30 * REAL)).toEqual([]);
  });

  it('a tela nunca oferece o que o pedido recusaria, e no objeto ativo oferece tudo o que ele aceita', () => {
    for (const tipo of ['campanha', 'conjunto', 'anuncio'] as const) {
      for (const status of ['ativo', 'pausado', 'arquivado', 'removido']) {
        for (const verba of [30 * REAL, null]) {
          // O anúncio com verba não existe na plataforma: fica fora da comparação.
          if (tipo === 'anuncio' && verba !== null) continue;
          const caso = `${tipo} ${status} ${verba === null ? 'sem verba' : 'com verba'}`;
          const s = estado(tipo, status, verba);
          const aceitas = DA_META.filter((f) => planeja(f, s)).sort();
          const oferecidas = ferramentasPara('meta_ads', { tipo, status, daily_budget_micros: verba }).sort();
          for (const f of oferecidas) expect(aceitas, caso).toContain(f);
          if (status !== 'pausado') expect(oferecidas, caso).toEqual(aceitas);
        }
      }
    }
    // Em pausa, a tela só oferece retomar (protótipo P9), embora a ferramenta de verba aceite mudar a verba do que
    // está parado: a pessoa retoma primeiro e muda a verba depois, com o objeto rodando.
    const pausada = estado('campanha', 'pausado', 30 * REAL);
    expect(planeja('orcamento_ajustar', pausada)).toBe(true);
    expect(ferramentasPara('meta_ads', { tipo: 'campanha', status: 'pausado', daily_budget_micros: 30 * REAL })).toEqual(['campanha_retomar']);
  });

  it('só oferece a ferramenta que existe para a plataforma', () => {
    // No provedor de mentira só existem a verba e a pausa do anúncio; numa plataforma que o Liame só lê, nada.
    expect(ferramentasPara('sandbox', { tipo: 'campanha', status: 'ativo', daily_budget_micros: 30 * REAL })).toEqual(['orcamento_ajustar']);
    expect(ferramentasPara('sandbox', { tipo: 'anuncio', status: 'pausado', daily_budget_micros: null })).toEqual([]);
    expect(ferramentasPara('google_ads', { tipo: 'campanha', status: 'ativo', daily_budget_micros: 30 * REAL })).toEqual([]);
  });
});

describe('a falha da leitura na plataforma, em palavras', () => {
  it('cada tipo de falha do conector vira um problema que a pessoa entende; o que não é do conector não é traduzido', () => {
    const p = (tipo: ConstructorParameters<typeof ErroConector>[0], provider = 'meta_ads') => problemaDaLeitura(provider, new ErroConector(tipo, provider, 'detalhe técnico'));
    expect([p('autenticacao')!.getStatus(), p('autenticacao')!.code]).toEqual([409, 'conta-desconectada']);
    expect(p('autenticacao')!.detail).toBe('A Meta recusou o acesso desta conta (a autorização foi revogada ou venceu). Conecte de novo em Contas conectadas.');
    expect([p('permissao')!.getStatus(), p('permissao')!.code]).toEqual([409, 'sem-permissao-na-plataforma']);
    expect([p('definitivo')!.getStatus(), p('definitivo')!.code, p('definitivo')!.detail]).toEqual([422, 'plataforma-recusou', 'A Meta não deixou ler o objeto: detalhe técnico']);
    for (const passageira of ['limite', 'transitorio'] as const) {
      expect([p(passageira)!.getStatus(), p(passageira)!.code]).toEqual([502, 'plataforma-indisponivel']);
      expect(p(passageira)!.detail).toBe('A Meta não respondeu agora, ou pediu para esperar. Nada foi pedido: tente de novo em alguns minutos.');
    }
    // Provedor sem nome próprio na frase.
    expect(p('transitorio', 'outra_plataforma')!.detail).toMatch(/^A plataforma não respondeu agora/);
    expect(problemaDaLeitura('meta_ads', new Error('defeito nosso'))).toBeNull();
    expect([recursoNaoEncontrado().getStatus(), recursoNaoEncontrado().code]).toEqual([404, 'recurso-nao-encontrado']);
  });
});
