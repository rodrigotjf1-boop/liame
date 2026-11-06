import { describe, expect, it } from 'vitest';
import { naoTerminouDePreparar, pedeUmPostNovo } from '../src/actions/post-publicacao.js';
import {
  CODIGOS_DO_VIDEO_RECUSADO,
  cabeNoReelsDoInstagram,
  comoSaiNaPagina,
  enderecoDoEnvioNaPagina,
  idDoVideoNaPagina,
  situacaoDoVideoNaPagina,
  taxaDoVideo,
  videoJaNaPagina,
} from '../src/connectors/meta/publicacao.js';
import { type EstadoDoPost, midiaFora, novaTentativa, planoDeTentarDeNovo, planoDoPost } from '../src/posts/post-plano.js';

// A6 · Z10, parte 3a, sem banco: as regras do vídeo no post (D-A6-68 a D-A6-70; as especificações do Reels e o "Reels
// Publishing" da Meta, conferidos em 06/11/2026). O que cabe no Reels do Instagram como está; como o vídeo sai na Página;
// a situação do vídeo na Página; o id e o endereço do envio; o vídeo comum achado pela legenda; o estado do post (o de
// foto igual ao de antes; o vídeo apagado e a capa trocada não saem); e o "Tentar de novo" do vídeo que a Meta não
// terminou de preparar.

const AGORA = new Date('2026-11-06T15:00:00.000Z');
const canal = (c: 'instagram' | 'facebook', situacao: EstadoDoPost['canais'][number]['situacao'] = 'aguardando') => ({ canal: c, conta: `conta-${c}`, texto: `Texto ${c}`, situacao });
const estado = (o: Partial<EstadoDoPost> = {}): EstadoDoPost => ({
  post: 'p1',
  foto: null,
  recorte: null,
  hora: AGORA.toISOString(),
  hora_local: '12:00',
  canais: [canal('instagram'), canal('facebook')],
  ...o,
});

