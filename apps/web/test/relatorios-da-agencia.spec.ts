import type { AgencyReportItem, AgencyReportRecipient } from '@liame/contracts';
import { describe, expect, it } from 'vitest';
import {
  assuntoDoEmail,
  avisoDeMandado,
  comentarioCurto,
  contagemDosRelatorios,
  marcadosDePartida,
  mesDoTitulo,
  nomeDaLinha,
  situacaoDoRelatorio,
} from '../src/components/agencia/relatorios-textos';
import { itensVisiveis, NAVEGACAO } from '../src/components/shell/navegacao';

// A tela Relatórios da agência (A7, W7, parte 5b; P29 aprovado): a situação de cada relatório, o resumo do envio e o
// menu. Só mostra o que o servidor decide.

const AGORA = new Date('2026-11-02T15:00:00Z');

function item(o: Partial<AgencyReportItem> = {}): AgencyReportItem {
  return {
    link_id: 'l1',
    organization: { id: 'o1', name: 'Mister Burgers' },
    brand: { id: 'b1', name: 'Mister Burgers' },
    report_id: 'r1',
    generated_at: '2026-11-01T08:12:00Z',
    state: 'esperando',
    suspended_since: null,
    owner_name: null,
    last_send: null,
    liame_email_waits_until: '2026-11-03T12:00:00Z',
    ...o,
  };
}

describe('a situação de cada relatório', () => {
  it('esperando: pronto desde quando e até quando o e-mail do Liame espera, com "Revisar e mandar"', () => {
    const s = situacaoDoRelatorio(item(), true, AGORA);
    expect(s.tom).toBe('aguardando');
    expect(s.rotulo).toMatch(/^Pronto desde 01\/11, \d{2}:12 · esperando você$/);
    expect(s.texto).toMatch(/^O e-mail do Liame do mês espera você até 03\/11, \d{2}:00\.$/);
    expect(s.acao).toBe('revisar');
  });

  it('mandado: por quem, quando, para quantas pessoas e a versão corrigida; sozinho, sem quem assina', () => {
    const mandado = item({ state: 'mandado', last_send: { version: 2, mode: 'manual', sent_at: '2026-11-01T13:20:00Z', sent_by_name: 'Juliana Prado', has_comment: true, recipients: 2 } });
    const s = situacaoDoRelatorio(mandado, true, AGORA);
    expect(s).toMatchObject({ tom: 'concluido', texto: 'Com o comentário da agência.', acao: 'ver' });
    expect(s.rotulo).toMatch(/^Mandado por Juliana Prado em 01\/11, \d{2}:20, para 2 pessoas · versão corrigida$/);
    const sozinho = item({ state: 'mandado', last_send: { version: 1, mode: 'sozinho', sent_at: '2026-11-02T12:00:00Z', sent_by_name: null, has_comment: false, recipients: 1 } });
    expect(situacaoDoRelatorio(sozinho, true, AGORA).rotulo).toMatch(/^Saiu sozinho em 02\/11, \d{2}:00, para 1 pessoa$/);
  });

  it('a conta suspensa sem botão; sem relatório, sem acesso e fora do time; o estado novo fica neutro', () => {
    expect(situacaoDoRelatorio(item({ state: 'suspensa', suspended_since: '2026-10-25', owner_name: 'André Costa' }), true, AGORA)).toEqual({
      tom: 'perigo',
      rotulo: 'Conta suspensa desde 25/10/2026',
      texto: 'O relatório fica só com o dono, André Costa, até a conta voltar.',
      acao: null,
    });
    expect(situacaoDoRelatorio(item({ state: 'sem_relatorio' }), true, AGORA).acao).toBeNull();
    expect(situacaoDoRelatorio(item({ state: 'sem_acesso', brand: null }), false, AGORA).rotulo).toBe('Sem acesso aos resultados');
    expect(situacaoDoRelatorio(item({ state: 'fora_do_time', brand: null }), true, AGORA).texto).toContain('Escolher quem entra');
    expect(situacaoDoRelatorio(item({ state: 'fora_do_time', brand: null }), false, AGORA).texto).toBe('');
    expect(situacaoDoRelatorio(item({ state: 'algo_novo' }), true, AGORA)).toMatchObject({ tom: 'espera', acao: null });
  });

  it('a contagem, o mês do título e o nome da linha (a empresa quando a marca tem outro nome)', () => {
    expect(contagemDosRelatorios([item(), item({ state: 'mandado' })])).toBe('2 relatórios · 1 esperando você');
    expect(contagemDosRelatorios([item({ state: 'mandado' })])).toBe('1 relatório · nenhum esperando você');
    expect(mesDoTitulo('2026-10')).toBe('Outubro de 2026');
    expect(nomeDaLinha(item())).toEqual({ nome: 'Mister Burgers', empresa: null });
    expect(nomeDaLinha(item({ brand: { id: 'b2', name: 'MB Delivery' } }))).toEqual({ nome: 'MB Delivery', empresa: 'Mister Burgers' });
    expect(nomeDaLinha(item({ brand: null }))).toEqual({ nome: 'Mister Burgers', empresa: null });
  });
});

describe('mandar ao cliente', () => {
  const pessoas: AgencyReportRecipient[] = [
    { user_id: 'u1', name: 'Rodrigo', email: 'r@x.com', role: 'dono', always: true },
    { user_id: 'u2', name: 'Ana Lima', email: 'a@x.com', role: 'administrador', always: false },
    { user_id: 'u3', name: 'Contabilidade Silva', email: 'c@x.com', role: 'so_relatorios', always: false },
  ];

  it('quem vem marcado: no primeiro envio, os Administradores; de novo, quem recebeu antes (o Dono sempre, à parte)', () => {
    expect([...marcadosDePartida(pessoas, null)]).toEqual(['u2']);
    expect([...marcadosDePartida(pessoas, [{ name: 'Rodrigo', role: 'dono' }, { name: 'Contabilidade Silva', role: 'so_relatorios' }])]).toEqual(['u3']);
  });

  it('o assunto como o servidor manda, o comentário curto e o aviso depois de mandar', () => {
    expect(assuntoDoEmail('Agência Fogo', '2026-10-01', 'Mister Burgers', false)).toBe('Agência Fogo: o relatório de outubro da Mister Burgers');
    expect(assuntoDoEmail('Agência Fogo', '2026-10-01', 'Mister Burgers', true)).toBe('Agência Fogo: o relatório de outubro da Mister Burgers (versão corrigida)');
    expect(comentarioCurto('  ')).toBe('Sem comentário');
    expect(comentarioCurto('a'.repeat(100))).toBe(`${'a'.repeat(80)}…`);
    expect(avisoDeMandado({ recipients: 2, failed: 0, version: 1 })).toBe('Relatório mandado a 2 pessoas.');
    expect(avisoDeMandado({ recipients: 1, failed: 1, version: 2 })).toBe('Relatório mandado a 1 pessoa, como versão corrigida. Um e-mail não saiu: tente mandar de novo mais tarde.');
  });

  it('o menu da agência: Relatórios para todos da agência, logo depois de Clientes', () => {
    const doMembro = (p: string) => p === 'agencia.ver';
    expect(itensVisiveis(NAVEGACAO.find((g) => g.id === 'parceiro')!, doMembro, 'lite').map((i) => i.href)).toEqual(['/agencia/clientes', '/agencia/relatorios', '/agencia/time']);
  });
});
