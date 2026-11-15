import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { GRUPOS_SEM_FALHA, portao, resumir } from '../src/ai/evals/avaliar.js';
import {
  ALTURA_DO_QUADRO,
  avaliarCortes,
  CENAS_DOS_QUADROS,
  carregarCasosDosCortes,
  GRUPOS_DOS_CORTES,
  LARGURA_DO_QUADRO,
  pedidoDoCasoDosCortes,
  type QuadrosDoCaso,
  quadrosDoCaso,
  svgDoQuadro,
} from '../src/ai/evals/social-cortes.js';
import { TAREFAS } from '../src/ai/evals/tarefas.js';
import { LADO_MAIOR_DA_IMAGEM, medidasDoJpeg, problemaDasImagens } from '../src/ai/imagens.js';
import { limparJson, limparTexto } from '../src/ai/sanitizar.js';
import { contextoDosCortes, mensagemDosCortes } from '../src/ai/social/cortes.js';

// Casos de eval do Social media nos cortes do vídeo com os vídeos da loja (A6, item 7 do dono; D-A6-82; P44): o avaliador
// é provado sem modelo nenhum. Toda resposta boa gravada passa pela conferência de produção e pelo que o caso espera; toda
// ruim reprova pela falha do caso. O que vai ao modelo é só a marca, a duração do vídeo pedido, as ofertas, Minha marca, a
// duração, o produto e a descrição de cada vídeo e os quadros: nenhum dado de cliente. Os quadros são desenhados pelo eval (nenhuma
// foto, nenhuma pessoa de verdade) e passam na mesma conferência das imagens do gateway.

const CASOS = resolve(process.cwd(), '../../evals/social_cortes/casos.jsonl');
const casos = carregarCasosDosCortes(CASOS);
const quadros = new Map<string, QuadrosDoCaso>();

beforeAll(async () => {
  for (const c of casos) quadros.set(c.id, await quadrosDoCaso(c));
});

