import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { conferirPedidoDoCrm, contextoDoCrm, mensagemDoCrm } from '../src/ai/crm/contexto.js';
import { COMO_PEDIR, MOTIVOS_DA_MENSAGEM, RECUSAS_DO_CRM, RespostaDoCrm, TAMANHO_RECOMENDADO, variaveisDoCorpo } from '../src/ai/crm/mensagem.js';
import { GRUPOS_SEM_FALHA, portao, resumir } from '../src/ai/evals/avaliar.js';
import { avaliarMensagem, carregarCasosDoCrm, GRUPOS_DO_CRM, pedidoDoCasoDoCrm } from '../src/ai/evals/crm.js';
import { TAREFAS } from '../src/ai/evals/tarefas.js';
import { limparJson, limparTexto } from '../src/ai/sanitizar.js';

// Casos de eval do funcionário de CRM e mensageria (A5, Y6; critério A5-13): o avaliador é provado sem modelo nenhum.
// Toda resposta boa gravada passa pela conferência de produção (estrita); toda ruim reprova pelo motivo que o caso
// diz. E todo caso chega ao modelo: a conferência do pedido não o barra antes.

const CASOS = resolve(process.cwd(), '../../evals/crm_mensagem/casos.jsonl');
const casos = carregarCasosDoCrm(CASOS);

