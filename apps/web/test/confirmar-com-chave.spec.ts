import { createElement, createRef } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ApagarDasRedes } from '@/components/agenda/apagar-das-redes';
import { BarraDaDecisao } from '@/components/aprovacoes/barra-da-decisao';
import { MudarAHora } from '@/components/aprovacoes/mudar-a-hora';
import { erroDaHoraNova } from '@/components/aprovacoes/post-textos';
import { formasDeConfirmar } from '@/lib/chave-de-acesso';

// A chave de acesso primeiro onde se pede o código do app (A7, W9, parte 9c3; P28; D-A7-56): a regra de quem tem o app e
// quem tem a chave, a hora nova conferida sem o código, e a barra de Aprovações, "Apagar das redes" e "Mudar a hora" nas
// três situações (só a chave, a chave e o app, nenhum dos dois).

const texto = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const nada = async () => ({ ok: true as const });

describe('como a pessoa confirma', () => {
  it('pelo /v1/me: o app e a chave; sem a lista (resposta antiga), o segundo fator conta como o app', () => {
    expect(formasDeConfirmar({ mfa: 'verified', mfa_methods: ['totp', 'chave'] })).toEqual({ temApp: true, temChave: true });
    expect(formasDeConfirmar({ mfa: 'verified', mfa_methods: ['chave'] })).toEqual({ temApp: false, temChave: true });
    expect(formasDeConfirmar({ mfa: 'verified', mfa_methods: ['totp'] })).toEqual({ temApp: true, temChave: false });
    expect(formasDeConfirmar({ mfa: 'not_configured', mfa_methods: [] })).toEqual({ temApp: false, temChave: false });
    expect(formasDeConfirmar({ mfa: 'verified' })).toEqual({ temApp: true, temChave: false });
  });

  it('a hora nova sem o código (quem confirma com a chave): só o dia e a hora', () => {
    const agora = new Date('2026-10-29T15:00:00Z');
    const post = { publish_at: '2026-10-30T22:00:00Z', timezone: 'America/Sao_Paulo' };
    expect(erroDaHoraNova({ dia: '2026-10-31', hora: '20:30', codigo: null }, post, agora)).toBeNull();
    expect(erroDaHoraNova({ dia: '2026-10-31', hora: '20:30', codigo: '12' }, post, agora)?.campo).toBe('codigo');
    expect(erroDaHoraNova({ dia: '2026-10-31', hora: '23:30', codigo: null }, post, agora)?.campo).toBe('hora');
  });
});

describe('a barra de Aprovações', () => {
  const barra = (temApp: boolean, temChave: boolean) =>
    texto(
      renderToStaticMarkup(
        createElement(BarraDaDecisao, { ids: 'b', temApp, temChave, campoCodigo: createRef<HTMLInputElement>(), motivos: [], dica: 'A dica.', aoAprovar: nada, aoRecusar: nada }),
      ),
    );

  it('só com a chave: "Aprovar com a chave", sem o campo do código', () => {
    const t = barra(false, true);
    expect(t).toContain('Aprovar com a chave');
    expect(t).not.toContain('Código do app');
    expect(t).not.toContain('Aprovar com o código');
    expect(t).not.toContain('ative o app autenticador');
  });

  it('com a chave e o app: a chave primeiro, o código ao lado', () => {
    const html = renderToStaticMarkup(
      createElement(BarraDaDecisao, { ids: 'b', temApp: true, temChave: true, campoCodigo: createRef<HTMLInputElement>(), motivos: [], dica: 'A dica.', aoAprovar: nada, aoRecusar: nada }),
    );
    const t = texto(html);
    expect(t).toContain('Aprovar com a chave');
    expect(t).toContain('Ou o código do app');
    expect(t).toContain('Aprovar com o código');
    expect(t.indexOf('Aprovar com a chave')).toBeLessThan(t.indexOf('Ou o código do app'));
    expect(html).toContain('btn--primary');
  });

  it('só com o app, como antes; sem nenhum, o caminho para Segurança da conta', () => {
    const app = barra(true, false);
    expect(app).toContain('Código do app');
    expect(app).not.toContain('Aprovar com a chave');
    expect(barra(false, false)).toContain('Para aprovar, ative o app autenticador ou crie uma chave de acesso em Segurança da conta');
  });
});

describe('apagar das redes e mudar a hora', () => {
  it('apagar: com a chave, "Apagar com a chave" (vermelho cheio); o código só com o app', () => {
    const so = renderToStaticMarkup(createElement(ApagarDasRedes, { id: 'a', deOnde: 'do Instagram', temApp: false, temChave: true, aoApagar: nada, aoManter: () => {} }));
    expect(texto(so)).toContain('Apagar com a chave');
    expect(texto(so)).not.toContain('Código do app');
    expect(so).toContain('btn--perigo-cheio');
    const ambos = texto(renderToStaticMarkup(createElement(ApagarDasRedes, { id: 'a', deOnde: 'do Instagram', temApp: true, temChave: true, aoApagar: nada, aoManter: () => {} })));
    expect(ambos).toContain('Ou o código do app');
    expect(ambos).toContain('Apagar com o código');
    expect(texto(renderToStaticMarkup(createElement(ApagarDasRedes, { id: 'a', deOnde: 'do Instagram', aoApagar: nada, aoManter: () => {} })))).toContain('Apagar das redes');
  });

  it('mudar a hora: com a chave, "Mudar a hora com a chave"; o código só com o app', () => {
    const post = { publish_at: '2026-10-30T22:00:00Z', timezone: 'America/Sao_Paulo' };
    const agora = new Date('2026-10-29T15:00:00Z');
    const so = texto(renderToStaticMarkup(createElement(MudarAHora, { id: 'm', post, agora, temApp: false, temChave: true, aoMudar: nada })));
    expect(so).toContain('Mudar a hora com a chave');
    expect(so).not.toContain('Código do app');
    const ambos = texto(renderToStaticMarkup(createElement(MudarAHora, { id: 'm', post, agora, temApp: true, temChave: true, aoMudar: nada })));
    expect(ambos).toContain('Ou o código do app');
    expect(ambos).toContain('Mudar com o código');
  });
});
