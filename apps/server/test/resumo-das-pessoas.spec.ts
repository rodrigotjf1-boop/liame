import { describe, expect, it } from 'vitest';
import { emailDoResumo, grupoDaAcao, linhasDaPessoa, semanaDoResumo } from '../src/people/resumo-das-pessoas.js';

// O resumo da semana do que cada pessoa fez (A7, W8; ADR-017; D-A7-53), sem banco: a semana, os grupos e o texto.

const SP = 'America/Sao_Paulo';

describe('o resumo da semana das pessoas: a semana', () => {
  it('a semana que fechou no domingo; na segunda, só a partir das 8h no fuso da empresa', () => {
    // 02/11/2026 é segunda-feira: 10h59 UTC são 7h59 em São Paulo.
    expect(semanaDoResumo(new Date('2026-11-02T10:59:00Z'), SP)).toEqual({ de: '2026-10-26', ate: '2026-11-01', pronto: false });
    expect(semanaDoResumo(new Date('2026-11-02T11:00:00Z'), SP)).toEqual({ de: '2026-10-26', ate: '2026-11-01', pronto: true });
    // Na terça (ou depois), a mesma semana, pronta: a rotina que não rodou na segunda manda depois.
    expect(semanaDoResumo(new Date('2026-11-03T03:00:00Z'), SP)).toEqual({ de: '2026-10-26', ate: '2026-11-01', pronto: true });
    // No domingo, a semana dele ainda não fechou: o resumo é o da anterior.
    expect(semanaDoResumo(new Date('2026-11-01T20:00:00Z'), SP)).toEqual({ de: '2026-10-19', ate: '2026-10-25', pronto: true });
    // O calendário é o da empresa: às 2h UTC de segunda ainda é domingo em São Paulo.
    expect(semanaDoResumo(new Date('2026-11-02T02:00:00Z'), SP).de).toBe('2026-10-19');
    expect(semanaDoResumo(new Date('2026-11-02T02:00:00Z'), 'UTC')).toEqual({ de: '2026-10-26', ate: '2026-11-01', pronto: false });
  });
});

describe('o resumo da semana das pessoas: os grupos', () => {
  it('cada ação da auditoria no seu grupo; as da própria pessoa ficam de fora', () => {
    const casos: Array<[string, ReturnType<typeof grupoDaAcao>]> = [
      ['acao.aprovar', 'aprovou'],
      ['peca.aprovar_varias', 'aprovou'],
      ['plano.aprovar', 'aprovou'],
      ['acao.recusar', 'recusou'],
      ['autonomia.recusar', 'recusou'],
      ['orcamento.definir', 'verba'],
      ['orcamento.limites', 'verba'],
      ['convite.criar', 'pessoas'],
      ['acesso.remover', 'pessoas'],
      ['conta.desconectar', 'contas'],
      ['conexao.revogar', 'contas'],
      ['webhook.cadastrar', 'contas'],
      ['parada.acionar', 'parada'],
      ['cobranca.cancelar', 'cobranca'],
      ['dados.exportar', 'exportou'],
      ['marca.arquivar', 'conta'],
      ['empresa.encerrar', 'conta'],
      ['marca.dossie_salvar', 'outras'],
      ['post.publicar', 'outras'],
      ['acao.pedir', 'outras'],
      ['sessao.abrir', null],
      ['sessao.encerrar_outras', null],
      ['segundo_fator.ativar', null],
      ['senha.redefinir', null],
      ['convite.aceitar', null],
      ['conta.criar', null],
      ['conta.conectar', 'contas'],
      ['empresa.trocar_ativa', null],
      ['flag.ligar', null],
    ];
    for (const [acao, grupo] of casos) expect([acao, grupoDaAcao(acao)]).toEqual([acao, grupo]);
  });

  it('as linhas de uma pessoa: o singular e o plural, e o resto no fim', () => {
    expect(linhasDaPessoa({ aprovou: 3, recusou: 1, verba: 2, pessoas: 1, outras: 4 })).toEqual([
      'aprovou 3 pedidos e recusou 1',
      'mudou a verba 2 vezes',
      'fez 1 mudança em Pessoas e acessos',
      'e mais 4 ações',
    ]);
    expect(linhasDaPessoa({ recusou: 1, parada: 1, exportou: 2 })).toEqual(['recusou 1 pedido', 'mexeu na parada de emergência 1 vez', 'exportou os dados da empresa 2 vezes']);
    expect(linhasDaPessoa({ outras: 1 })).toEqual(['fez 1 ação no Liame']);
    expect(linhasDaPessoa({ contas: 2, cobranca: 1, conta: 3 })).toEqual(['fez 2 mudanças em Contas conectadas', 'fez 1 mudança em Plano e cobrança', 'fez 3 mudanças nas marcas ou na conta da empresa']);
  });
});

describe('o resumo da semana das pessoas: o e-mail', () => {
  it('ao Dono pelo primeiro nome, a semana, cada pessoa com o nível, quem saiu e o link de Pessoas e acessos', () => {
    const e = emailDoResumo({
      dono: 'Rodrigo Teste',
      empresa: 'Mister Burgers',
      de: '2026-10-26',
      ate: '2026-11-01',
      link: 'https://app.exemplo/pessoas',
      pessoas: [
        { nome: 'Ana Lima', nivel: 'administrador', semAcessoDesde: null, contagem: { aprovou: 3, recusou: 1, verba: 2 } },
        { nome: 'Carlos Souza', nivel: 'gestor', semAcessoDesde: '2026-10-29', contagem: { outras: 2 } },
      ],
    });
    expect(e.subject).toBe('Liame: o que cada pessoa fez na Mister Burgers (26/10 a 01/11)');
    expect(e.text).toContain('Olá, Rodrigo.\n\nNa semana de 26/10 a 01/11, além de você, estas pessoas mexeram na conta da Mister Burgers:');
    expect(e.text).toContain('Ana Lima (Administrador)\n- aprovou 3 pedidos e recusou 1;\n- mudou a verba 2 vezes.');
    expect(e.text).toContain('Carlos Souza (Gestor, sem acesso desde 29/10)\n- fez 2 ações no Liame.');
    expect(e.text).toContain('tire o acesso da pessoa em Pessoas e acessos: https://app.exemplo/pessoas');
    expect(e.text).not.toContain(' ');
  });

  it('uma pessoa só, e a que não tem mais o nível guardado', () => {
    const e = emailDoResumo({ dono: 'Rodrigo', empresa: 'Mister Burgers', de: '2026-10-26', ate: '2026-11-01', link: 'x', pessoas: [{ nome: 'Ana', nivel: null, semAcessoDesde: null, contagem: { pessoas: 1 } }] });
    expect(e.text).toContain('além de você, esta pessoa mexeu na conta da Mister Burgers:\n\nAna\n- fez 1 mudança em Pessoas e acessos.');
  });
});
