import { describe, expect, it } from 'vitest';
import {
  avisoAvaliacoesSemResposta,
  avisoDaSituacaoDaLoja,
  avisoLojasPorLigar,
  avisosDoPerfilDaMarca,
  type DadosDosAvisosDoPerfil,
  DIAS_DO_AVISO_DE_AVALIACAO,
  ESTRELAS_QUE_AVISAM,
} from '../src/avaliacoes/avisos-do-perfil.js';
import { type ItemAtencao, ordenar } from '../src/media/atencao.js';

// A6 · Z1 (parte d), sem rede e sem banco: os avisos do Perfil da Empresa no Google na Atenção. O que cada um diz, o
// que não entra (o texto da avaliação, quem avaliou, o código da loja), e a ordem deles entre os outros avisos.

const LOJA = { id: 'conta-1', nome: 'Mister Burgers — Centro' };
const EM = new Date('2026-10-09T15:00:00.000Z');

describe('avisos do Perfil da Empresa no Google na Atenção (A6 · Z1)', () => {
  it('a faixa do aviso: 1 ou 2 estrelas, feitas nos últimos 30 dias', () => {
    expect([ESTRELAS_QUE_AVISAM, DIAS_DO_AVISO_DE_AVALIACAO]).toEqual([2, 30]);
  });

  it('as lojas por ligar: no singular e no plural, com o caminho de Contas conectadas', () => {
    expect(avisoLojasPorLigar(1)).toEqual({
      kind: 'perfil_lojas_por_ligar',
      severity: 'atencao',
      title: 'O perfil da empresa no Google está pronto para ligar',
      detail: 'A autorização do Google alcança 1 loja do perfil que ainda não está ligada.',
      action: 'Escolha a loja em Contas conectadas para o Liame ler as avaliações.',
      connected_account_id: null,
      campaign_id: null,
      provider: 'google',
    });
    expect(avisoLojasPorLigar(3).detail).toBe('A autorização do Google alcança 3 lojas do perfil que ainda não estão ligadas.');
  });

  it('a avaliação sem resposta: uma só diz a nota dela; várias dizem quantas são; a data é a do dia da loja', () => {
    expect(avisoAvaliacoesSemResposta(LOJA, { quantas: 1, estrelas: 1, maisRecente: EM })).toEqual({
      kind: 'avaliacao_sem_resposta',
      severity: 'atencao',
      title: 'Avaliação de 1 estrela sem resposta',
      detail: 'Em Mister Burgers — Centro, no Google, feita em 09/10.',
      action: 'Responda no perfil da empresa no Google.',
      connected_account_id: 'conta-1',
      campaign_id: null,
      provider: null,
    });
    expect(avisoAvaliacoesSemResposta(LOJA, { quantas: 1, estrelas: 2, maisRecente: EM }).title).toBe('Avaliação de 2 estrelas sem resposta');
    const varias = avisoAvaliacoesSemResposta(LOJA, { quantas: 4, estrelas: 1, maisRecente: EM });
    expect([varias.title, varias.detail]).toEqual(['4 avaliações de 1 ou 2 estrelas sem resposta', 'Em Mister Burgers — Centro, no Google. A mais recente é de 09/10.']);
    // Feita às 02h da madrugada de 10/10 em UTC: no horário de Brasília ainda é dia 9.
    expect(avisoAvaliacoesSemResposta(LOJA, { quantas: 1, estrelas: 1, maisRecente: new Date('2026-10-10T02:00:00.000Z') }).detail).toContain('feita em 09/10');
    expect(avisoAvaliacoesSemResposta(LOJA, { quantas: 1, estrelas: 1, maisRecente: new Date('2026-10-10T02:00:00.000Z') }, 'UTC').detail).toContain('feita em 10/10');
  });

  it('a loja que parou de ser lida: desconectada, sem permissão e com defeito; a loja ativa não tem aviso', () => {
    const loja = (status: string, motivo: string | null = null) => avisoDaSituacaoDaLoja({ ...LOJA, status, motivo });
    expect(loja('ativa')).toBeNull();
    expect(loja('desconectada', 'O Google recusou a autorização desta loja: conecte de novo.')).toMatchObject({
      kind: 'conta_desconectada',
      severity: 'critica',
      title: 'Mister Burgers — Centro está desconectada',
      detail: 'O Google recusou a autorização desta loja: conecte de novo.',
      connected_account_id: 'conta-1',
      provider: null,
    });
    expect(loja('desconectada')!.detail).toBe('O Google recusou a autorização desta loja.');
    expect(loja('sem_permissao')).toMatchObject({ kind: 'conta_sem_permissao', severity: 'atencao', title: 'Sem permissão para ler Mister Burgers — Centro' });
    expect(loja('erro')).toMatchObject({ kind: 'conta_com_erro', severity: 'atencao', action: 'Nada a fazer por enquanto: tentamos de novo sozinhos.' });
  });

  it('os avisos de uma marca: cada loja com o dela; as lojas por ligar só quando a marca não tem loja; nada de outra marca', () => {
    const dados: DadosDosAvisosDoPerfil = {
      lojas: [
        { id: 'c1', marca: 'm1', nome: 'Centro', status: 'ativa', motivo: null },
        { id: 'c2', marca: 'm1', nome: 'Praia', status: 'desconectada', motivo: null },
        { id: 'c3', marca: 'm2', nome: 'Outra marca', status: 'erro', motivo: null },
      ],
      notasBaixas: [
        { conta: 'c1', quantas: 2, estrelas: 1, maisRecente: EM },
        // A loja desconectada tem o aviso dela; o número parado das avaliações não entra.
        { conta: 'c2', quantas: 5, estrelas: 1, maisRecente: EM },
      ],
      porLigar: [{ marca: 'm1', lojas: 1 }, { marca: 'm3', lojas: 2 }],
    };
    expect(avisosDoPerfilDaMarca('m1', dados).map((i) => [i.kind, i.connected_account_id])).toEqual([
      ['avaliacao_sem_resposta', 'c1'],
      ['conta_desconectada', 'c2'],
    ]);
    expect(avisosDoPerfilDaMarca('m2', dados).map((i) => [i.kind, i.connected_account_id])).toEqual([['conta_com_erro', 'c3']]);
    // Sem loja ligada, a marca ganha o convite.
    expect(avisosDoPerfilDaMarca('m3', dados).map((i) => i.kind)).toEqual(['perfil_lojas_por_ligar']);
    expect(avisosDoPerfilDaMarca('m4', dados)).toEqual([]);
    expect(avisosDoPerfilDaMarca('m3', { ...dados, porLigar: [{ marca: 'm3', lojas: 0 }] })).toEqual([]);
  });

  it('nenhum aviso leva o código da loja, o provedor em código ou algo de quem avaliou', () => {
    const todos = [avisoLojasPorLigar(2), avisoAvaliacoesSemResposta(LOJA, { quantas: 2, estrelas: 1, maisRecente: EM }), avisoDaSituacaoDaLoja({ ...LOJA, status: 'sem_permissao', motivo: null })!];
    const texto = todos.map((i) => `${i.title} ${i.detail} ${i.action}`).join(' ');
    for (const proibido of ['google_business', 'locations/', 'accounts/', 'reviewer']) expect(texto, proibido).not.toContain(proibido);
  });

  it('na lista da Atenção: a avaliação sem resposta vem depois do dinheiro e antes da conta sem permissão; as lojas por ligar, antes da versão de API', () => {
    const item = (kind: ItemAtencao['kind'], severity: ItemAtencao['severity'] = 'atencao'): ItemAtencao => ({ kind, severity, title: kind, detail: '', action: '', connected_account_id: null, campaign_id: null, provider: null });
    const ordenados = ordenar([
      item('versao_api'),
      item('perfil_lojas_por_ligar'),
      item('reconectar_em_breve'),
      item('conta_sem_permissao'),
      item('avaliacao_sem_resposta'),
      item('gasto_fora_do_normal'),
      item('conta_desconectada', 'critica'),
    ]).map((i) => i.kind);
    expect(ordenados).toEqual(['conta_desconectada', 'gasto_fora_do_normal', 'avaliacao_sem_resposta', 'conta_sem_permissao', 'reconectar_em_breve', 'perfil_lojas_por_ligar', 'versao_api']);
  });
});
