import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { recusaDoInstagram } from '../src/actions/post-publicacao.js';
import { ErroConector } from '../src/connectors/cliente-http.js';
import { enderecoDoPost, horaDoInstagram, idDaResposta, limiteDePosts, postJaPublicado } from '../src/connectors/meta/publicacao.js';
import { type EstadoDoPost, recusaNaHoraDeSair } from '../src/posts/post-plano.js';
import { areaDoRecorte, recortarParaOInstagram } from '../src/posts/recorte.js';

// A6 · Z5b, parte 2, sem rede e sem banco: as regras do post no Instagram. A conferência na hora de sair
// (`posts/post-plano.ts`), o recorte na posição aprovada (`posts/recorte.ts`, com o sharp de verdade), as leituras da
// resposta da Meta (`connectors/meta/publicacao.ts`: o limite do dia, o post que já saiu, a data e o endereço) e a frase
// da recusa (`actions/post-publicacao.ts`).

const ID = '01a1b2c3-0000-7000-8000-000000000001';
const base: EstadoDoPost = {
  post: ID,
  foto: { id: '01a1b2c3-0000-7000-8000-000000000002', sha256: 'a'.repeat(64) },
  recorte: null,
  hora: '2026-10-30T22:00:00.000Z',
  hora_local: '19:00',
  canais: [
    { canal: 'instagram', conta: '01a1b2c3-0000-7000-8000-000000000003', texto: 'Smash duplo hoje.', situacao: 'aguardando' },
    { canal: 'facebook', conta: '01a1b2c3-0000-7000-8000-000000000004', texto: 'Smash duplo hoje: liame.link/abc', situacao: 'aguardando' },
  ],
};
const canal = (i: number, mudar: Partial<EstadoDoPost['canais'][number]>): EstadoDoPost => ({ ...base, canais: base.canais.map((c, j) => (j === i ? { ...c, ...mudar } : c)) });

