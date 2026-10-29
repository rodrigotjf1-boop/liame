import { describe, expect, it } from 'vitest';
import {
  dentroDaJanela,
  type EstadoDoPost,
  horaLocal,
  planoDoPost,
  postDoRecurso,
  quandoSai,
  recursoDoPost,
  situacaoDoPost,
} from '../src/posts/post-plano.js';

// A6 · Z5b, sem rede e sem banco: as regras do post no trilho (`posts/post-plano.ts`): o recurso, o plano de publicar,
// a janela das 8h às 22h, a hora em que o pedido aprovado sai e a situação que a Agenda mostra.

const SP = 'America/Sao_Paulo';
const ID = '01a1b2c3-0000-7000-8000-000000000001';
const base: EstadoDoPost = {
  post: ID,
  foto: { id: '01a1b2c3-0000-7000-8000-000000000002', sha256: 'a'.repeat(64) },
  recorte: null,
  hora: '2026-10-30T22:00:00.000Z',
  hora_local: '19:00',
  canais: [
    { canal: 'instagram', conta: '01a1b2c3-0000-7000-8000-000000000003', texto: 'Smash duplo hoje. Peça pelo link da bio.', situacao: 'aguardando' },
    { canal: 'facebook', conta: '01a1b2c3-0000-7000-8000-000000000004', texto: 'Smash duplo hoje: liame.link/abc', situacao: 'aguardando' },
  ],
};