describe('o vídeo no Reels e na Página (A6 · Z10, parte 3a)', () => {
  it('o Reels do Instagram: até 1.920 px de largura e 25 Mbps, como está', () => {
    // 1080 × 1920 em 24 s com 18 MB: 6 Mbps.
    expect(taxaDoVideo(18_000_000, 24_000)).toBe(6_000_000);
    expect(cabeNoReelsDoInstagram(1080, 18_000_000, 24_000)).toBe(true);
    // O deitado de 1.920 cabe (a largura é a das colunas); o 4K em pé (2.160 de largura) não.
    expect(cabeNoReelsDoInstagram(1920, 18_000_000, 24_000)).toBe(true);
    expect(cabeNoReelsDoInstagram(2160, 18_000_000, 24_000)).toBe(false);
    // 25 Mbps cabe; um bit a mais por segundo, não; sem duração, não.
    expect(cabeNoReelsDoInstagram(1080, 75_000_000, 24_000)).toBe(true);
    expect(cabeNoReelsDoInstagram(1080, 75_000_004, 24_000)).toBe(false);
    expect(cabeNoReelsDoInstagram(1080, 18_000_000, 0)).toBe(false);
  });

  it('a Página: em pé a partir de 540 × 960, Reels; deitado ou menor, vídeo comum (o quadrado grande é Reels)', () => {
    expect(comoSaiNaPagina(1080, 1920)).toBe('reels');
    expect(comoSaiNaPagina(540, 960)).toBe('reels');
    expect(comoSaiNaPagina(1080, 1080)).toBe('reels');
    expect(comoSaiNaPagina(1920, 1080)).toBe('video');
    expect(comoSaiNaPagina(1052, 764)).toBe('video');
    expect(comoSaiNaPagina(480, 854)).toBe('video');
  });

  it('a situação do vídeo na Página: publicado só com a palavra da Meta; erro em qualquer fase; vencido; o resto prepara', () => {
    expect(situacaoDoVideoNaPagina({ status: { video_status: 'ready', publishing_phase: { status: 'complete', publish_status: 'published' } } })).toBe('publicado');
    expect(situacaoDoVideoNaPagina({ status: { video_status: 'ready', publishing_phase: { status: 'in_progress', publish_status: 'draft' } } })).toBe('processando');
    expect(situacaoDoVideoNaPagina({ status: { video_status: 'processing', processing_phase: { status: 'in_progress' } } })).toBe('processando');
    expect(situacaoDoVideoNaPagina({ status: { video_status: 'upload_failed' } })).toBe('erro');
    expect(situacaoDoVideoNaPagina({ status: { video_status: 'ready', processing_phase: { status: 'error' } } })).toBe('erro');
    expect(situacaoDoVideoNaPagina({ status: { video_status: 'ready', publishing_phase: { publish_status: 'error' } } })).toBe('erro');
    expect(situacaoDoVideoNaPagina({ status: { video_status: 'expired' } })).toBe('vencido');
    expect(situacaoDoVideoNaPagina({ status: {} })).toBe('desconhecida');
    expect(situacaoDoVideoNaPagina(null)).toBe('desconhecida');
  });

  it('o id do vídeo, o endereço do envio (só o da Meta, para este vídeo) e os códigos de recusa', () => {
    expect(idDoVideoNaPagina({ video_id: '1234567890', upload_url: 'x' })).toBe('1234567890');
    expect(idDoVideoNaPagina({ id: '987' })).toBe('987');
    expect(idDoVideoNaPagina({ video_id: '12a' })).toBeNull();
    const base = 'https://rupload.facebook.com';
    expect(enderecoDoEnvioNaPagina(`${base}/video-upload/v26.0/555`, base, '555')).toBe(`${base}/video-upload/v26.0/555`);
    expect(enderecoDoEnvioNaPagina(`${base}/video-upload/555`, base, '555')).toBe(`${base}/video-upload/555`);
    // Outro host, outro vídeo ou um caminho estranho: o endereço montado pela base conhecida.
    expect(enderecoDoEnvioNaPagina('https://exemplo.com/video-upload/555', base, '555')).toBe(`${base}/video-upload/555`);
    expect(enderecoDoEnvioNaPagina(`${base}/video-upload/v26.0/556`, base, '555')).toBe(`${base}/video-upload/555`);
    expect(enderecoDoEnvioNaPagina(`${base}/video-upload/../x/555`, base, '555')).toBe(`${base}/video-upload/555`);
    expect(enderecoDoEnvioNaPagina(undefined, base, '555')).toBe(`${base}/video-upload/555`);
    expect([...CODIGOS_DO_VIDEO_RECUSADO].sort()).toEqual(['1363040', '1363127', '1363128', '1363129']);
  });

  it('o vídeo comum achado pela legenda, desde a criação do post', () => {
    const desde = new Date('2026-11-06T14:00:00.000Z');
    const lista = {
      data: [
        { id: '111', description: 'Outro vídeo', created_time: '2026-11-06T14:30:00+0000' },
        { id: '222', description: 'O smash  \r\n', created_time: '2026-11-06T14:00:00+0000' },
        { id: '333', description: 'O smash', created_time: '2026-11-06T13:59:00+0000' },
      ],
    };
    expect(videoJaNaPagina(lista, 'O smash', desde)).toBe('222');
    expect(videoJaNaPagina(lista, 'Nenhum', desde)).toBeNull();
    expect(videoJaNaPagina({ data: [{ id: '333', description: 'O smash', created_time: '2026-11-06T13:59:00+0000' }] }, 'O smash', desde)).toBeNull();
    // ERR-206: o vídeo que outro canal do Liame já guardou não é deste post.
    expect(videoJaNaPagina(lista, 'O smash', desde, new Set(['222']))).toBeNull();
  });
});

