import { describe, expect, it } from 'vitest';
import { mensagemDe, type Problema, SEM_CONEXAO } from '@/lib/api';

// O texto que a tela mostra quando a API recusa ou falha (RFC 9457): o campo inválido, o detalhe ou o
// título. No erro do nosso lado, o texto da API pede o código de rastreio: ele tem de aparecer junto.

const RASTREIO = '0123456789abcdef0123456789abcdef';
const problema = (p: Partial<Problema>): Problema => ({ status: 422, code: 'nao-processavel', title: 'Não foi possível processar', ...p });

describe('mensagem de erro da API para a pessoa', () => {
  it('o primeiro campo inválido, senão o detalhe, senão o título', () => {
    expect(mensagemDe(problema({ detail: 'O cupom já existe.', errors: [{ path: 'code', message: 'Informe o código do cupom.' }] }))).toBe('Informe o código do cupom.');
    expect(mensagemDe(problema({ detail: 'O cupom já existe.' }))).toBe('O cupom já existe.');
    expect(mensagemDe(problema({}))).toBe('Não foi possível processar');
  });

  it('erro do nosso lado (5xx): o texto pede o código de rastreio, e o código vai junto', () => {
    const interno = problema({ status: 500, code: 'interno', title: 'Algo deu errado do nosso lado', detail: 'Informe o código de rastreio ao suporte.', trace_id: RASTREIO });
    expect(mensagemDe(interno)).toBe(`Informe o código de rastreio ao suporte. Código de rastreio: ${RASTREIO}`);
    const fora = problema({ status: 503, code: 'indisponivel', title: 'Serviço indisponível', detail: 'Nada foi alterado. Tente de novo em instantes.', trace_id: RASTREIO });
    expect(mensagemDe(fora)).toBe(`Nada foi alterado. Tente de novo em instantes. Código de rastreio: ${RASTREIO}`);
  });

  it('nos outros casos o código não aparece: a mensagem já diz o que fazer', () => {
    // Recusa (4xx): o código viria na resposta, mas quem resolve é a pessoa, não o suporte.
    expect(mensagemDe(problema({ status: 403, code: 'sem-permissao', title: 'Sem permissão', detail: 'Você não tem permissão para esta ação.', trace_id: RASTREIO }))).toBe('Você não tem permissão para esta ação.');
    // 5xx sem código (resposta que não veio da API, como a de um proxy): só o texto.
    expect(mensagemDe(problema({ status: 502, code: 'erro-inesperado', title: 'Algo deu errado', detail: 'Tente de novo em instantes. Se continuar, fale com o suporte.' }))).toBe('Tente de novo em instantes. Se continuar, fale com o suporte.');
    // Sem resposta nenhuma (rede).
    expect(mensagemDe(SEM_CONEXAO)).toBe('Não conseguimos falar com o Liame. Confira a internet e tente de novo.');
  });
});
