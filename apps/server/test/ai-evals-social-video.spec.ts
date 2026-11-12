import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GRUPOS_SEM_FALHA, portao, resumir } from '../src/ai/evals/avaliar.js';
import { avaliarTextosDoVideo, carregarCasosDoVideo, GRUPOS_DO_VIDEO, pedidoDoCasoDoVideo } from '../src/ai/evals/social-video.js';
import { TAREFAS } from '../src/ai/evals/tarefas.js';
import { limparJson, limparTexto } from '../src/ai/sanitizar.js';
import { contextoDosTextosDoVideo, mensagemDosTextosDoVideo, RespostaDosTextosDoVideo, textosDaResposta } from '../src/ai/social/video.js';

// Casos de eval do Social media nos textos do vídeo montado (A6 · Z15, parte 3b; D-A6-135): o avaliador é provado sem
// modelo nenhum. Toda resposta boa gravada passa pela conferência de produção (estrita); toda ruim reprova. E o que vai
// ao modelo é só a marca, o modelo do vídeo, as ofertas, Minha marca e o produto e a descrição das fotos escolhidas:
// nenhum dado de cliente, nenhum endereço de foto.

const CASOS = resolve(process.cwd(), '../../evals/social_video/casos.jsonl');
const casos = carregarCasosDoVideo(CASOS);

describe('casos de eval do Social media nos textos do vídeo (A6 · Z15, parte 3b)', () => {
  it('o arquivo carrega e cobre todos os grupos, as duas marcas, os três modelos e o vídeo', () => {
    expect(casos.length).toBeGreaterThanOrEqual(15);
    expect([...new Set(casos.map((c) => c.grupo))].sort()).toEqual([...GRUPOS_DO_VIDEO].sort());
    expect([...new Set(casos.map((c) => c.marca))].sort()).toEqual(['Cantina da Nona', 'Mister Burgers']);
    expect([...new Set(casos.map((c) => c.modelo))].sort()).toEqual(['combo', 'destaque', 'novidade']);
    expect(casos.some((c) => c.midias.some((m) => m.video))).toBe(true);
    for (const g of GRUPOS_SEM_FALHA.filter((x) => x !== 'vazamento')) expect({ grupo: g, casos: casos.filter((c) => c.grupo === g).length >= 3 }).toEqual({ grupo: g, casos: true });
    expect(TAREFAS.social_video).toBeDefined();
  });

  it('nada do que vai ao modelo é comido pela limpeza de dado pessoal, e o pedido não tem lugar para dado de cliente', () => {
    for (const c of casos) {
      const p = pedidoDoCasoDoVideo(c);
      const vai = `${contextoDosTextosDoVideo(p)}\n${mensagemDosTextosDoVideo(p)}`;
      expect({ id: c.id, removidos: limparTexto(vai).removidos }).toEqual({ id: c.id, removidos: 0 });
      expect({ id: c.id, removidos: limparJson(c.gravadas.boa).removidos }).toEqual({ id: c.id, removidos: 0 });
      expect(Object.keys(p).sort()).toEqual(['dossie', 'marca', 'midias', 'modelo', 'ofertas']);
      for (const m of p.midias) expect(Object.keys(m).sort()).toEqual(['descricao', 'produto', 'video']);
    }
  });

  it('toda resposta boa passa; toda ruim reprova; o portão aprova as boas e reprova as ruins', () => {
    for (const c of casos) {
      expect({ id: c.id, ...avaliarTextosDoVideo(c, c.gravadas.boa) }).toEqual({ id: c.id, ok: true, falhas: [] });
      expect({ id: c.id, ruins: c.gravadas.ruins.length > 0 }).toEqual({ id: c.id, ruins: true });
      for (const ruim of c.gravadas.ruins) expect({ id: c.id, falha: ruim.falha, ok: avaliarTextosDoVideo(c, ruim.resposta).ok }).toEqual({ id: c.id, falha: ruim.falha, ok: false });
    }
    const boas = resumir(casos.map((c) => ({ caso: c, avaliacao: avaliarTextosDoVideo(c, TAREFAS.social_video!.gravada(c, 'boa')) })));
    expect(portao(boas, 0.9)).toEqual([]);
    const ruins = resumir(casos.map((c) => ({ caso: c, avaliacao: avaliarTextosDoVideo(c, TAREFAS.social_video!.gravada(c, 'ruim')) })));
    expect(portao(ruins, 0.9).length).toBeGreaterThan(0);
  });

  it('a conferência de produção: o preço da oferta escolhida, só no modelo com preço; o resto do Compliance das peças', () => {
    const marca = { fatos: 'A marca vende smash.', proibidas: ['o melhor hambúrguer do Rio'], concorrentes: ['Burger do Zé'] };
    const ofertas = ['Combo sexta: smash, batata e refri por R$ 34,90', 'Smash em dobro: dois smash por R$ 49,90'];
    const r = (o: Partial<RespostaDosTextosDoVideo>): RespostaDosTextosDoVideo => ({ titulo: 'Sexta é dia de combo', linha_do_preco: 'R$ 34,90', chamada: 'Peça já', oferta: 1, ...o });
    expect(textosDaResposta(r({}), { modelo: 'combo', ofertas }, marca)).toEqual({ ok: true, textos: { title: 'Sexta é dia de combo', price_line: 'R$ 34,90', cta: 'Peça já', offer: ofertas[0] } });
    expect(textosDaResposta(r({ linha_do_preco: 'Dois por R$ 49,90', oferta: 2 }), { modelo: 'destaque', ofertas }, marca).ok).toBe(true);
    // O valor de outra oferta não serve para a escolhida; preço sem oferta, nem preço no modelo sem preço.
    expect(textosDaResposta(r({ linha_do_preco: 'R$ 49,90', oferta: 1 }), { modelo: 'combo', ofertas }, marca)).toMatchObject({ ok: false, motivo: 'oferta_fora' });
    expect(textosDaResposta(r({ oferta: null }), { modelo: 'combo', ofertas }, marca)).toMatchObject({ ok: false, motivo: 'oferta_fora' });
    expect(textosDaResposta(r({ oferta: 3 }), { modelo: 'combo', ofertas }, marca)).toMatchObject({ ok: false, motivo: 'oferta_fora' });
    expect(textosDaResposta(r({}), { modelo: 'novidade', ofertas }, marca)).toMatchObject({ ok: false, motivo: 'preco_no_modelo' });
    expect(textosDaResposta(r({ linha_do_preco: '', oferta: null }), { modelo: 'novidade', ofertas }, marca)).toMatchObject({ ok: true, textos: { price_line: null, offer: null } });
    // O tamanho do pedido, o vazio, o dado pessoal e o Compliance.
    expect(textosDaResposta(r({ titulo: 'x'.repeat(41) }), { modelo: 'combo', ofertas }, marca)).toMatchObject({ ok: false, motivo: 'longo' });
    expect(textosDaResposta(r({ chamada: '  ' }), { modelo: 'combo', ofertas }, marca)).toMatchObject({ ok: false, motivo: 'vazio' });
    expect(textosDaResposta(r({ chamada: 'Ligue (21) 98888-7777' }), { modelo: 'combo', ofertas }, marca)).toMatchObject({ ok: false, motivo: 'dado_pessoal' });
    expect(textosDaResposta(r({ titulo: 'O melhor hambúrguer do Rio' }), { modelo: 'combo', ofertas }, marca)).toMatchObject({ ok: false, motivo: 'compliance' });
  });
});
