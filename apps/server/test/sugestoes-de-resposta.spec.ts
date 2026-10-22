import { describe, expect, it } from 'vitest';
import { PREFIXO_RETIRADA, retiradaDe } from '../src/actions/action.service.js';
import { resumoDoTexto } from '../src/actions/avaliacao-plano.js';
import { baseDoPedidoDoSocial } from '../src/ai/social/contexto.js';
import { sugestoesDaResposta } from '../src/ai/social/resposta.js';
import {
  achadosQueBarraram,
  avaliacaoAntiga,
  avaliacaoMudou,
  codigoDoMotivo,
  DIAS_DAS_SUGESTOES,
  ehCodigo,
  FLAG_DA_RESPOSTA,
  FLAG_DAS_SUGESTOES,
  itensQueBarraram,
  minutosAteATentativa,
  PEDIDO_QUE_CONTA,
  paramsDaResposta,
  maisSugestoes,
  RETIRADA_PORQUE_MUDOU,
  RETIRADA_PORQUE_RESPONDIDA,
  SEGUNDA_RODADA_DO_PEDIDO_RETIRADO,
  SITUACOES_DA_SUGESTAO,
  TENTATIVAS_DAS_SUGESTOES,
} from '../src/avaliacoes/sugestoes.js';

// A6 · Z6, parte 2, sem banco: as regras puras do caminho das sugestões de resposta (`avaliacoes/sugestoes.ts`). O
// caminho inteiro, da leitura do Google ao pedido em Aprovações, está em `test/db/sugestoes-de-resposta.spec.ts`.

const DIA_MS = 86_400_000;
const AGORA = new Date('2026-10-22T12:00:00.000Z');