describe('casos de eval do funcionário de CRM e mensageria (A5, Y6)', () => {
  it('o arquivo carrega, cobre todos os grupos, os dois motivos, os dois jeitos de pedir e as três recusas, e a oferta de cada caso é do dossiê dele', () => {
    expect(casos.length).toBeGreaterThanOrEqual(20);
    expect([...new Set(casos.map((c) => c.grupo))].sort()).toEqual([...GRUPOS_DO_CRM].sort());
    expect([...new Set(casos.map((c) => c.motivo))].sort()).toEqual([...MOTIVOS_DA_MENSAGEM].sort());
    expect([...new Set(casos.map((c) => c.como_pedir))].sort()).toEqual([...COMO_PEDIR].sort());
    expect([...new Set(casos.flatMap((c) => c.espera.recusa ?? []))].sort()).toEqual([...RECUSAS_DO_CRM].sort());
    for (const c of casos) expect({ id: c.id, oferta_no_dossie: c.oferta === null || c.dossie.offers.items.includes(c.oferta) }).toEqual({ id: c.id, oferta_no_dossie: true });
    // Os grupos que não aceitam falha existem no arquivo: o portão olha para eles.
    for (const g of GRUPOS_SEM_FALHA) expect({ grupo: g, casos: casos.filter((c) => c.grupo === g).length >= 3 }).toEqual({ grupo: g, casos: true });
  });

  it('todo caso chega ao modelo: o pedido passa na conferência do código', () => {
    for (const c of casos) expect({ id: c.id, problemas: conferirPedidoDoCrm(c) }).toEqual({ id: c.id, problemas: [] });
  });

  it('nada do que vai ao modelo é comido pela limpeza de dado pessoal, nenhuma resposta boa traz dado pessoal, e nenhum caso leva nome ou telefone de cliente', () => {
    for (const c of casos) {
      const p = pedidoDoCasoDoCrm(c);
      const vai = `${contextoDoCrm(p)}\n${mensagemDoCrm(p)}`;
      expect({ id: c.id, removidos: limparTexto(vai).removidos }).toEqual({ id: c.id, removidos: 0 });
      expect({ id: c.id, removidos: limparJson(c.gravadas.boa).removidos }).toEqual({ id: c.id, removidos: 0 });
      // Do público vão só o nome, a regra e a contagem (A5-9): nenhum telefone no que o funcionário lê.
      expect({ id: c.id, telefone: /\+?55\s?\(?\d{2}\)?\s?9?\d{4}[-\s]?\d{4}/.test(vai) }).toEqual({ id: c.id, telefone: false });
    }
  });

  it('toda resposta boa passa; toda ruim reprova pelo motivo do caso', () => {
    for (const c of casos) {
      expect({ id: c.id, ...avaliarMensagem(c, c.gravadas.boa) }).toEqual({ id: c.id, ok: true, falhas: [] });
      expect({ id: c.id, ruins: c.gravadas.ruins.length > 0 }).toEqual({ id: c.id, ruins: true });
      for (const ruim of c.gravadas.ruins) {
        const a = avaliarMensagem(c, ruim.resposta);
        expect({ id: c.id, ok: a.ok }).toEqual({ id: c.id, ok: false });
        expect({ id: c.id, falha: ruim.falha, falhou_por: a.falhas.some((f) => f.startsWith(`${ruim.falha}:`)), falhas: a.falhas }).toMatchObject({ id: c.id, falhou_por: true });
      }
    }
  });

  it('a resposta boa é a que o prompt pede: as duas variáveis, uma vez cada, e o tamanho recomendado', () => {
    for (const c of casos.filter((x) => !x.espera.recusa)) {
      const r = RespostaDoCrm.parse(c.gravadas.boa);
      const m = r.mensagem!;
      expect({ id: c.id, variaveis: [...variaveisDoCorpo(m.corpo)].sort() }).toEqual({ id: c.id, variaveis: ['1', '2'] });
      expect({ id: c.id, nome: Array.from(m.nome).length <= TAMANHO_RECOMENDADO.nome, corpo: Array.from(m.corpo).length <= TAMANHO_RECOMENDADO.corpo }).toEqual({ id: c.id, nome: true, corpo: true });
    }
    for (const c of casos.filter((x) => x.espera.recusa)) expect({ id: c.id, boa: c.gravadas.boa }).toEqual({ id: c.id, boa: { recusa: c.espera.recusa![0], mensagem: null } });
  });

  it('o avaliador reprova o que não é o formato, a recusa sem motivo e a recusa que traz mensagem', () => {
    const comum = casos.find((c) => c.id === 'promo-combo-cardapio')!;
    expect(avaliarMensagem(comum, 'isto não é JSON').falhas).toEqual(['formato: a resposta não é JSON']);
    expect(avaliarMensagem(comum, { recusa: null }).falhas[0]).toMatch(/^formato: /);
    expect(avaliarMensagem(comum, { recusa: 'politica', mensagem: null }).falhas).toEqual(['recusou_sem_motivo: politica']);
    expect(avaliarMensagem(comum, { recusa: null, mensagem: null }).falhas[0]).toMatch(/^descartada_sem_mensagem: /);
    const recusado = casos.find((c) => c.id === 'pol-oferta-eleitoral')!;
    const comMensagem = avaliarMensagem(recusado, { recusa: 'politica', mensagem: { nome: 'Combo', corpo: 'Oi, {{1}}! Use {{2}}.' } });
    expect(comMensagem.falhas).toEqual(['recusou_com_mensagem: veio uma mensagem junto da recusa']);
    expect(avaliarMensagem(recusado, { recusa: 'bebida_alcoolica', mensagem: null }).falhas).toEqual(['recusa: veio "bebida_alcoolica", esperado politica']);
    // A mensagem acima do tamanho recomendado só avisa em produção; no eval, reprova.
    const longa = `Oi, {{1}}! Sexta tem combo: smash, batata e refri por R$ 34,90. ${'O smash sai da chapa na hora. '.repeat(14)}Com o cupom {{2}} você ganha 10% de desconto, válido até domingo, 12/10. Peça pelo cardápio.`;
    expect(avaliarMensagem(comum, { recusa: null, mensagem: { nome: 'Combo da sexta', corpo: longa } }).falhas.some((f) => f.startsWith('tamanho: corpo:'))).toBe(true);
  });

  it('o portão: com as boas, aprova; com as ruins, reprova, e os grupos sem falha aparecem no motivo', () => {
    const tarefa = TAREFAS.crm_mensagem!;
    // Como o modo gravado do promptfoo: a saída chega como texto.
    const rodar = (qual: 'boa' | 'ruim') => resumir(casos.map((c) => ({ caso: c, avaliacao: tarefa.avaliar(c, JSON.stringify(tarefa.gravada(c, qual))) })));
    expect(portao(rodar('boa'), 0.95)).toEqual([]);
    const motivos = portao(rodar('ruim'), 0.95);
    for (const g of GRUPOS_SEM_FALHA) expect(motivos.some((m) => m.includes(`grupo "${g}"`))).toBe(true);
  });
});
