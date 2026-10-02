import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AttentionItem, MediaFreshnessResponse } from '@liame/contracts';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { conferirRegistro, conferirTrava, type FerramentaDef, type Registro, registroAtual, type Trava, travaDe } from '../src/ai/registro/definicoes.js';
import { AVISOS_MAXIMO, quando, visaoDoFrescor, visaoDosAvisos } from '../src/ai/registro/leituras.visoes.js';
import { limparTexto } from '../src/ai/sanitizar.js';

const ferramenta = (extra: Partial<FerramentaDef> = {}): FerramentaDef => ({
  name: 'teste_leitura',
  version: 1,
  description: 'Ferramenta de teste: lê uma coisa.',
  risk: 'R0',
  permission: 'vendas.ver',
  owner: 'testes',
  input: z.strictObject({ brand_id: z.uuid().optional() }),
  ...extra,
});
const registro = (extra: Partial<Registro> = {}): Registro => ({ ferramentas: [ferramenta()], prompts: [], funcionarios: [], ...extra });

describe('registro da IA: nada muda em silêncio (A3, I2)', () => {
  it('a trava commitada confere com o código: ferramenta, prompt ou funcionário mudou → sobe a versão e roda `ia:lock`', () => {
    const gravada = JSON.parse(readFileSync(resolve(process.cwd(), 'ia-registro.lock.json'), 'utf8')) as Trava;
    expect(conferirRegistro(registroAtual())).toEqual([]);
    expect(conferirTrava(travaDe(registroAtual()), gravada)).toEqual([]);
    // As de escrita (Action Service) e as de leitura estão no mesmo registro.
    expect(Object.keys(gravada.ferramentas)).toEqual(expect.arrayContaining(['regem_cupom_criar', 'fontes_frescor', 'atencao_avisos']));
  });

  it('acusa conteúdo que mudou com a mesma versão, versão que voltou, item novo e item que saiu', () => {
    const base = travaDe(registro());
    expect(conferirTrava(base, base)).toEqual([]);
    // Descrição, parâmetros, permissão e risco entram no hash.
    for (const mudanca of [{ description: 'Outra descrição para o modelo.' }, { input: z.strictObject({ loja: z.string() }) }, { permission: 'contas.ver' }, { risk: 'R1' as const }]) {
      expect(conferirTrava(travaDe(registro({ ferramentas: [ferramenta(mudanca)] })), base)).toEqual(['ferramentas.teste_leitura: o conteúdo mudou sem subir a versão (segue 1)']);
    }
    const v2 = travaDe(registro({ ferramentas: [ferramenta({ version: 2, description: 'Outra descrição para o modelo.' })] }));
    expect(conferirTrava(v2, base)).toEqual(['ferramentas.teste_leitura: versão 2 no código, 1 na trava']);
    expect(conferirTrava(base, v2)).toEqual(['ferramentas.teste_leitura: a versão voltou de 2 para 1']);
    const comPrompt = travaDe(registro({ prompts: [{ key: 'teste.explicar', version: 1, task: 'teste_explicar', content: 'Explique.' }] }));
    expect(conferirTrava(comPrompt, base)).toEqual(['prompts.teste.explicar: novo, falta na trava']);
    expect(conferirTrava(base, comPrompt)).toEqual(['prompts.teste.explicar: está na trava e saiu do código']);
    expect(conferirTrava(travaDe(registro({ prompts: [{ key: 'teste.explicar', version: 1, task: 'teste_explicar', content: 'Explique melhor.' }] })), comPrompt)).toEqual([
      'prompts.teste.explicar: o conteúdo mudou sem subir a versão (segue 1)',
    ]);
  });

  it('funcionário só referencia ferramenta e prompt que existem; leitura sempre declara a permissão', () => {
    const analista = { key: 'analista', version: 1, name: 'Analista', cargo: 'Analista de resultados', responsabilidades: ['Explicar os números'], ativoPorPadrao: true };
    const prompt = { key: 'teste.explicar', version: 1, task: 'teste_explicar', content: 'Explique.' };
    expect(conferirRegistro(registro({ prompts: [prompt], funcionarios: [{ ...analista, ferramentas: ['teste_leitura'], tarefas: [{ task: 'teste_explicar', prompt: 'teste.explicar' }] }] }))).toEqual([]);
    expect(
      conferirRegistro(
        registro({
          ferramentas: [ferramenta(), ferramenta(), ferramenta({ name: 'sem_permissao', permission: null })],
          prompts: [prompt],
          funcionarios: [{ ...analista, ferramentas: ['nao_existe'], tarefas: [{ task: 'outra_tarefa', prompt: 'teste.explicar' }, { task: 'x_tarefa', prompt: 'nao.existe' }] }],
        }),
      ),
    ).toEqual([
      'ferramenta repetida: teste_leitura',
      'ferramenta sem_permissao: leitura sem permissão declarada',
      'funcionário analista: ferramenta desconhecida nao_existe',
      'funcionário analista: o prompt teste.explicar é da tarefa teste_explicar, não de outra_tarefa',
      'funcionário analista: prompt desconhecido nao.existe',
    ]);
  });
});

