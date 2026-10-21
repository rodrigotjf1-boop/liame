import { BRAND_PHOTO_LIMITS, type BrandPhoto } from '@liame/contracts';
import { createElement, createRef } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CartaoFoto } from '@/components/fotos/cartao-foto';
import { FilaDoEnvio, type ItemDoEnvio } from '@/components/fotos/fila-do-envio';
import {
  ACEITA,
  AVISO_DE_NITIDEZ,
  conferirArquivo,
  conferirMedidas,
  contagens,
  enderecosVencendo,
  type Fase,
  foraDoLote,
  grupos,
  INFO_DO_ENVIO,
  medidas,
  mudancas,
  notaDoRecorte,
  POR_VEZ,
  quemEnviou,
  RECUSA,
  recusaDoCodigo,
  resumoDoEnvio,
  rotuloDoCartao,
  tituloDoEnvio,
  visiveis,
} from '@/components/fotos/textos';
import { itensVisiveis, NAVEGACAO, temModos, tituloDa } from '@/components/shell/navegacao';

// Fotos (A6 · Z4, parte b; P20, aprovado em 21/10/2026; mockups/prototipo-fotos.html): as regras da tela sobre o que a
// API devolve (`/v1/brand-photos`) e o desenho do cartão e da lista do envio pelos mesmos componentes do navegador.

