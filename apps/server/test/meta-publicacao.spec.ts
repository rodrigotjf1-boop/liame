import { describe, expect, it } from 'vitest';
import { cabeNoInstagram, contaDoInstagram, erroDaMeta, PROPORCAO_DO_INSTAGRAM, situacaoDoConteiner } from '../src/connectors/meta/publicacao.js';

// A6 · Z5, sem rede e sem banco: as regras da publicação na Meta que o teste da D-A6-10 (`scripts/teste-foto-meta.ts`)
// usa e que o post de verdade vai usar (`base-conhecimento.md` §2.2, reconferida em 21/10/2026).

describe('a publicação na Meta: as regras puras (A6 · Z5)', () => {
  it('a proporção do feed do Instagram: de 4:5 (em pé) a 1,91:1 (deitada), as duas pontas dentro', () => {
    expect(PROPORCAO_DO_INSTAGRAM).toEqual({ minima: 0.8, maxima: 1.91 });
    expect(cabeNoInstagram(1080, 1350)).toBe(true); // 4:5
    expect(cabeNoInstagram(1080, 1080)).toBe(true); // quadrada
    expect(cabeNoInstagram(2048, 1365)).toBe(true); // 3:2, a horizontal das fotos do piloto
    expect(cabeNoInstagram(1910, 1000)).toBe(true); // 1,91:1
    expect(cabeNoInstagram(1080, 1351)).toBe(false); // mais em pé que 4:5
    expect(cabeNoInstagram(2048, 1000)).toBe(false); // mais deitada que 1,91:1
    expect(cabeNoInstagram(0, 100)).toBe(false);
    expect(cabeNoInstagram(100, Number.NaN)).toBe(false);
  });

  it('a conta do Instagram: a da primeira Página que tem uma; sem nenhuma, ou fora do formato, nulo', () => {
    const resposta = {
      data: [
        { id: '111', name: 'Página sem Instagram' },
        { id: '222', name: 'Mister Burguer - Penha RJ', instagram_business_account: { id: '17841400000000000', username: 'misterburguerpenharj' } },
        { id: '333', name: 'Outra', instagram_business_account: { id: '17841499999999999' } },
      ],
    };
    expect(contaDoInstagram(resposta)).toEqual({ paginaId: '222', pagina: 'Mister Burguer - Penha RJ', instagramId: '17841400000000000', usuario: 'misterburguerpenharj' });
    expect(contaDoInstagram({ data: [{ id: '333', instagram_business_account: { id: '1784' } }] })).toEqual({ paginaId: '333', pagina: '333', instagramId: '1784', usuario: null });
    expect(contaDoInstagram({ data: [{ id: '111', name: 'Sem' }] })).toBeNull();
    expect(contaDoInstagram({ data: 'não é lista' })).toBeNull();
    expect(contaDoInstagram(null)).toBeNull();
  });

  it('a situação do contêiner pelo `status_code`; o desconhecido não vira "pronto"', () => {
    expect(situacaoDoConteiner('FINISHED')).toBe('pronto');
    expect(situacaoDoConteiner('IN_PROGRESS')).toBe('processando');
    expect(situacaoDoConteiner('ERROR')).toBe('erro');
    expect(situacaoDoConteiner('EXPIRED')).toBe('vencido');
    expect(situacaoDoConteiner('PUBLISHED')).toBe('publicado');
    expect(situacaoDoConteiner('finished')).toBe('desconhecida');
    expect(situacaoDoConteiner(undefined)).toBe('desconhecida');
  });

  it('o erro da Graph API numa linha: a mensagem, o código, o subcódigo e o texto para a pessoa; sem erro, a frase de sempre', () => {
    const corpo = {
      error: {
        message: 'Media download has failed. The media URI doesn\'t meet our requirements.',
        type: 'OAuthException',
        code: 9004,
        error_subcode: 2207052,
        error_user_msg: 'Não foi possível baixar a mídia.',
      },
    };
    expect(erroDaMeta(corpo)).toBe("Media download has failed. The media URI doesn't meet our requirements. · código 9004 · subcódigo 2207052 · Não foi possível baixar a mídia.");
    expect(erroDaMeta({ error: { code: 190 } })).toBe('erro sem mensagem · código 190');
    expect(erroDaMeta({})).toBe('a Meta respondeu sem dizer o erro');
    expect(erroDaMeta(null)).toBe('a Meta respondeu sem dizer o erro');
    expect(erroDaMeta({ error: { message: 'x'.repeat(900) } })).toHaveLength(500);
  });
});
