import { describe, expect, it } from 'vitest';
import { estaRecusando, JANELA_DAS_RECUSAS_DIAS, MINIMO_DE_RECUSAS } from '../src/conversoes/recusando.js';
import { avisoVendasAoGoogleRecusadas, avisoVendasAoGoogleSemPermissao, ordenarCiclo } from '../src/results/atencao-ciclo.js';

// A5 · Y1 (protótipo P14, parte B, aprovado em 09/10/2026), sem banco: a regra de "o Google está recusando as vendas" e
// os dois avisos da Atenção quando o envio para sem ninguém ter mandado parar.

describe('as vendas informadas ao Google: quando o envio parou (P14, parte B)', () => {
  const conta = { id: '01a0e1a1-ea5a-7822-a16c-376c2c942655', nome: 'Mister Burgers Google' };

  it('"está recusando": pelo menos três recusadas, e mais da metade das que tiveram resposta', () => {
    expect([JANELA_DAS_RECUSAS_DIAS, MINIMO_DE_RECUSAS]).toEqual([7, 3]);
    // Recusa isolada não é aviso.
    expect(estaRecusando(0, 0)).toBe(false);
    expect(estaRecusando(1, 1)).toBe(false);
    expect(estaRecusando(2, 2)).toBe(false);
    // Três ou mais, e mais da metade.
    expect(estaRecusando(3, 3)).toBe(true);
    expect(estaRecusando(3, 5)).toBe(true);
    expect(estaRecusando(9, 12)).toBe(true);
    // Metade exata, ou menos, não é "mais da metade".
    expect(estaRecusando(3, 6)).toBe(false);
    expect(estaRecusando(5, 40)).toBe(false);
  });

  it('falta a permissão: o aviso diz o motivo certo (a autorização não a inclui, ou o Google recusou a que o Liame tem) e o que fazer', () => {
    const falta = avisoVendasAoGoogleSemPermissao(conta, false);
    expect(falta).toEqual({
      kind: 'vendas_google_sem_permissao',
      severity: 'atencao',
      title: 'O Liame parou de informar as vendas ao Google',
      detail: 'Falta uma permissão do Google na conta Mister Burgers Google. Enquanto faltar, nenhuma venda nova é informada. Os seus Resultados não mudam: eles vêm do caixa.',
      action: 'Em Contas conectadas, autorize o Google de novo e, na volta, confirme as contas. Nada é desligado.',
      connected_account_id: conta.id,
      campaign_id: null,
      provider: 'google_ads',
    });
    const recusou = avisoVendasAoGoogleSemPermissao(conta, true);
    expect(recusou.detail).toBe(
      'O Google recusou a autorização que o Liame usa na conta Mister Burgers Google. Enquanto ela não for refeita, nenhuma venda nova é informada. Os seus Resultados não mudam: eles vêm do caixa.',
    );
    expect([recusou.kind, recusou.title, recusou.action]).toEqual([falta.kind, falta.title, falta.action]);
  });

  it('o Google recusando: quantas de quantas, em quantos dias, e que essas vendas seguem contando nos Resultados', () => {
    expect(avisoVendasAoGoogleRecusadas(conta, 9, 12, 7)).toEqual({
      kind: 'vendas_google_recusadas',
      severity: 'atencao',
      title: 'O Google está recusando as vendas informadas',
      detail: 'Nos últimos 7 dias, o Google recusou 9 das 12 vendas informadas pela conta Mister Burgers Google. O Liame não tenta de novo sozinho, e essas vendas seguem contando nos seus Resultados.',
      action: 'Veja o motivo em Contas conectadas e confira, no Google Ads, se a conversão escolhida ainda existe. Trocar a conversão recomeça de agora.',
      connected_account_id: conta.id,
      campaign_id: null,
      provider: 'google_ads',
    });
  });

  it('nenhum texto leva dado pessoal nem identificador de clique; na ordem, vêm antes dos outros de atenção que não são de fonte parada', () => {
    const avisos = [avisoVendasAoGoogleSemPermissao(conta, false), avisoVendasAoGoogleRecusadas(conta, 3, 4, 7)];
    for (const a of avisos) expect(`${a.title} ${a.detail} ${a.action}`).not.toMatch(/gclid|gbraid|wbraid|@|telefone|e-mail/i);
    const base = { severity: 'atencao' as const, title: '', detail: '', action: '', connected_account_id: null, campaign_id: null, provider: null };
    const ordem = ordenarCiclo([{ ...base, kind: 'cupom_sem_uso' }, { ...base, kind: 'anuncio_sem_rastreio' }, avisos[1]!, avisos[0]!, { ...base, kind: 'conta_com_erro' }, { ...base, kind: 'dado_atrasado', severity: 'critica' }]).map((i) => i.kind);
    expect(ordem).toEqual(['dado_atrasado', 'conta_com_erro', 'vendas_google_sem_permissao', 'vendas_google_recusadas', 'anuncio_sem_rastreio', 'cupom_sem_uso']);
  });
});