const uuid = (n: number) => `a0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const AGORA = new Date(2026, 9, 21, 15, 0);
const local = (d: number, h: number, m: number) => new Date(2026, 9, d, h, m).toISOString();

function foto(over: Partial<BrandPhoto> = {}): BrandPhoto {
  return {
    id: uuid(1),
    brand_id: uuid(9),
    product: 'Smash duplo',
    description: 'Smash duplo no balcão',
    width: 1080,
    height: 1080,
    bytes: 412_000,
    orientation: 'quadrada',
    narrow_for_instagram: false,
    instagram_crop: 'nenhum',
    uploaded_at: local(18, 14, 52),
    uploaded_by: { id: uuid(7), name: 'Ana' },
    url: 'https://imagens.exemplo/foto.jpg?assinado',
    thumbnail_url: 'https://imagens.exemplo/foto-mini.jpg?assinado',
    urls_expire_at: new Date(AGORA.getTime() + 300_000).toISOString(),
    ...over,
  };
}

describe('Fotos: a conferência antes de enviar (os limites do contrato, os mesmos do servidor)', () => {
  it('o tipo: JPEG, PNG e WebP passam; HEIC pelo tipo ou pelo nome; o resto não', () => {
    expect(ACEITA).toBe('image/jpeg,image/png,image/webp');
    const arq = (name: string, type: string, size = 1000) => ({ name, type, size });
    expect(conferirArquivo(arq('smash.jpg', 'image/jpeg'))).toBeNull();
    expect(conferirArquivo(arq('smash.png', 'image/png'))).toBeNull();
    expect(conferirArquivo(arq('smash.webp', 'image/webp'))).toBeNull();
    expect(conferirArquivo(arq('IMG_2041.HEIC', 'image/heic'))).toBe('heic');
    // O Windows não diz o tipo do HEIC: o nome decide.
    expect(conferirArquivo(arq('IMG_2041.HEIC', ''))).toBe('heic');
    expect(conferirArquivo(arq('foto.heif', 'image/heif'))).toBe('heic');
    expect(conferirArquivo(arq('cardapio.pdf', 'application/pdf'))).toBe('formato');
    expect(conferirArquivo(arq('anima.gif', 'image/gif'))).toBe('formato');
    expect(conferirArquivo(arq('grande.png', 'image/png', BRAND_PHOTO_LIMITS.maxBytes + 1))).toBe('tamanho');
    expect(conferirArquivo(arq('limite.png', 'image/png', BRAND_PHOTO_LIMITS.maxBytes))).toBeNull();
    expect(conferirArquivo(arq('vazio.jpg', 'image/jpeg', 0))).toBe('nao_abre');
  });

  it('as medidas: recusa abaixo de 600 px no lado menor e acima de 10.000 no maior; 0 = não abriu', () => {
    expect(conferirMedidas(600, 600)).toBeNull();
    expect(conferirMedidas(599, 4000)).toBe('pequena');
    expect(conferirMedidas(4000, 599)).toBe('pequena');
    expect(conferirMedidas(10_000, 800)).toBeNull();
    expect(conferirMedidas(10_001, 800)).toBe('grande');
    expect(conferirMedidas(0, 0)).toBe('nao_abre');
  });

  it('a recusa do servidor pelo código do problema; o que não é recusa (falha, 5xx) fica de fora', () => {
    expect(recusaDoCodigo('foto-formato')).toBe('formato');
    expect(recusaDoCodigo('formato-nao-suportado')).toBe('formato');
    expect(recusaDoCodigo('foto-heic')).toBe('heic');
    expect(recusaDoCodigo('grande-demais')).toBe('tamanho');
    expect(recusaDoCodigo('foto-nao-abre')).toBe('nao_abre');
    expect(recusaDoCodigo('foto-sem-arquivo')).toBe('nao_abre');
    expect(recusaDoCodigo('foto-pequena')).toBe('pequena');
    expect(recusaDoCodigo('foto-grande-demais')).toBe('grande');
    expect(recusaDoCodigo('foto-repetida')).toBe('repetida');
    expect(recusaDoCodigo('funcao-desligada')).toBe('desligada');
    for (const c of ['foto-nao-guardada', 'fotos-indisponiveis', 'sem-conexao', 'erro-inesperado', 'nao-autenticado']) expect(recusaDoCodigo(c)).toBeNull();
  });

  it('os textos do protótipo: o motivo de cada recusa, o aviso de nitidez pela largura (ERR-152) e a linha do envio', () => {
    expect(RECUSA.heic).toBe('Não entrou: foto em HEIC. Envie em JPEG.');
    expect(RECUSA.tamanho).toBe('Não entrou: passa de 10 MB.');
    expect(RECUSA.pequena).toBe('Não entrou: tem menos de 600 px no lado menor.');
    expect(RECUSA.grande).toBe('Não entrou: passa de 10.000 px no lado maior.');
    expect(AVISO_DE_NITIDEZ).toBe('Entrou, mas tem menos de 1.080 px de largura: no Instagram, pode sair sem nitidez.');
    expect(INFO_DO_ENVIO).toBe('JPEG, PNG ou WebP, até 10 MB. Prefira foto quadrada ou na horizontal. Só fotos que a empresa pode usar, sem pessoas que dê para reconhecer.');
    expect(POR_VEZ).toBe(20);
    expect(foraDoLote(1)).toBe('Até 20 fotos por vez: 1 ficou de fora.');
    expect(foraDoLote(3)).toBe('Até 20 fotos por vez: 3 ficaram de fora.');
  });
});

describe('Fotos: a lista do envio', () => {
  it('o título enquanto envia e no fim (todas, nenhuma, parte), e o que se anuncia', () => {
    expect(tituloDoEnvio(['enviando', 'na_fila', 'ok'])).toBe('Enviando 3 fotos');
    expect(tituloDoEnvio(['conferindo'])).toBe('Enviando 1 foto');
    expect(tituloDoEnvio(['ok', 'aviso'])).toBe('As 2 fotos entraram');
    expect(tituloDoEnvio(['ok'])).toBe('A foto entrou');
    expect(tituloDoEnvio(['recusada'])).toBe('A foto não entrou');
    expect(tituloDoEnvio(['recusada', 'falhou'])).toBe('Nenhuma das 2 fotos entrou');
    expect(tituloDoEnvio(['ok', 'recusada', 'falhou'])).toBe('1 de 3 fotos entrou');
    expect(tituloDoEnvio(['ok', 'aviso', 'recusada'])).toBe('2 de 3 fotos entraram');
    expect(resumoDoEnvio(['ok', 'aviso', 'recusada'])).toBe('2 fotos entraram; 1 não entrou.');
    expect(resumoDoEnvio(['ok'])).toBe('1 foto entrou.');
  });

  it('cada situação desenhada: na fila, a barra com a porcentagem, conferindo, entrou, aviso, recusa e "Tentar de novo" só na que caiu', () => {
    const item = (id: string, fase: Fase, extra: Partial<ItemDoEnvio> = {}): ItemDoEnvio => ({ id, nome: `${id}.jpg`, fase, pct: 0, previa: null, ...extra });
    const itens = [
      item('a', 'na_fila'),
      item('b', 'enviando', { pct: 62 }),
      item('c', 'conferindo', { pct: 100 }),
      item('d', 'ok'),
      item('e', 'aviso'),
      item('f', 'recusada', { recusa: 'heic' }),
      item('g', 'falhou'),
    ];
    const html = renderToStaticMarkup(createElement(FilaDoEnvio, { itens, tituloRef: createRef<HTMLHeadingElement>(), aoTentarDeNovo: () => undefined, aoFechar: () => undefined }));
    expect(html).toContain('Enviando 7 fotos');
    expect(html).toContain('Na fila…');
    expect(html).toContain('aria-valuenow="62"');
    expect(html).toContain('Enviando… 62%');
    expect(html).toContain('Conferindo a foto…');
    expect(html).toContain('Entrou.');
    expect(html).toContain(AVISO_DE_NITIDEZ);
    expect(html).toContain(RECUSA.heic);
    expect(html).toContain('Não foi: a conexão caiu no meio do envio.');
    expect(html.match(/data-ft-de-novo-item=/g)).toHaveLength(1);
    // Enquanto alguma não terminou, a lista não fecha.
    expect(html).not.toContain('Fechar a lista');
    const fim = renderToStaticMarkup(
      createElement(FilaDoEnvio, {
        itens: [item('d', 'ok'), item('g', 'falhou', { falha: 'Não foi: Não deu para guardar a foto agora. Tente de novo.' })],
        tituloRef: createRef<HTMLHeadingElement>(),
        aoTentarDeNovo: () => undefined,
        aoFechar: () => undefined,
      }),
    );
    expect(fim).toContain('1 de 2 fotos entrou');
    expect(fim).toContain('Fechar a lista');
    expect(fim).toContain('Não foi: Não deu para guardar a foto agora.');
  });
});

describe('Fotos: a grade e a gaveta', () => {
  it('os filtros: os produtos de Minha marca que têm foto, na ordem de lá; os que saíram de lá; e "Sem produto" no fim', () => {
    const fotos = [foto({ product: 'Milk-shake' }), foto({ product: null }), foto({ product: 'Smash duplo' }), foto({ product: 'Smash duplo' }), foto({ product: 'Antigo' })];
    const produtos = ['Smash duplo', 'Combo sexta', 'Milk-shake'];
    expect(grupos(fotos, produtos)).toEqual(['Smash duplo', 'Milk-shake', 'Antigo', '']);
    const c = contagens(fotos);
    expect([c.get('todas'), c.get('Smash duplo'), c.get(''), c.get('Combo sexta')]).toEqual([5, 2, 1, undefined]);
    expect(visiveis(fotos, '').map((f) => f.product)).toEqual([null]);
    expect(visiveis(fotos, 'todas')).toHaveLength(5);
  });

  it('o cartão: o produto, a orientação e o dia; o aviso de pequena para o Instagram; o nome para o leitor de tela', () => {
    const html = renderToStaticMarkup(createElement(CartaoFoto, { foto: foto({ narrow_for_instagram: true, width: 900, height: 900 }), agora: AGORA, aberta: false, aoAbrir: () => undefined, aoFalhar: () => undefined }));
    expect(html).toContain('Smash duplo');
    expect(html).toContain('quadrada · 18/10');
    expect(html).toContain('pequena para o Instagram');
    expect(html).toContain('aria-label="Foto: Smash duplo, quadrada, enviada em 18/10, pequena para o Instagram"');
    // A grade lê a miniatura (não a foto inteira), sem mandar a página de onde veio para o armazenamento.
    expect(html).toContain('src="https://imagens.exemplo/foto-mini.jpg?assinado"');
    expect(html.toLowerCase()).toContain('referrerpolicy="no-referrer"');
    expect(html).toContain('loading="lazy"');
    expect(rotuloDoCartao(foto({ product: null, orientation: 'horizontal', uploaded_at: local(21, 9, 0) }), AGORA)).toBe('Foto: Sem produto, horizontal, enviada hoje');
  });

  it('a gaveta: a nota do recorte, as medidas e quem enviou (sem a pessoa, só quando)', () => {
    expect(notaDoRecorte('alta')).toBe('Muito alta para o Instagram: lá, ela vai precisar de um recorte.');
    expect(notaDoRecorte('larga')).toBe('Muito larga para o Instagram: lá, ela vai precisar de um recorte.');
    expect(notaDoRecorte('nenhum')).toBeNull();
    expect(medidas(foto({ width: 1536, height: 2048, orientation: 'vertical' }))).toBe('1.536 × 2.048 px, vertical');
    expect(quemEnviou(foto(), AGORA)).toBe('por Ana, 18/10, 14:52');
    expect(quemEnviou(foto({ uploaded_by: null, uploaded_at: local(21, 9, 5) }), AGORA)).toBe('hoje, 09:05');
  });

  it('salvar manda só o que mudou; "Sem produto" é nulo; nada mudou = nada vai ao servidor', () => {
    const f = foto();
    expect(mudancas(f, 'Smash duplo', 'Smash duplo no balcão')).toBeNull();
    expect(mudancas(f, 'Smash duplo', '  Smash duplo no balcão  ')).toBeNull();
    expect(mudancas(f, '', 'Smash duplo no balcão')).toEqual({ product: null });
    expect(mudancas(f, 'Combo sexta', '')).toEqual({ product: 'Combo sexta', description: '' });
    expect(mudancas(foto({ product: null }), '', 'Na mesa')).toEqual({ description: 'Na mesa' });
  });

  it('os endereços de 5 minutos: perto do fim (menos de 30 s), a lista é lida de novo', () => {
    expect(enderecosVencendo(new Date(AGORA.getTime() + 300_000).toISOString(), AGORA)).toBe(false);
    expect(enderecosVencendo(new Date(AGORA.getTime() + 29_000).toISOString(), AGORA)).toBe(true);
    expect(enderecosVencendo(new Date(AGORA.getTime() - 1_000).toISOString(), AGORA)).toBe(true);
  });
});

describe('menu: "Fotos" logo abaixo de Minha marca, para quem tem fotos.ver, sem Lite/Pro', () => {
  const agencia = NAVEGACAO.find((g) => g.id === 'agencia')!;

  it('o item, a permissão, o título e o ícone (a câmera: a imagem já é de Criativos)', () => {
    const i = agencia.itens.findIndex((x) => x.href === '/fotos');
    expect(agencia.itens[i - 1]?.href).toBe('/marca');
    expect(agencia.itens[i]).toEqual({ href: '/fotos', rotulo: 'Fotos', icone: 'camera', permissao: 'fotos.ver' });
    expect(agencia.itens.find((x) => x.href === '/criativos')?.icone).toBe('image');
    expect(itensVisiveis(agencia, (p) => p !== 'fotos.ver', 'lite').map((x) => x.href)).not.toContain('/fotos');
    expect(tituloDa('/fotos')).toBe('Fotos');
    expect(temModos('/fotos', () => true)).toBe(false);
  });
});
