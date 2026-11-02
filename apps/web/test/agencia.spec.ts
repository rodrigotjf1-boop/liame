import type { AgencyClientResponse, AgencyRequestResponse } from '@liame/contracts';
import { describe, expect, it } from 'vitest';
import { acessoDaAgencia, clientesDaPessoa, contagemDoTime, maximoTxt, situacaoDoPedido, timeDoCliente } from '../src/components/agencia/textos';
import { destinoInicial } from '../src/components/shell/inicio';
import { itensVisiveis, NAVEGACAO } from '../src/components/shell/navegacao';

// As telas da agência (A7, W6, parte 5; P27 aprovado): as frases de Clientes, dos pedidos e do time, e o menu e a
// página inicial com a agência ativa (só os papéis da agência têm `agencia.*`).

const REAL = 1_000_000;
const sp = (s: string) => s.replace(/ /g, ' ');
const AGORA = new Date('2026-11-02T15:00:00Z');

function pedido(extra: Partial<AgencyRequestResponse> = {}): AgencyRequestResponse {
  return {
    id: 'p1',
    owner_email: 'dono@exemplo.com.br',
    requested_role: 'gestor',
    message: null,
    status: 'esperando',
    requested_by_name: 'Juliana Prado',
    created_at: '2026-11-02T12:00:00Z',
    expires_at: '2026-11-09T12:00:00Z',
    decided_at: null,
    ...extra,
  };
}

function cliente(extra: Partial<AgencyClientResponse> = {}): AgencyClientResponse {
  return {
    id: 'l1',
    organization: { id: 'o1', name: 'Mister Burgers' },
    max_role: 'gestor',
    approve_limit_micros: 500 * REAL,
    dual_approval: true,
    ends_at: null,
    since: '2026-10-31T12:00:00Z',
    status: 'ativo',
    ended_at: null,
    ended_side: null,
    team: [
      { user_id: 'u1', name: 'Caio Lima', role: 'gestor' },
      { user_id: 'u2', name: 'Bia Souza', role: 'aprovador' },
    ],
    ...extra,
  };
}

describe('as frases das telas da agência', () => {
  it('a situação de cada pedido', () => {
    expect(situacaoDoPedido(pedido(), AGORA)).toEqual({ texto: 'Enviado hoje · vale até 09/11 · pede Gestor', tom: 'aguardando', rotulo: 'Esperando o dono' });
    expect(situacaoDoPedido(pedido({ status: 'recusado', decided_at: '2026-11-01T12:00:00Z' }), AGORA)).toEqual({
      texto: 'O dono não aceitou o pedido, em 01/11.',
      tom: 'perigo',
      rotulo: 'Não aceito',
    });
    expect(situacaoDoPedido(pedido({ status: 'vencido', expires_at: '2026-10-30T12:00:00Z' }), AGORA)).toEqual({
      texto: 'Venceu em 30/10, sem resposta.',
      tom: 'espera',
      rotulo: 'Vencido',
    });
  });

  it('o que o dono deu e quem está em cada cliente', () => {
    expect(sp(acessoDaAgencia(cliente()))).toBe('A agência pode até Gestor · até R$ 500 por ação');
    expect(acessoDaAgencia(cliente({ max_role: 'somente_leitura', approve_limit_micros: null }))).toBe('A agência pode até Somente leitura');
    expect(acessoDaAgencia(cliente({ approve_limit_micros: null }))).toBe('A agência pode até Gestor · sem limite');
    expect(timeDoCliente(cliente())).toBe('Caio (Gestor), Bia (Aprovador)');
    expect(timeDoCliente(cliente({ team: [] }))).toBe('ninguém ainda');
    expect(sp(maximoTxt(cliente()))).toBe('O dono deu à agência até Gestor, aprovando sozinho até R$ 500 por ação. Ninguém do time passa disso.');
    expect(maximoTxt(cliente({ max_role: 'somente_leitura', approve_limit_micros: null }))).toBe('O dono deu à agência Somente leitura. Ninguém do time passa disso.');
  });

  it('o time: a contagem e os clientes de cada pessoa', () => {
    expect(contagemDoTime(4, 0)).toBe('4 pessoas.');
    expect(contagemDoTime(1, 2)).toBe('1 pessoa e 2 convites esperando resposta.');
    const lista = [cliente(), cliente({ id: 'l2', organization: { id: 'o2', name: 'Pizzaria Sol' }, team: [{ user_id: 'u1', name: 'Caio Lima', role: 'aprovador' }] })];
    expect(clientesDaPessoa({ user_id: 'u1' }, lista)).toBe('Clientes: Mister Burgers (Gestor), Pizzaria Sol (Aprovador)');
    expect(clientesDaPessoa({ user_id: 'u9' }, lista)).toBe('Em nenhum cliente ainda');
    // O vínculo que acabou não conta.
    expect(clientesDaPessoa({ user_id: 'u2' }, [cliente({ status: 'desfeito' })])).toBe('Em nenhum cliente ainda');
  });
});

describe('o menu e a página inicial com a agência ativa', () => {
  const daDona = (p: string) => ['agencia.ver', 'agencia.time', 'agencia.clientes'].includes(p);
  const doMembro = (p: string) => p === 'agencia.ver';

  it('a dona e o administrador abrem em Clientes; o membro, no Time da agência', () => {
    expect(destinoInicial('lite', daDona, true)).toBe('/agencia/clientes');
    expect(destinoInicial('pro', daDona, true)).toBe('/agencia/clientes');
    expect(destinoInicial('lite', doMembro, true)).toBe('/agencia/time');
  });

  it('com a agência ativa, só o grupo da agência aparece; numa empresa, ele some', () => {
    const grupos = (pode: (p: string) => boolean) => NAVEGACAO.filter((g) => !g.pessoal && itensVisiveis(g, pode, 'lite').length).map((g) => g.id);
    expect(grupos(daDona)).toEqual(['parceiro']);
    expect(itensVisiveis(NAVEGACAO.find((g) => g.id === 'parceiro')!, doMembro, 'lite').map((i) => i.href)).toEqual(['/agencia/time']);
    expect(grupos((p) => !p.startsWith('agencia.'))).not.toContain('parceiro');
  });
});