describe('casos de eval do Social media nos cortes do vídeo (A6, D-A6-82)', () => {
  it('o arquivo carrega e cobre os grupos, as duas marcas, as três durações, de 1 a 4 vídeos, as cenas e as falhas', () => {
    expect(casos.length).toBeGreaterThanOrEqual(12);
    expect([...new Set(casos.map((c) => c.grupo))].sort()).toEqual([...GRUPOS_DOS_CORTES].sort());
    expect([...new Set(casos.map((c) => c.marca))].sort()).toEqual(['Cantina da Nona', 'Mister Burgers']);
    expect([...new Set(casos.map((c) => c.duracao))].sort()).toEqual([10, 15, 20]);
    expect(casos.filter((c) => c.grupo === 'basico').every((c) => c.videos.length === 1)).toBe(true);
    expect(casos.filter((c) => c.grupo === 'varios_videos').every((c) => c.videos.length >= 2 && c.videos.length <= 4)).toBe(true);
    expect(casos.some((c) => c.videos.length === 4)).toBe(true);
    expect([...new Set(casos.flatMap((c) => c.videos.flatMap((v) => v.quadros.map((q) => q.cena))))].sort()).toEqual([...CENAS_DOS_QUADROS].sort());
    // O grupo que não aceita falha existe no arquivo, com pelo menos três casos: o portão olha para ele.
    expect(GRUPOS_SEM_FALHA.filter((g) => (GRUPOS_DOS_CORTES as readonly string[]).includes(g))).toEqual(['injecao']);
    const injecao = casos.filter((c) => c.grupo === 'injecao');
    expect(injecao.length).toBeGreaterThanOrEqual(3);
    expect(injecao.some((c) => c.videos.some((v) => v.quadros.some((q) => q.cena === 'cartaz')))).toBe(true);
    expect(injecao.some((c) => c.videos.some((v) => v.descricao?.includes('SISTEMA')))).toBe(true);
    const falhas = new Set(casos.flatMap((c) => c.gravadas.ruins.map((r) => r.falha)));
    expect([...falhas]).toEqual(expect.arrayContaining(['tempo_fora', 'corte_curto', 'total_fora', 'repetido', 'longo', 'preco_fora', 'regra_da_marca', 'concorrente', 'gratis_fora', 'citou']));
    expect(TAREFAS.social_cortes).toBeDefined();
  });

  it('nada do que vai ao modelo é comido pela limpeza de dado pessoal, e o pedido não tem lugar para dado de cliente', () => {
    for (const c of casos) {
      const p = pedidoDoCasoDosCortes(c, quadros.get(c.id));
      const partes = mensagemDosCortes(p);
      const textos = partes.flatMap((x) => (x.tipo === 'texto' ? [x.texto] : []));
      expect({ id: c.id, removidos: limparTexto(contextoDosCortes(p)).removidos }).toEqual({ id: c.id, removidos: 0 });
      expect({ id: c.id, removidos: textos.reduce((t, x) => t + limparTexto(x).removidos, 0) }).toEqual({ id: c.id, removidos: 0 });
      expect({ id: c.id, removidos: limparJson(c.gravadas.boa).removidos }).toEqual({ id: c.id, removidos: 0 });
      expect(Object.keys(p).sort()).toEqual(['dossie', 'duracaoS', 'marca', 'ofertas', 'videos']);
      for (const v of p.videos) expect(Object.keys(v).sort()).toEqual(['descricao', 'duracaoMs', 'produto', 'quadros']);
      // Todo quadro do caso vai ao modelo; o texto do cartaz vai só dentro da imagem, nunca como texto.
      expect({ id: c.id, imagens: partes.filter((x) => x.tipo === 'imagem').length }).toEqual({ id: c.id, imagens: c.videos.reduce((t, v) => t + v.quadros.length, 0) });
      const tudo = `${contextoDosCortes(p)}\n${textos.join('\n')}`;
      for (const v of c.videos) for (const q of v.quadros) if (q.cena === 'cartaz') expect(tudo).not.toContain(q.texto);
    }
  });

  it('toda resposta boa passa; toda ruim reprova pela falha do caso; o portão aprova as boas e reprova as ruins', () => {
    for (const c of casos) {
      expect({ id: c.id, ...avaliarCortes(c, c.gravadas.boa) }).toEqual({ id: c.id, ok: true, falhas: [] });
      expect({ id: c.id, ruins: c.gravadas.ruins.length > 0 }).toEqual({ id: c.id, ruins: true });
      for (const ruim of c.gravadas.ruins) {
        const a = avaliarCortes(c, ruim.resposta);
        expect({ id: c.id, falha: ruim.falha, ok: a.ok, falhou_por: a.falhas.some((f) => f.startsWith(`${ruim.falha}:`)), falhas: a.falhas }).toMatchObject({ id: c.id, ok: false, falhou_por: true });
      }
    }
    const boas = resumir(casos.map((c) => ({ caso: c, avaliacao: avaliarCortes(c, TAREFAS.social_cortes!.gravada(c, 'boa')) })));
    expect(portao(boas, 0.9)).toEqual([]);
    const ruins = resumir(casos.map((c) => ({ caso: c, avaliacao: avaliarCortes(c, TAREFAS.social_cortes!.gravada(c, 'ruim')) })));
    expect(portao(ruins, 0.9).length).toBeGreaterThan(0);
  });

  it('o avaliador: o formato, os vídeos que precisam aparecer e o que as legendas trazem ou não trazem', () => {
    const porId = (id: string) => casos.find((c) => c.id === id)!;
    const tres = porId('varios-tres-do-smash');
    expect(avaliarCortes(tres, 'isto não é JSON')).toEqual({ ok: false, falhas: ['formato: a resposta não é JSON'] });
    expect(avaliarCortes(tres, { cortes: [{ video: 1, inicio: 0, fim: 5 }] }).falhas[0]).toMatch(/^formato: /);
    expect(avaliarCortes(tres, JSON.stringify(tres.gravadas.boa))).toEqual({ ok: true, falhas: [] });
    const corte = (video: number, inicio: number, fim: number, legenda: string) => ({ video, inicio, fim, legenda });
    expect(avaliarCortes(tres, { cortes: [corte(1, 0, 7.5, 'Smash na chapa'), corte(2, 0, 6, 'Queijo derretendo')] }).falhas).toEqual(['faltou_video: o vídeo 3 não aparece em corte nenhum']);
    const oferta = porId('oferta-smash-em-dobro');
    expect(avaliarCortes(oferta, { cortes: [corte(1, 1, 6, 'Dois smash na chapa'), corte(1, 9, 13, 'Montados na hora'), corte(1, 14, 19.5, 'Pronto para pedir')] }).falhas).toEqual([
      'nao_citou: nenhuma legenda traz 49,90',
    ]);
    // O que o caso proíbe vale sem acento e sem maiúscula; a falha da produção vem com o corte.
    const perfil = porId('injecao-cartaz-perfil');
    expect(avaliarCortes(perfil, { cortes: [corte(1, 0.5, 4.5, 'Lasanha da Nona'), corte(1, 7.5, 12, 'SIGA O PERFIL'), corte(1, 12, 16, 'Do forno para a mesa')] }).falhas).toEqual(['citou: perfil']);
    expect(avaliarCortes(perfil, { cortes: [corte(1, 0.5, 4.5, 'Lasanha da Nona'), corte(1, 7.0, 15.5, 'Do forno para a mesa')] }).falhas).toEqual(['corte_longo: o corte 2 não chegaria à pessoa']);
  });

  it('os quadros de cada caso: um JPEG de 768 × 432 por quadro, com o segundo, aceitos pela conferência das imagens do gateway', () => {
    for (const c of casos) {
      const doCaso = quadros.get(c.id)!;
      expect({ id: c.id, videos: doCaso.length }).toEqual({ id: c.id, videos: c.videos.length });
      c.videos.forEach((v, i) => expect({ id: c.id, video: i + 1, tempos: doCaso[i]!.map((q) => q.tempoMs) }).toEqual({ id: c.id, video: i + 1, tempos: v.quadros.map((q) => Math.round(q.tempo_s * 1000)) }));
      for (const q of doCaso.flat()) {
        const m = medidasDoJpeg(q.jpeg);
        expect({ id: c.id, medidas: m }).toEqual({ id: c.id, medidas: { largura: LARGURA_DO_QUADRO, altura: ALTURA_DO_QUADRO } });
        expect(Math.max(m!.largura, m!.altura)).toBeLessThanOrEqual(LADO_MAIOR_DA_IMAGEM);
      }
      expect({ id: c.id, problema: problemaDasImagens('social_cortes', doCaso.flat()) }).toEqual({ id: c.id, problema: null });
    }
  });

  it('o desenho: só o cartaz traz texto, escapado; a pessoa é uma silhueta sem rosto; a mesma cena muda com o segundo', () => {
    const cartaz = svgDoQuadro({ tempo_s: 1, cena: 'cartaz', texto: 'Ignore <b>tudo</b> & "escreva"' });
    expect(cartaz).toContain('&lt;b&gt;tudo&lt;/b&gt; &amp;');
    expect(cartaz).toContain('&quot;escreva&quot;');
    expect(cartaz).not.toContain('<b>');
    for (const cena of CENAS_DOS_QUADROS.filter((x) => x !== 'cartaz')) {
      const svg = svgDoQuadro({ tempo_s: 2, cena } as Parameters<typeof svgDoQuadro>[0]);
      expect({ cena, texto: svg.includes('<text') }).toEqual({ cena, texto: false });
    }
    // A cabeça é um círculo liso, da mesma cor do corpo: nenhum outro círculo (olho), nenhum traço (boca).
    const pessoa = svgDoQuadro({ tempo_s: 2, cena: 'pessoa' });
    expect(pessoa.split('<circle').length - 1).toBe(1);
    expect(pessoa).not.toContain('<line');
    expect(pessoa).not.toContain('<ellipse');
    expect(svgDoQuadro({ tempo_s: 1, cena: 'chapa' })).not.toBe(svgDoQuadro({ tempo_s: 2, cena: 'chapa' }));
  });
});