describe('o post no trilho: as regras puras (A6 · Z5b)', () => {
  it('o recurso: `post:<id>` e de volta; o que não é um post, nulo', () => {
    expect(recursoDoPost(ID)).toBe(`post:${ID}`);
    expect(postDoRecurso(`post:${ID.toUpperCase()}`)).toBe(ID);
    expect(postDoRecurso(`avaliacao:${ID}`)).toBeNull();
    expect(postDoRecurso('post:../x')).toBeNull();
  });

  it('o plano de publicar: o mesmo post, cada canal publicado, e o texto dos canais juntos (para as palavras proibidas)', () => {
    const p = planoDoPost(base);
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.desejado.canais.map((c) => c.situacao)).toEqual(['publicado', 'publicado']);
    expect(p.desejado.foto).toEqual(base.foto);
    expect(p.texto).toBe(`${base.canais[0]!.texto}\n\n${base.canais[1]!.texto}`);
  });

  it('o plano recusa: a foto apagada, o canal que já saiu, a conta desligada, o texto vazio ou longo, a hora fora da janela, o que não é post', () => {
    const motivo = (e: unknown) => {
      const p = planoDoPost(e);
      return p.ok ? null : p.motivo;
    };
    expect(motivo({ ...base, foto: null })).toContain('A foto deste post foi apagada');
    expect(motivo({ ...base, canais: [{ ...base.canais[0]!, situacao: 'publicado' }] })).toContain('já saiu');
    expect(motivo({ ...base, canais: [{ ...base.canais[0]!, conta: null }] })).toBe('A conta do Instagram deste post não está conectada à marca agora: o post não sai no Instagram. Confira em Contas conectadas.');
    expect(motivo({ ...base, canais: [{ ...base.canais[1]!, conta: null }] })).toBe(
      'A conta da Página do Facebook deste post não está conectada à marca agora: o post não sai na Página do Facebook. Confira em Contas conectadas.',
    );
    expect(motivo({ ...base, canais: [{ ...base.canais[0]!, texto: '   ' }] })).toBe('O texto no Instagram está vazio.');
    expect(motivo({ ...base, canais: [{ ...base.canais[0]!, texto: 'a'.repeat(2201) }] })).toBe('O texto no Instagram passa de 2.200 caracteres.');
    expect(motivo({ ...base, canais: [{ ...base.canais[0]!, texto: 'a'.repeat(2200) }] })).toBeNull();
    expect(motivo({ ...base, hora_local: '22:01' })).toBe('O post sai entre 8h e 22h. Escolha outra hora.');
    expect(motivo({ ...base, hora_local: '07:59' })).toBe('O post sai entre 8h e 22h. Escolha outra hora.');
    expect(motivo({ situacao: 'rascunho' })).toBe('Esta ferramenta é para um post do Liame.');
  });

  it('a janela das 8h às 22h, as duas pontas dentro; o que não é hora, fora', () => {
    for (const h of ['08:00', '12:30', '22:00']) expect(dentroDaJanela(h), h).toBe(true);
    for (const h of ['07:59', '22:01', '00:00', '23:59', '8:00', '24:00', '12:60', 'xx:yy']) expect(dentroDaJanela(h), h).toBe(false);
  });

  it('a hora local no fuso da empresa', () => {
    expect(horaLocal(new Date('2026-10-30T22:00:00Z'), SP)).toBe('19:00');
    expect(horaLocal(new Date('2026-10-31T02:59:00Z'), SP)).toBe('23:59');
    expect(horaLocal(new Date('2026-10-30T22:00:00Z'), 'UTC')).toBe('22:00');
  });

  it('quando o pedido aprovado sai: na hora marcada; aprovado depois, na hora; nunca fora das 8h às 22h (D-A6-8)', () => {
    const aprovacao = new Date('2026-10-30T15:00:00Z'); // 12h00 em São Paulo
    // Marcado para as 19h: sai às 19h.
    expect(quandoSai('2026-10-30T22:00:00.000Z', aprovacao, SP)?.toISOString()).toBe('2026-10-30T22:00:00.000Z');
    // A hora já passou (o post esperou a aprovação): sai na hora da aprovação, no minuto cheio.
    expect(quandoSai('2026-10-30T13:00:00.000Z', new Date('2026-10-30T15:00:42Z'), SP)?.toISOString()).toBe('2026-10-30T15:00:00.000Z');
    // Aprovado às 23h30, depois da hora: espera as 8h do dia seguinte.
    expect(quandoSai('2026-10-30T22:00:00.000Z', new Date('2026-10-31T02:30:00Z'), SP)?.toISOString()).toBe('2026-10-31T11:00:00.000Z');
    // Aprovado de madrugada (3h): espera as 8h do mesmo dia.
    expect(quandoSai('2026-10-30T22:00:00.000Z', new Date('2026-10-31T06:00:00Z'), SP)?.toISOString()).toBe('2026-10-31T11:00:00.000Z');
    // As pontas: 22h00 sai na hora; 8h00 também.
    expect(quandoSai('2026-10-30T22:00:00.000Z', new Date('2026-10-31T01:00:00Z'), SP)?.toISOString()).toBe('2026-10-31T01:00:00.000Z');
    expect(quandoSai('2026-10-31T11:00:00.000Z', aprovacao, SP)?.toISOString()).toBe('2026-10-31T11:00:00.000Z');
    expect(quandoSai('não é hora', aprovacao, SP)).toBeNull();
  });

  it('a situação que a Agenda mostra, pelo pedido e pelos canais', () => {
    const P = 'recusada por ';
    const s = (status: string, canais: string[], motivo: string | null = null) => situacaoDoPost({ status, status_reason: motivo }, canais, P);
    expect(situacaoDoPost(null, ['aguardando'], P)).toBe('esperando_aprovacao');
    expect(s('aguardando_aprovacao', ['aguardando', 'aguardando'])).toBe('esperando_aprovacao');
    expect(s('aprovada', ['aguardando', 'aguardando'])).toBe('agendado');
    expect(s('aprovada', ['publicado', 'aguardando'])).toBe('publicando');
    expect(s('executando', ['aguardando'])).toBe('publicando');
    expect(s('executada', ['publicado', 'publicado'])).toBe('publicado');
    expect(s('executada', ['publicado', 'falhou'])).toBe('em_parte');
    expect(s('falhou', ['falhou', 'aguardando'])).toBe('nao_saiu');
    expect(s('cancelada', ['aguardando'], 'cancelada por quem opera')).toBe('cancelado');
    expect(s('cancelada', ['aguardando'], 'recusada por Rodrigo: não é a foto')).toBe('recusado');
    expect(s('expirada', ['aguardando'])).toBe('expirado');
  });
});
