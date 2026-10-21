import type { BrandDossierSuggestion, ResearchListResponse, ResearchResponse } from '@liame/contracts';
import { createElement, createRef } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CartaoPaginas } from '@/components/minha-marca/cartao-paginas';
import { GavetaPagina } from '@/components/minha-marca/gaveta-pagina';
import {
  acaoDaLeitura,
  avisoDoPesquisador,
  conferirEndereco,
  emAndamento,
  linhaDoLimite,
  MOTIVO_DA_LEITURA,
  quandoDaLeitura,
  quandoRecomeca,
  situacaoDaLeitura,
} from '@/components/minha-marca/pesquisador';

// "Ler uma página" (A3 · P25, aprovado em 21/10/2026; mockups/prototipo-pesquisador.html): as regras do cartão
// "Páginas lidas" e da gaveta de pedir, sobre a lista que a API devolve (`GET /v1/brand-dossier/research`), e o desenho
// do cartão e da gaveta pelos mesmos componentes do navegador. As horas saem do relógio local (V113).

const uuid = (n: number) => `b0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const local = (h: number, m = 0, d = 21) => new Date(2026, 9, d, h, m).toISOString();
const AGORA = new Date(2026, 9, 21, 15, 0);

const leitura = (over: Partial<ResearchResponse> = {}): ResearchResponse => ({
  id: uuid(1),
  brand_id: uuid(90),
  kind: 'cardapio',
  url: 'https://misterburgers.com.br/cardapio',
  host: 'misterburgers.com.br',
  status: 'pendente',
  reason: null,
  sections: [],
  requested_by: { id: uuid(80), name: 'Rodrigo' },
  created_at: local(10, 12),
  finished_at: null,
  ...over,
});
const sugestao = (over: Partial<BrandDossierSuggestion> = {}): BrandDossierSuggestion => ({
  id: uuid(50),
  section: 'produtos',
  source: 'pesquisador',
  items: [{ op: 'incluir', text: 'Smash Clássico, R$ 29,90', before: null, why: 'escrito em misterburgers.com.br, lido em 21/10/2026' }],
  based_on_version: 3,
  created_at: local(10, 13),
  ...over,
});
const lista = (over: Partial<ResearchListResponse> = {}): ResearchListResponse => ({
  items: [leitura()],
  availability: { status: 'disponivel' },
  daily: { used: 3, limit: 20, resets_at: local(21, 0) },
  ...over,
});

describe('Ler uma página: a situação de cada pedido, em palavra', () => {
  it('na fila, lendo, esperando a IA ou o Pesquisador, e a falha que o Liame tenta de novo sozinho', () => {
    expect(situacaoDaLeitura(leitura(), [])).toEqual({ classe: 'st--espera', rotulo: 'Na fila', texto: 'O Pesquisador lê em alguns minutos.' });
    expect(situacaoDaLeitura(leitura({ status: 'lendo' }), []).rotulo).toBe('Lendo agora');
    // Sem a IA ou sem o Pesquisador, o pedido espera sem contar tentativa, e a tela não promete hora.
    expect(situacaoDaLeitura(leitura({ reason: 'ia_desligada' }), [])).toEqual({ classe: 'st--espera', rotulo: 'Esperando', texto: 'A IA está desligada nesta empresa. A leitura espera a IA voltar.' });
    expect(situacaoDaLeitura(leitura({ reason: 'funcionario_desligado' }), []).texto).toBe('O Pesquisador está desligado nesta marca. A leitura espera ele ser ligado de novo.');
    expect(situacaoDaLeitura(leitura({ reason: 'sem_rota' }), []).rotulo).toBe('Esperando');
    // A falha passageira: o porquê e o que o Liame faz sozinho.
    expect(situacaoDaLeitura(leitura({ reason: 'fora_do_ar' }), [])).toEqual({
      classe: 'st--aguardando',
      rotulo: 'Vai tentar de novo',
      texto: 'O site não respondeu. O Liame tenta de novo sozinho, cada vez mais tarde, até 5 vezes.',
    });
    // Um código que a tela ainda não conhece não vira "undefined".
    expect(situacaoDaLeitura(leitura({ reason: 'novo_codigo' }), []).texto).toBe(`${MOTIVO_DA_LEITURA.erro} O Liame tenta de novo sozinho, cada vez mais tarde, até 5 vezes.`);
  });

  it('pronta com sugestão para conferir, já conferida, ou sem nada novo; recusada e a que o Liame desistiu de ler', () => {
    const pronta = leitura({ status: 'concluida', sections: ['produtos', 'ofertas'], finished_at: local(10, 13) });
    expect(situacaoDaLeitura(pronta, [sugestao()]).texto).toBe('Produtos e Ofertas ganharam sugestões para conferir.');
    expect(situacaoDaLeitura({ ...pronta, sections: ['produtos'] }, [sugestao()]).texto).toBe('Produtos ganhou uma sugestão para conferir.');
    // A sugestão do sistema na mesma parte não é a do Pesquisador.
    expect(situacaoDaLeitura(pronta, [sugestao({ source: 'sistema' })]).texto).toBe('Produtos e Ofertas: a sugestão já foi conferida.');
    expect(situacaoDaLeitura({ ...pronta, sections: [] }, []).texto).toBe('Nada novo para sugerir: o que a página diz já está em Minha marca.');
    expect(situacaoDaLeitura(leitura({ status: 'recusada', reason: 'robots' }), [])).toEqual({ classe: 'st--perigo', rotulo: 'Recusada', texto: MOTIVO_DA_LEITURA.robots });
    expect(situacaoDaLeitura(leitura({ status: 'falhou', reason: 'fora_do_ar' }), [])).toEqual({ classe: 'st--perigo', rotulo: 'Não deu para ler', texto: 'O site não respondeu. O Liame tentou 5 vezes.' });
  });

  it('a lista ainda anda sozinha só com pedido na fila sem motivo ou sendo lido', () => {
    expect(emAndamento([leitura()])).toBe(true);
    expect(emAndamento([leitura({ status: 'lendo' })])).toBe(true);
    // A falha passageira só é tentada de novo depois de 15 minutos ou mais: a tela não fica lendo a lista por ela.
    expect(emAndamento([leitura({ reason: 'fora_do_ar' }), leitura({ status: 'concluida' }), leitura({ status: 'recusada', reason: 'robots' })])).toBe(false);
  });
});

describe('Ler uma página: o que resolve cada caso (V59)', () => {
  const pronta = leitura({ status: 'concluida', sections: ['produtos'], finished_at: local(10, 13) });
  it('conferir a sugestão, ler de novo, outro endereço ou preencher à mão; e nada quando não há o que fazer', () => {
    expect(acaoDaLeitura(pronta, [sugestao()], true, true)).toEqual({ tipo: 'conferir', sugestao: sugestao() });
    expect(acaoDaLeitura(leitura({ status: 'falhou', reason: 'fora_do_ar' }), [], true, true)).toEqual({ tipo: 'ler-de-novo' });
    expect(acaoDaLeitura(leitura({ status: 'recusada', reason: 'nao_achou' }), [], true, true)).toEqual({ tipo: 'outro-endereco' });
    expect(acaoDaLeitura(leitura({ status: 'recusada', reason: 'robots', kind: 'site' }), [], true, true)).toEqual({ tipo: 'a-mao', secao: 'identidade' });
    expect(acaoDaLeitura(leitura({ status: 'recusada', reason: 'sem_acesso', kind: 'concorrente' }), [], true, true)).toEqual({ tipo: 'a-mao', secao: 'concorrentes' });
    // A página que tenta dar ordens e a da rede interna não têm ação; a falha passageira, o Liame repete sozinho.
    for (const x of [leitura({ status: 'recusada', reason: 'instrucao_na_pagina' }), leitura({ status: 'recusada', reason: 'rede_interna' }), leitura({ reason: 'fora_do_ar' }), leitura()]) {
      expect(acaoDaLeitura(x, [], true, true)).toBeNull();
    }
  });
  it('quem só vê não ganha ação; sem dar para pedir (IA ou Pesquisador desligado), ainda dá para conferir', () => {
    expect(acaoDaLeitura(pronta, [sugestao()], false, false)).toBeNull();
    expect(acaoDaLeitura(leitura({ status: 'falhou', reason: 'fora_do_ar' }), [], false, true)).toBeNull();
    expect(acaoDaLeitura(pronta, [sugestao()], false, true)).toEqual({ tipo: 'conferir', sugestao: sugestao() });
  });
});

describe('Ler uma página: quando, quem e o limite do dia', () => {
  it('quem pediu e quando; no mesmo dia, só a hora do fim; em outro dia, o dia e a hora', () => {
    expect(quandoDaLeitura(leitura(), AGORA)).toBe(`Pedida por Rodrigo, hoje, ${hora(10, 12)}`);
    expect(quandoDaLeitura(leitura({ status: 'concluida', finished_at: local(10, 13) }), AGORA)).toBe(`Pedida por Rodrigo, hoje, ${hora(10, 12)} · lida às ${hora(10, 13)}`);
    // Em outro dia: "fechada hoje, 00:05" (nunca "em hoje") ou "lida em 19/10, 10:13".
    expect(quandoDaLeitura(leitura({ status: 'recusada', reason: 'robots', created_at: local(23, 50, 20), finished_at: local(0, 5) }), AGORA)).toBe(
      `Pedida por Rodrigo, ontem, ${hora(23, 50)} · fechada hoje, ${hora(0, 5)}`,
    );
    expect(quandoDaLeitura(leitura({ status: 'concluida', created_at: local(23, 50, 18), finished_at: local(10, 13, 19) }), AGORA)).toBe(
      `Pedida por Rodrigo, 18/10, ${hora(23, 50)} · lida em 19/10, ${hora(10, 13)}`,
    );
    expect(quandoDaLeitura(leitura({ requested_by: null }), AGORA)).toBe(`Pedida por alguém que não está mais na empresa, hoje, ${hora(10, 12)}`);
  });
  it('a conta do dia nunca passa do limite, e diz quando recomeça (hoje ou amanhã)', () => {
    expect(linhaDoLimite({ used: 3, limit: 20, resets_at: local(21, 0) }, AGORA)).toBe(`3 de 20 leituras desta marca usadas · a conta recomeça hoje, ${hora(21, 0)}`);
    expect(linhaDoLimite({ used: 25, limit: 20, resets_at: local(21, 0) }, AGORA)).toMatch(/^20 de 20 /);
    expect(quandoRecomeca(local(21, 0, 22), new Date(2026, 9, 21, 22, 30))).toBe(`amanhã, ${hora(21, 0)}`);
  });
  it('o endereço: a mesma conferência do servidor, antes de mandar', () => {
    expect(conferirEndereco('  ')).toBe('Cole o endereço da página.');
    expect(conferirEndereco('misterburgers.com.br')).toMatch(/^Esse endereço não está completo/);
    expect(conferirEndereco('http://misterburgers.com.br')).toBe('Use o endereço completo, começando com https://');
    expect(conferirEndereco('https://ana:senha@misterburgers.com.br/')).toBe('O endereço não pode ter usuário e senha.');
    expect(conferirEndereco(' https://misterburgers.com.br/cardapio ')).toBeNull();
  });
});

describe('Ler uma página: o aviso quando não dá para pedir, para quem lê (V128)', () => {
  const dono = { podeEditar: true, podeLigar: true };
  it('a IA desligada e o Pesquisador desligado pela Liame não têm o que abrir', () => {
    expect(avisoDoPesquisador('ia_desligada', dono)).toMatchObject({ titulo: 'A IA está desligada nesta empresa', abrirEquipe: false });
    expect(avisoDoPesquisador('desligado_pela_liame', dono)).toMatchObject({ titulo: 'O Pesquisador foi desligado pela Liame nesta marca', abrirEquipe: false });
    expect(avisoDoPesquisador('disponivel', dono)).toBeNull();
  });
  it('desligado em Sua equipe: quem liga lê "ligue-o"; quem não liga lê quem faz', () => {
    expect(avisoDoPesquisador('pesquisador_desligado', dono)).toEqual({
      titulo: 'O Pesquisador está desligado nesta marca',
      texto: 'Para pedir leituras, ligue-o em Sua equipe. As leituras pedidas esperam.',
      abrirEquipe: true,
    });
    expect(avisoDoPesquisador('pesquisador_desligado', { podeEditar: false, podeLigar: true })?.texto).toBe('Dá para ligá-lo de novo em Sua equipe. As leituras pedidas esperam.');
    expect(avisoDoPesquisador('pesquisador_desligado', { podeEditar: true, podeLigar: false })).toMatchObject({
      texto: 'Quem gerencia a equipe liga o Pesquisador de novo, em Sua equipe. As leituras pedidas esperam.',
      abrirEquipe: false,
    });
  });
});

describe('Ler uma página: o cartão "Páginas lidas" e a gaveta, pelos componentes da tela', () => {
  const nada = () => undefined;
  const cartao = (over: Partial<Parameters<typeof CartaoPaginas>[0]> = {}) =>
    renderToStaticMarkup(
      createElement(CartaoPaginas, {
        lista: lista(),
        erro: null,
        sugestoes: [],
        podeEditar: true,
        podeLigar: true,
        agora: AGORA,
        destaque: null,
        relendo: null,
        tituloRef: createRef<HTMLHeadingElement>(),
        aoPedir: nada,
        aoConferir: nada,
        aoLerDeNovo: nada,
        aoOutroEndereco: nada,
        aoPreencher: nada,
        aoRecarregar: nada,
        ...over,
      }),
    );

  it('a lista com a situação, a conta do dia e o pedido; o vazio; o erro com "Tentar de novo"; o carregando', () => {
    const html = cartao();
    expect(html).toContain('Páginas lidas');
    expect(html).toContain('misterburgers.com.br');
    expect(html).toContain('cardápio online');
    expect(html).toContain('Na fila');
    expect(html).toContain('3 de 20 leituras desta marca usadas');
    expect(html).toContain('Ler uma página');
    const vazio = cartao({ lista: lista({ items: [] }) });
    expect(vazio).toContain('Nenhuma página lida ainda');
    expect(vazio).not.toContain('leituras desta marca usadas');
    const erro = cartao({ lista: null, erro: 'Não conseguimos falar com o Liame.' });
    expect(erro).toContain('Não foi possível carregar as páginas lidas');
    expect(erro).toContain('Tentar de novo');
    expect(cartao({ lista: null })).toContain('aria-busy="true"');
  });

  it('quem só vê: sem pedir e sem a conta do dia, com o aviso de quem pede; IA desligada: o aviso e nenhum pedido', () => {
    const leitor = cartao({ podeEditar: false, podeLigar: false });
    expect(leitor).toContain('só o Dono e o Administrador pedem leituras');
    expect(leitor).not.toContain('Ler uma página');
    expect(leitor).not.toContain('leituras desta marca usadas');
    const semIa = cartao({ lista: lista({ availability: { status: 'ia_desligada' } }) });
    expect(semIa).toContain('A IA está desligada nesta empresa');
    expect(semIa).not.toContain('Ler uma página');
    expect(semIa).not.toContain('Abrir Sua equipe');
    const desligado = cartao({ lista: lista({ availability: { status: 'pesquisador_desligado' } }) });
    expect(desligado).toContain('href="/equipe"');
    expect(cartao({ lista: lista({ availability: { status: 'pesquisador_desligado' } }), podeLigar: false })).not.toContain('href="/equipe"');
  });

  it('cada linha com a ação que resolve o caso; "Ler de novo" em andamento diz "Pedindo…"', () => {
    const falhou = leitura({ id: uuid(2), status: 'falhou', reason: 'fora_do_ar', finished_at: local(12, 0) });
    const sumiu = leitura({ id: uuid(3), status: 'recusada', reason: 'nao_achou', finished_at: local(12, 1) });
    const robots = leitura({ id: uuid(4), kind: 'site', status: 'recusada', reason: 'robots', finished_at: local(12, 2) });
    const html = cartao({ lista: lista({ items: [falhou, sumiu, robots] }), relendo: uuid(2) });
    expect(html).toContain('Pedindo…');
    expect(html).toContain('Ler outro endereço');
    expect(html).toContain('Preencher identidade à mão');
    // O nome do site comprido quebra dentro da linha (V107): o contêiner tem a regra e o host vai inteiro.
    const comprido = `${'pagina'.repeat(10)}.com.br`;
    expect(cartao({ lista: lista({ items: [leitura({ host: comprido })] }) })).toContain(`<b>${comprido}</b>`);
  });

  it('a gaveta: os três tipos de página, o endereço, o que o Liame faz e a conta do dia; no limite, só "Fechar"', () => {
    const gaveta = (daily: ResearchListResponse['daily']) =>
      renderToStaticMarkup(
        createElement(GavetaPagina, { marcaId: uuid(90), rascunho: null, daily, agora: AGORA, reserva: createRef<HTMLElement>(), aoPedido: nada, aoDesligado: nada, aoLimite: nada, aoFechar: nada }),
      );
    const html = gaveta({ used: 3, limit: 20, resets_at: local(21, 0) });
    for (const t of ['O site da marca', 'O cardápio online', 'A página de um concorrente', 'Endereço da página', 'A página não fica guardada', 'Pedir a leitura', '3 de 20 leituras']) expect(html).toContain(t);
    // O limite é da marca: a frase não diz "você" (outra pessoa da equipe pode ter pedido).
    const cheia = gaveta({ used: 20, limit: 20, resets_at: local(21, 0) });
    expect(cheia).toContain('Já foram pedidas as 20 leituras do dia desta marca');
    expect(cheia).not.toContain('Você já pediu');
    expect(cheia).toContain(`A conta recomeça hoje, ${hora(21, 0)}`);
    expect(cheia).not.toContain('Pedir a leitura');
    expect(cheia).toContain('Fechar');
  });
});

/** A hora como a tela escreve ("10:12"), no fuso de quem roda o teste. */
function hora(h: number, m: number): string {
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