describe('o estado do post com vídeo e o "Tentar de novo" (A6 · Z10, parte 3a)', () => {
  it('o post de foto: o estado sem a chave do vídeo publica como antes; sem a foto, não', () => {
    const deFoto = estado({ foto: { id: 'f1', sha256: 'a'.repeat(64) } });
    expect('video' in deFoto).toBe(false);
    const plano = planoDoPost(deFoto);
    expect(plano.ok).toBe(true);
    if (plano.ok) expect('video' in plano.desejado).toBe(false);
    expect(midiaFora(estado())).toContain('A foto deste post foi apagada');
  });

  it('o post com vídeo: sai com o vídeo e a capa presa; o vídeo apagado e a capa trocada não saem', () => {
    expect(planoDoPost(estado({ video: { id: 'v1', capa: 'capa:1' } })).ok).toBe(true);
    expect(planoDoPost(estado({ video: { id: 'v1', capa: 'meio' } })).ok).toBe(true);
    expect(midiaFora(estado({ video: null }))).toContain('O vídeo deste post foi apagado');
    expect(midiaFora(estado({ video: { id: 'v1', capa: null } }))).toContain('A capa do vídeo mudou depois da aprovação');
    const recusado = planoDoPost(estado({ video: { id: 'v1', capa: null } }));
    expect(recusado.ok).toBe(false);
  });

  it('"Tentar de novo": o vídeo que a Meta não terminou de preparar tenta nos canais que faltam, mesmo sem nenhum no ar', () => {
    const tentado = new Date(AGORA.getTime() - 10 * 60_000);
    const semPreparo = { situacao: 'falhou', publicadoEm: null, pedePostNovo: false, semPreparo: true, tentadoEm: tentado };
    const r = novaTentativa('falhou', [{ canal: 'instagram', ...semPreparo }, { canal: 'facebook', ...semPreparo }], AGORA);
    expect(r).toEqual({ ok: true, canal: 'instagram', canais: ['instagram', 'facebook'], ate: new Date(tentado.getTime() + 24 * 3_600_000) });
    // Um parou no preparo e o outro pede um post novo: não.
    expect(novaTentativa('falhou', [{ canal: 'instagram', ...semPreparo }, { canal: 'facebook', ...semPreparo, semPreparo: false, pedePostNovo: true }], AGORA)).toEqual({ ok: false, motivo: 'nao_saiu_em_nenhum' });
    // Passou um dia da tentativa: não.
    const velho = new Date(AGORA.getTime() - 25 * 3_600_000);
    expect(novaTentativa('falhou', [{ canal: 'instagram', ...semPreparo, tentadoEm: velho }], AGORA)).toEqual({ ok: false, motivo: 'passou_o_prazo' });
    // O post de foto que não saiu em nenhum segue sem "Tentar de novo".
    expect(novaTentativa('falhou', [{ canal: 'instagram', situacao: 'falhou', publicadoEm: null, pedePostNovo: false }], AGORA)).toEqual({ ok: false, motivo: 'nao_saiu_em_nenhum' });
    // O de sempre (um no ar, um que falta) devolve o canal também na lista.
    const saiu = new Date(AGORA.getTime() - 60 * 60_000);
    expect(
      novaTentativa(
        'falhou',
        [
          { canal: 'instagram', situacao: 'publicado', publicadoEm: saiu, pedePostNovo: false },
          { canal: 'facebook', situacao: 'falhou', publicadoEm: null, pedePostNovo: false },
        ],
        AGORA,
      ),
    ).toEqual({ ok: true, canal: 'facebook', canais: ['facebook'], ate: new Date(saiu.getTime() + 24 * 3_600_000) });
  });

  it('o plano da nova tentativa do vídeo leva os dois canais de volta; o de foto, só um que falta', () => {
    const doVideo = planoDeTentarDeNovo(estado({ video: { id: 'v1', capa: 'meio' } }));
    expect(doVideo.ok).toBe(true);
    if (doVideo.ok) expect(doVideo.desejado.canais.map((c) => c.situacao)).toEqual(['publicado', 'publicado']);
    expect(planoDeTentarDeNovo(estado({ foto: { id: 'f1', sha256: 'a'.repeat(64) } })).ok).toBe(false);
  });

  it('as frases do vídeo: a recusa e o arquivo que sumiu pedem um post novo; o preparo que não terminou, não', () => {
    const recusa = 'O Instagram não aceitou o vídeo deste post. O post não saiu no Instagram. Faça um post novo com outro vídeo.';
    expect(pedeUmPostNovo(recusa)).toBe(true);
    expect(pedeUmPostNovo('O arquivo do vídeo deste post não está mais guardado no Liame. O post não saiu na Página do Facebook. Faça um post novo.')).toBe(true);
    const preparo = 'A Meta não terminou de preparar o vídeo em 5 minutos. O post não saiu no Instagram. Use "Tentar de novo".';
    expect(naoTerminouDePreparar(preparo)).toBe(true);
    expect(pedeUmPostNovo(preparo)).toBe(false);
    expect(naoTerminouDePreparar(null)).toBe(false);
    expect(naoTerminouDePreparar(recusa)).toBe(false);
  });
});
