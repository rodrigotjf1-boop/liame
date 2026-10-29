import { describe, expect, it } from 'vitest';
import {
  cabeNoInstagram,
  canaisDaMeta,
  contaDoInstagram,
  erroDaMeta,
  PROPORCAO_DO_INSTAGRAM,
  permissaoConcedida,
  permissaoNoDebug,
  permissoesConcedidas,
  permissoesDoDebug,
  situacaoDoConteiner,
} from '../src/connectors/meta/publicacao.js';

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

  it('a permissão concedida pela resposta do `me/permissions`: só `granted` vale; recusada, vencida, ausente ou fora do formato, não', () => {
    const resposta = {
      data: [
        { permission: 'ads_read', status: 'granted' },
        { permission: 'instagram_content_publish', status: 'granted' },
        { permission: 'pages_manage_posts', status: 'declined' },
        { permission: 'instagram_basic', status: 'expired' },
      ],
    };
    expect(permissaoConcedida(resposta, 'instagram_content_publish')).toBe(true);
    expect(permissaoConcedida(resposta, 'ads_read')).toBe(true);
    expect(permissaoConcedida(resposta, 'pages_manage_posts')).toBe(false); // desmarcada na hora de autorizar
    expect(permissaoConcedida(resposta, 'instagram_basic')).toBe(false); // vencida
    expect(permissaoConcedida(resposta, 'threads_basic')).toBe(false); // não pedida
    expect(permissaoConcedida({ data: [{ permission: 'instagram_content_publish' }] }, 'instagram_content_publish')).toBe(false);
    expect(permissaoConcedida({ data: [null] }, 'instagram_content_publish')).toBe(false);
    expect(permissaoConcedida({ data: 'não é lista' }, 'instagram_content_publish')).toBe(false);
    expect(permissaoConcedida(null, 'instagram_content_publish')).toBe(false);
  });

  it('a permissão pela resposta do `debug_token`: concedida só com o token válido e ela nos `scopes`; sem ela, ausente; token que não vale ou resposta fora do formato, inválido', () => {
    const valido = { data: { app_id: '100000000000001', type: 'SYSTEM_USER', is_valid: true, scopes: ['ads_read', 'instagram_basic', 'instagram_content_publish'] } };
    expect(permissaoNoDebug(valido, 'instagram_content_publish')).toBe('concedida');
    expect(permissaoNoDebug(valido, 'pages_manage_posts')).toBe('ausente');
    expect(permissaoNoDebug({ data: { is_valid: true } }, 'instagram_content_publish')).toBe('ausente');
    const vencido = { data: { is_valid: false, scopes: ['instagram_content_publish'], error: { code: 190, message: 'Error validating access token: Session has expired' } } };
    expect(permissaoNoDebug(vencido, 'instagram_content_publish')).toBe('token_invalido');
    expect(permissaoNoDebug({ data: { is_valid: 'true', scopes: ['instagram_content_publish'] } }, 'instagram_content_publish')).toBe('token_invalido');
    expect(permissaoNoDebug({ data: null }, 'instagram_content_publish')).toBe('token_invalido');
    expect(permissaoNoDebug(null, 'instagram_content_publish')).toBe('token_invalido');
  });

  it('as permissões para a coluna da autorização (A6 · Z5a): só as `granted` do `me/permissions`, sem repetir e em ordem; fora do formato, nulo (não "nenhuma")', () => {
    const resposta = {
      data: [
        { permission: 'pages_show_list', status: 'granted' },
        { permission: 'instagram_content_publish', status: 'granted' },
        { permission: 'pages_manage_posts', status: 'declined' },
        { permission: 'read_insights', status: 'expired' },
        { permission: 'ads_read', status: 'granted' },
        { permission: 'ads_read', status: 'granted' },
        { permission: '', status: 'granted' },
        null,
      ],
    };
    expect(permissoesConcedidas(resposta)).toEqual(['ads_read', 'instagram_content_publish', 'pages_show_list']);
    expect(permissoesConcedidas({ data: [] })).toEqual([]);
    expect(permissoesConcedidas({ data: 'não é lista' })).toBeNull();
    expect(permissoesConcedidas(null)).toBeNull();
  });

  it('as permissões pelo `debug_token`: os `scopes` só com o token válido, sem repetir e em ordem; token que não vale ou fora do formato, nulo', () => {
    expect(permissoesDoDebug({ data: { is_valid: true, scopes: ['pages_manage_posts', 'ads_read', 'ads_read', 7, ''] } })).toEqual(['ads_read', 'pages_manage_posts']);
    expect(permissoesDoDebug({ data: { is_valid: true, scopes: [] } })).toEqual([]);
    expect(permissoesDoDebug({ data: { is_valid: true } })).toBeNull();
    expect(permissoesDoDebug({ data: { is_valid: false, scopes: ['ads_read'] } })).toBeNull();
    expect(permissoesDoDebug({ data: { is_valid: 'true', scopes: ['ads_read'] } })).toBeNull();
    expect(permissoesDoDebug(null)).toBeNull();
  });

  it('as Páginas e os Instagram da autorização (A6 · Z5a): cada Página com o Instagram dela, quando tem; id fora do formato fica de fora', () => {
    const resposta = {
      data: [
        { id: '102030405060708', name: 'Casa Brasa', instagram_business_account: { id: '17841400000000001', username: 'casabrasa' } },
        { id: '102030405060709', name: 'Casa Brasa Eventos' },
        { id: '102030405060710', instagram_business_account: { id: '17841400000000002' } },
        { id: '1020/../me', name: 'Caminho' },
        { id: '102030405060711', name: 'Instagram com id estranho', instagram_business_account: { id: '1784?x=1' } },
        null,
      ],
    };
    expect(canaisDaMeta(resposta)).toEqual({
      paginas: [
        { id: '102030405060708', nome: 'Casa Brasa', instagramId: '17841400000000001' },
        { id: '102030405060709', nome: 'Casa Brasa Eventos', instagramId: null },
        { id: '102030405060710', nome: '102030405060710', instagramId: '17841400000000002' },
        { id: '102030405060711', nome: 'Instagram com id estranho', instagramId: null },
      ],
      instagrams: [
        { id: '17841400000000001', usuario: 'casabrasa', paginaId: '102030405060708', pagina: 'Casa Brasa' },
        { id: '17841400000000002', usuario: null, paginaId: '102030405060710', pagina: '102030405060710' },
      ],
    });
    expect(canaisDaMeta({ data: 'não é lista' })).toEqual({ paginas: [], instagrams: [] });
    expect(canaisDaMeta(null)).toEqual({ paginas: [], instagrams: [] });
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
