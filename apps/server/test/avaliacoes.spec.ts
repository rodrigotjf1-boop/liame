import { describe, expect, it } from 'vitest';
import { AVALIACOES_NA_TELA, estadoSemLoja, notaDaEmpresa } from '../src/avaliacoes/avaliacoes.service.js';
import { avaliacaoDoGoogle, ESCOPO_PERFIL_GOOGLE, quemAvaliou, TAMANHO_DO_NOME } from '../src/connectors/google-business/perfil-google.js';

// A6 · Z1 (parte e), sem rede e sem banco: as regras da tela Avaliações. A nota da empresa com uma loja e com várias,
// o que falta quando não há loja ligada, e o nome de quem avaliou, que só sai por uma função à parte (para a tela).

const ADS = 'https://www.googleapis.com/auth/adwords';
const nota = (resultado: string) => ({ google_business: { resultado, em: '2026-10-11T12:00:00.000Z', lojas: 0 } });

describe('a tela Avaliações: as regras (A6 · Z1)', () => {
  it('a nota da empresa: a da loja; com várias, a média pesada pelo total de cada uma; o total é a soma', () => {
    expect(AVALIACOES_NA_TELA).toBe(200);
    expect(notaDaEmpresa([{ rating: 4.6, review_count: 128 }])).toEqual({ rating: 4.6, review_count: 128 });
    // 4,8 com 300 avaliações e 4,0 com 100: (4,8 × 300 + 4,0 × 100) / 400 = 4,6.
    expect(notaDaEmpresa([{ rating: 4.8, review_count: 300 }, { rating: 4.0, review_count: 100 }])).toEqual({ rating: 4.6, review_count: 400 });
    // A loja ainda sem leitura não entra na média nem muda o total das outras.
    expect(notaDaEmpresa([{ rating: 4.8, review_count: 300 }, { rating: null, review_count: null }])).toEqual({ rating: 4.8, review_count: 300 });
    // Nota sem total (o Google não informou): a loja pesa como uma avaliação.
    expect(notaDaEmpresa([{ rating: 5, review_count: null }, { rating: 3, review_count: null }])).toEqual({ rating: 4, review_count: null });
    expect(notaDaEmpresa([{ rating: 4.5, review_count: 0 }])).toEqual({ rating: 4.5, review_count: 0 });
    expect(notaDaEmpresa([])).toEqual({ rating: null, review_count: null });
    expect(notaDaEmpresa([{ rating: null, review_count: 12 }])).toEqual({ rating: null, review_count: 12 });
  });

  it('sem loja ligada, o que falta: a autorização, a permissão do perfil, ou o Google liberar o acesso', () => {
    const conexao = (scopes: string[], discovery_notes: unknown = {}, lojas = 0) => ({ scopes, discovery_notes, lojas });
    expect(estadoSemLoja([])).toBe('sem_perfil');
    expect(estadoSemLoja([conexao([ADS])])).toBe('sem_permissao');
    expect(estadoSemLoja([conexao([ADS, ESCOPO_PERFIL_GOOGLE], nota('limite'))])).toBe('esperando_google');
    // Com a permissão e o Google respondendo (há loja para escolher, ou não há perfil nesta conta): Contas conectadas.
    expect(estadoSemLoja([conexao([ADS, ESCOPO_PERFIL_GOOGLE], nota('ok'), 2)])).toBe('sem_perfil');
    expect(estadoSemLoja([conexao([ADS, ESCOPO_PERFIL_GOOGLE], nota('ok'), 0)])).toBe('sem_perfil');
    expect(estadoSemLoja([conexao([ADS, ESCOPO_PERFIL_GOOGLE], nota('sem_permissao'))])).toBe('sem_perfil');
    expect(estadoSemLoja([conexao([ADS, ESCOPO_PERFIL_GOOGLE], nota('falhou'))])).toBe('sem_perfil');
    expect(estadoSemLoja([conexao([ADS, ESCOPO_PERFIL_GOOGLE], {})])).toBe('sem_perfil');
    // Duas autorizações: a que tem a permissão é a que conta; a loja para escolher numa delas vence a espera da outra.
    expect(estadoSemLoja([conexao([ADS]), conexao([ADS, ESCOPO_PERFIL_GOOGLE], nota('limite'))])).toBe('esperando_google');
    expect(estadoSemLoja([conexao([ADS, ESCOPO_PERFIL_GOOGLE], nota('limite')), conexao([ADS, ESCOPO_PERFIL_GOOGLE], nota('ok'), 1)])).toBe('sem_perfil');
  });

  it('o nome de quem avaliou só sai pela função da tela: sem a foto, sem o anônimo, sem o caractere nulo, e no tamanho', () => {
    const bruta = { reviewId: 'rev-1', starRating: 'FIVE', createTime: '2026-10-01T12:00:00Z', reviewer: { displayName: '  Marina S. ', profilePhotoUrl: 'https://lh3.googleusercontent.com/a/foto', isAnonymous: false } };
    expect(quemAvaliou(bruta)).toEqual({ id: 'rev-1', nome: 'Marina S.' });
    // A leitura que o Liame guarda não leva nada disso.
    const guardada = avaliacaoDoGoogle(bruta);
    expect(Object.keys(guardada!).sort()).toEqual(['atualizadaEm', 'criadaEm', 'estrelas', 'id', 'resposta', 'texto']);
    expect(JSON.stringify(guardada)).not.toContain('Marina');

    expect(quemAvaliou({ ...bruta, reviewer: { ...bruta.reviewer, isAnonymous: true } })).toBeNull();
    expect(quemAvaliou({ ...bruta, reviewer: { displayName: `Jo${String.fromCharCode(0)}ão` } })).toEqual({ id: 'rev-1', nome: 'João' });
    expect(quemAvaliou({ ...bruta, reviewer: { displayName: 'x'.repeat(500) } })!.nome).toHaveLength(TAMANHO_DO_NOME);
    for (const sem of [{ ...bruta, reviewer: { displayName: '   ' } }, { ...bruta, reviewer: {} }, { ...bruta, reviewer: null }, { ...bruta, reviewer: 'Marina' }, { ...bruta, reviewId: '' }, { reviewer: bruta.reviewer }, null, 'texto']) {
      expect(quemAvaliou(sem), JSON.stringify(sem)).toBeNull();
    }
  });
});