describe('sugestões de resposta: as regras da rotina (A6 · Z6)', () => {
  it('as chaves, as situações e os prazos são os da decisão (D-A6-26 e D-A6-30) e os da migration 0079', () => {
    expect(FLAG_DAS_SUGESTOES).toBe('respostas_sugeridas');
    expect(FLAG_DA_RESPOSTA).toBe('perfil_google_write');
    expect(DIAS_DAS_SUGESTOES).toBe(30);
    expect(TENTATIVAS_DAS_SUGESTOES).toBe(3);
    expect([...SITUACOES_DA_SUGESTAO]).toEqual(['esperando', 'pronta', 'barrada', 'descartada', 'falhou', 'retirada']);
    // O pedido que conta como "já tem pedido": o que ainda anda e o que já publicou pelo Liame.
    expect([...PEDIDO_QUE_CONTA]).toEqual(['aguardando_aprovacao', 'aprovada', 'executando', 'executada']);
  });

  it('a próxima tentativa: 15, 30, 60 minutos…, com teto; e a avaliação de mais de 30 dias é antiga', () => {
    expect([0, 1, 2, 3].map(minutosAteATentativa)).toEqual([15, 30, 60, 120]);
    expect(minutosAteATentativa(-2)).toBe(15);
    expect(minutosAteATentativa(1.9)).toBe(30);
    expect(minutosAteATentativa(50)).toBe(15 * 2 ** 6);
    expect(avaliacaoAntiga(new Date(AGORA.getTime() - 30 * DIA_MS), AGORA)).toBe(false);
    expect(avaliacaoAntiga(new Date(AGORA.getTime() - 30 * DIA_MS - 1), AGORA)).toBe(true);
    expect(avaliacaoAntiga(new Date(AGORA.getTime() - DIA_MS), AGORA)).toBe(false);
  });

  it('o porquê e o que barrou são códigos no formato que o banco confere', () => {
    for (const bom of ['ia_teto', 'funcao_desligada', 'ab', 'a'.repeat(40)]) expect(ehCodigo(bom), bom).toBe(true);
    for (const ruim of ['a', 'Ia', 'ia-teto', 'ia teto', 'ia1', 'a'.repeat(41), '']) expect(ehCodigo(ruim), ruim).toBe(false);
    expect(codigoDoMotivo('sem-rota')).toBe('sem_rota');
    expect(codigoDoMotivo('plataforma-indisponivel')).toBe('plataforma_indisponivel');
    expect(codigoDoMotivo('Limite-Usuario')).toBe('limite_usuario');
    expect(codigoDoMotivo('x'.repeat(50))).toHaveLength(40);
  });

  it('o que barrou: os itens e os tipos dos achados das sugestões barradas, sem repetir e sem o texto', () => {
    const base = baseDoPedidoDoSocial({ estrelas: 1, texto: 'O lanche chegou frio.' }, { fatos: 'Mister Burgers', proibidas: [], concorrentes: [] });
    const { sugestoes } = sugestoesDaResposta(
      {
        sugestoes: [
          { enfoque: 'Com cupom', texto: 'Pedimos desculpas! Use um cupom de desconto por nossa conta.' },
          { enfoque: 'Com prazo', texto: 'Pedimos desculpas! Em 15 minutos a gente resolve.' },
        ],
      },
      base,
      2,
    );
    expect(sugestoes.map((s) => s.conferencia.situacao)).toEqual(['barrou', 'barrou']);
    expect(itensQueBarraram(sugestoes)).toEqual(['regras_da_resposta', 'numeros']);
    expect(achadosQueBarraram(sugestoes)).toEqual(['compensacao', 'numero_fora']);
    for (const nome of [...itensQueBarraram(sugestoes), ...achadosQueBarraram(sugestoes)]) expect(ehCodigo(nome), nome).toBe(true);
    // A que passou não entra.
    const { sugestoes: boas } = sugestoesDaResposta({ sugestoes: [{ enfoque: 'Curta', texto: 'Sentimos muito pela experiência.' }] }, base, 1);
    expect(itensQueBarraram(boas)).toEqual([]);
    expect(achadosQueBarraram(boas)).toEqual([]);
  });

  it('os parâmetros do pedido: o texto que vai ao Google começa sendo o da primeira, e as sugestões vão com a rodada', () => {
    const rodada1 = [
      { enfoque: 'Curta', texto: 'Obrigado pela visita!' },
      { enfoque: 'Mais calorosa', texto: 'Que bom ter você com a gente!' },
    ];
    expect(paramsDaResposta(rodada1, 1)).toEqual({ texto: 'Obrigado pela visita!', sugestoes: rodada1.map((s) => ({ ...s, rodada: 1 })) });
    // A segunda rodada vem antes, e as da primeira continuam no pedido.
    const anteriores = rodada1.map((s) => ({ ...s, rodada: 1 as const }));
    expect(paramsDaResposta([{ enfoque: 'Bem curta', texto: 'Valeu!' }], 2, anteriores)).toEqual({
      texto: 'Valeu!',
      sugestoes: [{ enfoque: 'Bem curta', texto: 'Valeu!', rodada: 2 }, ...anteriores],
    });
    // Só o enfoque e o texto vão (a conferência fica de fora).
    const conferida = { enfoque: 'Curta', texto: 'Obrigado!', conferencia: { situacao: 'passou' } };
    expect(paramsDaResposta([conferida], 1).sugestoes).toEqual([{ enfoque: 'Curta', texto: 'Obrigado!', rodada: 1 }]);
    expect(() => paramsDaResposta([], 1)).toThrow('pelo menos uma sugestão');
  });

  it('a retirada (P31): a avaliação mudou quando a nota ou o texto não são os do pedido; o porquê volta em código pela API', () => {
    const texto = 'Melhor smash da região!';
    const antes = { estrelas: 5, texto_resumo: resumoDoTexto(texto) };
    expect(avaliacaoMudou(antes, { stars: 5, comment: texto })).toBe(false);
    // O texto como o Liame o guarda (os espaços das pontas não contam), a nota e o texto que mudaram, e o que sumiu.
    expect(avaliacaoMudou(antes, { stars: 5, comment: `  ${texto}  ` })).toBe(false);
    expect(avaliacaoMudou(antes, { stars: 4, comment: texto })).toBe(true);
    expect(avaliacaoMudou(antes, { stars: 5, comment: 'Mudei de ideia.' })).toBe(true);
    expect(avaliacaoMudou(antes, { stars: 5, comment: null })).toBe(true);
    expect(avaliacaoMudou({ estrelas: 4, texto_resumo: null }, { stars: 4, comment: null })).toBe(false);
    expect([RETIRADA_PORQUE_MUDOU, RETIRADA_PORQUE_RESPONDIDA]).toEqual(['avaliacao_mudou', 'respondida_no_google']);
    for (const c of [RETIRADA_PORQUE_MUDOU, RETIRADA_PORQUE_RESPONDIDA]) expect(ehCodigo(c)).toBe(true);
    // O pedido cancelado pelo funcionário traz o código; o recusado por uma pessoa, o cancelado e o que espera, não.
    expect(retiradaDe({ status: 'cancelada', status_reason: `${PREFIXO_RETIRADA}avaliacao_mudou` })).toBe('avaliacao_mudou');
    expect(retiradaDe({ status: 'cancelada', status_reason: 'recusada por Rodrigo: Nenhuma serve' })).toBeNull();
    expect(retiradaDe({ status: 'cancelada', status_reason: 'cancelada por quem opera' })).toBeNull();
    expect(retiradaDe({ status: 'aguardando_aprovacao', status_reason: `${PREFIXO_RETIRADA}avaliacao_mudou` })).toBeNull();
    expect(retiradaDe({ status: 'cancelada', status_reason: `${PREFIXO_RETIRADA}Não É Código` })).toBeNull();
    expect(retiradaDe({ status: 'cancelada', status_reason: null })).toBeNull();
  });

  it('o "Pedir outras" (parte 3b): dá para pedir enquanto o pedido espera; depois, escrevendo, feitas ou não deu', () => {
    expect(maisSugestoes(null, true)).toBe('pode_pedir');
    expect(maisSugestoes(null, false)).toBeNull();
    expect(maisSugestoes({ status: 'esperando', reason: null }, true)).toBe('escrevendo');
    expect(maisSugestoes({ status: 'pronta', reason: null }, false)).toBe('feitas');
    for (const status of ['barrada', 'descartada', 'falhou'] as const) expect(maisSugestoes({ status, reason: 'pedido_decidido' }, true)).toBe('nao_deu');
    // A segunda rodada que era de um pedido retirado (a avaliação mudou) não aparece no pedido novo: ela vale uma vez por avaliação.
    expect(maisSugestoes({ status: 'descartada', reason: SEGUNDA_RODADA_DO_PEDIDO_RETIRADO }, true)).toBeNull();
    expect(ehCodigo(SEGUNDA_RODADA_DO_PEDIDO_RETIRADO)).toBe(true);
  });
});