describe('o post no Instagram: as regras puras (A6 · Z5b, parte 2)', () => {
  it('na hora de sair: a foto e a conta de cada canal que falta; o canal já publicado não conta, e o que começou a sair conta', () => {
    expect(recusaNaHoraDeSair(base)).toBeNull();
    expect(recusaNaHoraDeSair({ ...base, foto: null })).toBe('A foto deste post foi apagada nas Fotos: o post não sai. Faça um post novo com outra foto.');
    expect(recusaNaHoraDeSair(canal(1, { conta: null }))).toBe(
      'A conta da Página do Facebook deste post não está conectada à marca agora: o post não sai na Página do Facebook. Confira em Contas conectadas.',
    );
    // O Instagram já saiu: a conta dele desligada depois não impede a Página.
    expect(recusaNaHoraDeSair(canal(0, { situacao: 'publicado', conta: null }))).toBeNull();
    // O Instagram que começou a sair (o contêiner da tentativa anterior) ainda precisa da conta.
    expect(recusaNaHoraDeSair(canal(0, { situacao: 'publicando', conta: null }))).toContain('A conta do Instagram deste post não está conectada');
    expect(recusaNaHoraDeSair({ ...base, canais: base.canais.map((c) => ({ ...c, situacao: 'falhou' as const })) })).toBe('Este post já saiu, ou não sai mais: não dá para publicar de novo.');
  });

  it('a área do recorte: 4:5 na foto alta e 1,91:1 na larga, pela posição ao longo do lado comprido; a que cabe, nenhuma', () => {
    expect(areaDoRecorte(1200, 1800, 0)).toEqual({ left: 0, top: 0, width: 1200, height: 1500 });
    expect(areaDoRecorte(1200, 1800, 50)).toEqual({ left: 0, top: 150, width: 1200, height: 1500 });
    expect(areaDoRecorte(1200, 1800, 100)).toEqual({ left: 0, top: 300, width: 1200, height: 1500 });
    expect(areaDoRecorte(2048, 800, 0)).toEqual({ left: 0, top: 0, width: 1528, height: 800 });
    expect(areaDoRecorte(2048, 800, 100)).toEqual({ left: 520, top: 0, width: 1528, height: 800 });
    // Posição fora da faixa vai para a ponta; sem número, o centro.
    expect(areaDoRecorte(1200, 1800, 140)).toEqual(areaDoRecorte(1200, 1800, 100));
    expect(areaDoRecorte(1200, 1800, Number.NaN)).toEqual(areaDoRecorte(1200, 1800, 50));
    // Cabe (4:5, 1:1, 1,91:1, 4:3): vai inteira.
    for (const [l, a] of [[1080, 1350], [1080, 1080], [1910, 1000], [1600, 1200]] as const) expect(areaDoRecorte(l, a, 0)).toBeNull();
    expect(areaDoRecorte(0, 100, 50)).toBeNull();
    // O recorte cabe no Instagram (a proporção na faixa aceita).
    const alta = areaDoRecorte(1153, 2048, 50)!;
    expect(alta.width / alta.height).toBeGreaterThanOrEqual(0.8);
    const larga = areaDoRecorte(2048, 501, 50)!;
    expect(larga.width / larga.height).toBeLessThanOrEqual(1.91);
  });

  it('o recorte com o sharp de verdade: a foto alta sai em 4:5, em JPEG; a que cabe não é recortada', async () => {
    const alta = await sharp({ create: { width: 600, height: 1000, channels: 3, background: { r: 200, g: 100, b: 50 } } }).jpeg().toBuffer();
    const recorte = await recortarParaOInstagram(alta, 30);
    const m = await sharp(recorte!).metadata();
    expect([m.format, m.width, m.height]).toEqual(['jpeg', 600, 750]);
    const cabe = await sharp({ create: { width: 800, height: 800, channels: 3, background: { r: 1, g: 2, b: 3 } } }).jpeg().toBuffer();
    expect(await recortarParaOInstagram(cabe, 30)).toBeNull();
  });

  it('o limite de posts do dia: na lista `data` ou solto; fora do formato, nulo (quem chama segue)', () => {
    expect(limiteDePosts({ data: [{ quota_usage: 3, config: { quota_total: 50, quota_duration: 86400 } }] })).toEqual({ usados: 3, total: 50 });
    expect(limiteDePosts({ quota_usage: 100, config: { quota_total: 100 } })).toEqual({ usados: 100, total: 100 });
    for (const ruim of [null, {}, { data: [] }, { data: [{ quota_usage: '3', config: { quota_total: 50 } }] }, { data: [{ quota_usage: 3 }] }, { data: [{ quota_usage: 3, config: { quota_total: 0 } }] }]) {
      expect(limiteDePosts(ruim)).toBeNull();
    }
  });

  it('o post que já saiu: a mesma legenda (sem as pontas e com o fim de linha do Windows) desde a criação do post, contada em segundos', () => {
    const desde = new Date('2026-10-30T22:00:00.700Z');
    const lista = {
      data: [
        { id: '1790000000000003', caption: 'Outro post', timestamp: '2026-10-30T22:05:00+0000', permalink: 'https://www.instagram.com/p/c/' },
        { id: '1790000000000002', caption: ' Smash duplo\r\nhoje. ', timestamp: '2026-10-30T22:00:00+0000', permalink: 'https://www.instagram.com/p/b/' },
        { id: '1790000000000001', caption: 'Smash duplo\nhoje.', timestamp: '2026-10-29T22:00:00+0000', permalink: 'https://www.instagram.com/p/a/' },
      ],
    };
    expect(postJaPublicado(lista, 'Smash duplo\nhoje.', desde)).toEqual({ id: '1790000000000002', permalink: 'https://www.instagram.com/p/b/' });
    // O de ontem, com a mesma legenda, não é deste post.
    expect(postJaPublicado({ data: [lista.data[2]] }, 'Smash duplo\nhoje.', desde)).toBeNull();
    expect(postJaPublicado({ data: [{ ...lista.data[1], id: '../x' }] }, 'Smash duplo\nhoje.', desde)).toBeNull();
    expect(postJaPublicado({}, 'x', desde)).toBeNull();
    expect(horaDoInstagram('2026-10-30T22:00:00+0000')).toBe(Date.parse('2026-10-30T22:00:00Z'));
    expect(horaDoInstagram('2026-10-30T19:00:00-0300')).toBe(Date.parse('2026-10-30T22:00:00Z'));
    expect(horaDoInstagram(42)).toBeNaN();
  });

  it('o endereço e o id da resposta: só https do Instagram e só os dígitos da Graph', () => {
    expect(enderecoDoPost('https://www.instagram.com/p/abc/')).toBe('https://www.instagram.com/p/abc/');
    for (const ruim of ['http://www.instagram.com/p/abc/', 'https://instagram.com.exemplo.com/p/', 'javascript:alert(1)', 'https://exemplo.com/p/', 42, `https://www.instagram.com/${'x'.repeat(600)}`]) {
      expect(enderecoDoPost(ruim)).toBeNull();
    }
    expect(idDaResposta({ id: '17895695668004550' })).toBe('17895695668004550');
    expect(idDaResposta({ id: '1789/../x' })).toBeNull();
    expect(idDaResposta(null)).toBeNull();
  });

  it('a recusa em palavras: a autorização, a permissão e a recusa definitiva; o passageiro (limite, fora do ar), nulo para o trilho adiar', () => {
    expect(recusaDoInstagram(new ErroConector('autenticacao', 'meta_ads', 'x'))).toContain('Conecte a Meta de novo em Contas conectadas. O post não saiu no Instagram.');
    expect(recusaDoInstagram(new ErroConector('permissao', 'meta_ads', 'x'))).toContain('a permissão de publicar não está concedida');
    expect(recusaDoInstagram(new ErroConector('definitivo', 'meta_ads', 'x'))).toBe('O Instagram não aceitou o post. O post não saiu no Instagram.');
    for (const tipo of ['limite', 'transitorio', 'circuito_aberto'] as const) expect(recusaDoInstagram(new ErroConector(tipo, 'meta_ads', 'x'))).toBeNull();
    expect(recusaDoInstagram(new Error('outro'))).toBeNull();
  });
});
