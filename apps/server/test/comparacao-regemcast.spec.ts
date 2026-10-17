import { describe, expect, it } from 'vitest';
import { diferencas, FERRAMENTAS_COMPARADAS, MAX_CAMINHOS, normalizar, PERMISSOES_DA_COMPARACAO } from '../src/connectors/regemcast/comparacao.js';
import { LigacaoRegemcast } from '../src/connectors/regemcast/contrato-regemcast.js';

// Hub DMS (F2, A3, parte 2): a regra pura da comparação das duas credenciais do RegemCast.

describe('comparação das credenciais do RegemCast: o que se compara', () => {
  it('as 10 ferramentas de leitura do contrato v2, nenhuma de escrita; o token pede só as permissões delas', () => {
    expect(FERRAMENTAS_COMPARADAS).toHaveLength(10);
    for (const escrita of ['modelo_rascunhar', 'campanha_rascunhar', 'campanha_disparar', 'campanha_pausar', 'integracao_revogar']) {
      expect(FERRAMENTAS_COMPARADAS as readonly string[]).not.toContain(escrita);
    }
    expect([...PERMISSOES_DA_COMPARACAO].sort()).toEqual(['campanhas.disparar', 'campanhas.ler', 'conta.ler', 'conversas.anuncio.ler', 'modelos.ler', 'orcamento.ler', 'publicos.ler']);
  });

  it('só a lista de permissões da situação depende da credencial e sai antes de comparar; o resto fica', () => {
    const situacao = { contaId: 'c1', conta: 'Loja', fuso: 'America/Sao_Paulo', produto: 'liame', classe: 'dms', token: 'Liame', permissoes: [{ id: 'conta.ler' }], limitePorMinuto: 120 };
    expect(normalizar('integracao_situacao', situacao)).toEqual({ contaId: 'c1', conta: 'Loja', fuso: 'America/Sao_Paulo', produto: 'liame', classe: 'dms', token: 'Liame', limitePorMinuto: 120 });
    expect(normalizar('orcamento_ler', { permissoes: ['x'] })).toEqual({ permissoes: ['x'] });
    expect(normalizar('integracao_situacao', null)).toBeNull();
  });
});

describe('comparação das credenciais do RegemCast: as diferenças', () => {
  it('iguais campo a campo, em qualquer ordem de chave (V69), não têm diferença', () => {
    expect(diferencas({ a: 1, b: { c: [1, 2], d: 'x' } }, { b: { d: 'x', c: [1, 2] }, a: 1 })).toEqual([]);
    expect(diferencas([], [])).toEqual([]);
    expect(diferencas(null, null)).toEqual([]);
    expect(diferencas(Number.NaN, Number.NaN)).toEqual([]);
  });

  it('o caminho de cada campo diferente, sem o valor: o telefone da conversa nunca aparece', () => {
    const atual = { itens: [{ telefone: '+5521900000001', origem: 'anuncio' }], proximoCursor: null, temMais: false };
    const nova = { itens: [{ telefone: '+5521900000002', origem: 'anuncio' }], proximoCursor: null, temMais: false };
    const caminhos = diferencas(atual, nova);
    expect(caminhos).toEqual(['itens[0].telefone']);
    expect(JSON.stringify(caminhos)).not.toContain('5521');
  });

  it('lista de tamanho diferente leva [#] e compara o que tem dos dois lados; tipo diferente é diferença no próprio campo', () => {
    expect(diferencas({ c: [1, 2, 3] }, { c: [1, 9] })).toEqual(['c[#]', 'c[1]']);
    expect(diferencas({ a: null }, { a: 0 })).toEqual(['a']);
    expect(diferencas({ a: '1' }, { a: 1 })).toEqual(['a']);
    expect(diferencas({ a: { b: 1 } }, { a: [1] })).toEqual(['a']);
    expect(diferencas(1, 2)).toEqual(['(raiz)']);
  });

  it('o campo que falta de um lado e é undefined do outro não conta; null conta', () => {
    expect(diferencas({ a: 1 }, { a: 1, b: undefined })).toEqual([]);
    expect(diferencas({ a: 1 }, { a: 1, b: null })).toEqual(['b']);
  });

  it('chave que não é nome simples vai entre aspas; e guarda no máximo 20 caminhos', () => {
    expect(diferencas({ 'com espaço': 1 }, { 'com espaço': 2 })).toEqual(['"com espaço"']);
    const muitos = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`k${String(i).padStart(2, '0')}`, i]));
    const outros = Object.fromEntries(Object.keys(muitos).map((k) => [k, -1]));
    const caminhos = diferencas(muitos, outros);
    expect(caminhos).toHaveLength(MAX_CAMINHOS);
    expect(caminhos[0]).toBe('k00');
  });
});

describe('comparação das credenciais do RegemCast: a resposta da troca', () => {
  it('o segredo da ligação tem o formato do Padrão DMS; outro formato é recusado', () => {
    const ligacao = `dms_lg_regemcast_${'a'.repeat(43)}_${'b'.repeat(6)}`;
    const resposta = { ligacao, prefixo: 'dms_lg_regemcast_aaaaa', conta_id: 'c1', conta: 'Loja', permissoes: ['conta.ler'], segredo_em: '2026-10-16T12:00:00.000Z' };
    expect(LigacaoRegemcast.parse(resposta).ligacao).toBe(ligacao);
    expect(LigacaoRegemcast.safeParse({ ...resposta, ligacao: `dms_ap_regemcast_${'a'.repeat(43)}_${'b'.repeat(6)}` }).success).toBe(false);
    expect(LigacaoRegemcast.safeParse({ ...resposta, ligacao: `dms_lg_liame_${'a'.repeat(43)}_${'b'.repeat(6)}` }).success).toBe(false);
  });
});