describe('visão das leituras para o modelo: tudo já formatado, nada que a limpeza de dado pessoal coma', () => {
  const frescor: MediaFreshnessResponse = {
    items: [
      {
        connected_account_id: '0199a300-0000-7000-8000-0000000000a1',
        brand_id: '0199a300-0000-7000-8000-0000000000b1',
        provider: 'meta_ads',
        name: 'CA - Pizzaria da Praça',
        status: 'ativa',
        status_reason: null,
        datasets: [
          { dataset: 'metricas', freshness: 'fresh', last_success_at: '2026-10-02T04:54:12.000Z', last_attempt_at: '2026-10-02T04:54:12.000Z', last_error: null, next_at: '2026-10-03T04:54:00.000Z' },
          { dataset: 'entidades', freshness: 'stale', last_success_at: null, last_attempt_at: '2026-10-02T04:50:00.000Z', last_error: 'limite da plataforma', next_at: null },
        ],
      },
      { connected_account_id: '0199a300-0000-7000-8000-0000000000a2', brand_id: '0199a300-0000-7000-8000-0000000000b1', provider: 'regem', name: 'Loja Centro', status: 'sem_permissao', status_reason: 'token recusado', datasets: [] },
    ],
  };

  it('frescor: plataforma pelo nome, datas no fuso da empresa e só o que existe', () => {
    const v = visaoDoFrescor(frescor, 'America/Sao_Paulo');
    expect(v).toEqual({
      fuso: 'America/Sao_Paulo',
      contas: [
        {
          plataforma: 'Meta',
          conta: 'CA - Pizzaria da Praça',
          situacao: 'ativa',
          dados: [
            { conjunto: 'metricas', frescor: 'em dia', ultima_leitura: '02/10/2026 01:54', proxima_leitura: '03/10/2026 01:54' },
            { conjunto: 'entidades', frescor: 'parado', ultima_leitura: null, proxima_leitura: null, ultima_falha: 'limite da plataforma' },
          ],
        },
        { plataforma: 'Regem', conta: 'Loja Centro', situacao: 'sem_permissao', motivo: 'token recusado', dados: [] },
      ],
    });
    expect(limparTexto(JSON.stringify(v)).removidos).toBe(0);
    expect(quando('2026-10-02T04:54:12.000Z', 'UTC')).toBe('02/10/2026 04:54');
    expect(quando(null, 'UTC')).toBeNull();
  });

  it('avisos: os mais graves primeiro, no máximo 40, com o texto que a tela mostra', () => {
    const aviso = (severity: string, n: number): AttentionItem => ({
      kind: 'campanha_sem_pedido',
      severity,
      title: `Campanha ${n} gastou e não trouxe pedido`,
      detail: 'Gastou R$ 1.250,00 em 7 dias, com 12.500 cliques, e nenhum pedido confirmado.',
      action: 'Confira o link do anúncio e o cupom da campanha.',
      connected_account_id: null,
      campaign_id: '0199a300-0000-7000-8000-0000000000c1',
      provider: n % 2 ? 'meta_ads' : null,
      brand_id: null,
    });
    const v = visaoDosAvisos([aviso('info', 1), aviso('critica', 2), aviso('atencao', 3)], '2026-10-02T12:00:00.000Z', 'America/Sao_Paulo');
    expect(v.avisos.map((a) => a.gravidade)).toEqual(['critica', 'atencao', 'info']);
    expect(v).toMatchObject({ gerado_em: '02/10/2026 09:00', total: 3 });
    expect(v.avisos[2]).toEqual({
      gravidade: 'info',
      tipo: 'campanha_sem_pedido',
      plataforma: 'Meta',
      titulo: 'Campanha 1 gastou e não trouxe pedido',
      detalhe: 'Gastou R$ 1.250,00 em 7 dias, com 12.500 cliques, e nenhum pedido confirmado.',
      o_que_fazer: 'Confira o link do anúncio e o cupom da campanha.',
    });
    expect(v.avisos[0]).not.toHaveProperty('plataforma');
    expect(limparTexto(JSON.stringify(v)).removidos).toBe(0);

    const muitos = visaoDosAvisos(Array.from({ length: 55 }, (_, i) => aviso(i < 50 ? 'info' : 'critica', i)), '2026-10-02T12:00:00.000Z', 'UTC');
    expect(muitos).toMatchObject({ total: 55, mostrando: AVISOS_MAXIMO });
    expect(muitos.avisos).toHaveLength(AVISOS_MAXIMO);
    expect(muitos.avisos.slice(0, 5).every((a) => a.gravidade === 'critica')).toBe(true);
  });
});
