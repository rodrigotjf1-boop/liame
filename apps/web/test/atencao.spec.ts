import { describe, expect, it } from 'vitest';
import { acaoDoAviso, avisosFalados, contadorDoMenu, contagemPorGravidade, gravidadeDe, oQueFazer, rotuloDoFiltro } from '@/components/atencao/textos';
import { itemAtual, rotaPessoal, tituloDa } from '@/components/shell/navegacao';

// Regras puras de "Atenção de mídia" (gravidade, contagens, texto do "o que fazer") e do menu.

describe('atenção de mídia', () => {
  const itens = [{ severity: 'critica' }, { severity: 'critica' }, { severity: 'atencao' }, { severity: 'info' }, { severity: 'nova_gravidade' }];

  it('gravidade desconhecida cai em informação (a lista cresce na API, V23)', () => {
    expect(gravidadeDe('critica')).toBe('critica');
    expect(gravidadeDe('atencao')).toBe('atencao');
    expect(gravidadeDe('nova_gravidade')).toBe('info');
  });

  it('contagens dos filtros e o número do menu (informação não conta)', () => {
    expect(contagemPorGravidade(itens)).toEqual({ todas: 5, critica: 2, atencao: 1, info: 2 });
    expect(contadorDoMenu(itens)).toBe(3);
    expect(contadorDoMenu([])).toBe(0);
    expect(avisosFalados(1)).toBe(', 1 aviso');
    expect(avisosFalados(5)).toBe(', 5 avisos');
    expect([rotuloDoFiltro('todas'), rotuloDoFiltro('critica'), rotuloDoFiltro('atencao'), rotuloDoFiltro('info')]).toEqual([
      'Todos',
      'Críticos',
      'Atenção',
      'Informação',
    ]);
  });

  it('"o que fazer" continua a frase em minúscula, sem mexer em sigla ou nome próprio', () => {
    expect(oQueFazer('Conecte o Meta Ads de novo em Contas conectadas.')).toBe('conecte o Meta Ads de novo em Contas conectadas.');
    expect(oQueFazer('Os números desta conta podem não refletir hoje.')).toBe('os números desta conta podem não refletir hoje.');
    expect(oQueFazer('GA4 sem dados de ontem.')).toBe('GA4 sem dados de ontem.');
    expect(oQueFazer('Liame atualiza a integração.')).toBe('Liame atualiza a integração.');
  });

  it('botão de cada aviso, como no protótipo', () => {
    expect(acaoDoAviso('conta_desconectada')).toBe('abrir-contas');
    expect(acaoDoAviso('reconectar_em_breve')).toBe('reconectar');
    expect(acaoDoAviso('gasto_fora_do_normal')).toBeNull();
    expect(acaoDoAviso('tipo_novo')).toBeNull();
  });
});

describe('menu', () => {
  it('título da tela, item atual e telas da própria pessoa', () => {
    expect(tituloDa('/atencao')).toBe('Atenção de mídia');
    expect(tituloDa('/contas')).toBe('Contas conectadas');
    expect(tituloDa('/seguranca')).toBe('Segurança da conta');
    expect(tituloDa('/outra')).toBe('Liame');
    expect(itemAtual('/contas/algo', '/contas')).toBe(true);
    expect(itemAtual('/contasx', '/contas')).toBe(false);
    expect(rotaPessoal('/seguranca')).toBe(true);
    expect(rotaPessoal('/contas')).toBe(false);
  });
});
