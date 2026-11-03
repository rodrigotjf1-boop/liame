import type { TermsVersionInfo } from '@liame/contracts';
import { describe, expect, it } from 'vitest';
import {
  dataBr,
  diasAte,
  faixaDoDiaNaCobranca,
  faixaDosTermos,
  fraseDoAceite,
  hojeEmBrasilia,
  naoConcorda,
  quandoVale,
  secaoDaMudanca,
  tituloDaTelaDoDia,
  vespera,
} from '@/components/termos/textos';

// Os Termos novos no web (A7, W14, parte 14d; P35 aprovado; D-A7-90 a D-A7-93): as frases da faixa, da gaveta e da tela
// do aceite, as mesmas do protótipo.

const versao = (extra: Partial<TermsVersionInfo> = {}): TermsVersionInfo => ({
  version: '2026-12-02',
  kind: 'relevante',
  notice_at: '2026-11-02T13:00:00.000Z',
  effective_on: '2026-12-02',
  documents: [{ document: 'termos', url: 'https://agencialiame.com/termos/2026-12-02' }],
  changes: [
    { document: 'termos', section: '4', title: 'Agências parceiras', today: 'Só a empresa.', becomes: 'A agência aceita pelo Dono.' },
    { document: 'termos', section: '10 e 11', title: 'Cobrança, atraso e cancelamento', today: 'As regras gerais.', becomes: 'PIX ou cartão.' },
    { document: 'termos', section: '3', title: 'A conta do Dono', today: 'Quem criou.', becomes: 'Passar a propriedade.' },
    { document: 'privacidade', section: '4', title: 'Chaves de acesso', today: 'A senha.', becomes: 'A chave pública.' },
  ],
  reason: null,
  withdrawn: false,
  ...extra,
});

describe('os Termos novos: as datas', () => {
  it('o dia em Brasília, a data escrita, os dias que faltam e a véspera', () => {
    expect(hojeEmBrasilia(new Date('2026-12-03T01:00:00Z'))).toBe('2026-12-02');
    expect(dataBr('2026-12-02')).toBe('02/12/2026');
    expect(diasAte('2026-12-02', '2026-11-27')).toBe(5);
    expect(vespera('2026-12-01')).toBe('30/11/2026');
  });
});

describe('a faixa no alto das telas (D-A7-90)', () => {
  it('durante o aviso: o dia em que mudam e quantas mudanças; até lá, valem os de hoje', () => {
    expect(faixaDosTermos(versao(), '2026-11-05')).toEqual({
      tipo: 'acao',
      titulo: 'Os Termos de Uso e a Política de Privacidade mudam em 02/12/2026',
      texto: 'São 4 mudanças. Até lá, valem os de hoje.',
    });
  });

  it('nos últimos 7 dias, âmbar e contando os dias (e o último no singular)', () => {
    expect(faixaDosTermos(versao(), '2026-11-27')).toEqual({
      tipo: 'atencao',
      titulo: 'Faltam 5 dias para os Termos novos',
      texto: 'Em 02/12/2026, quem não aceitou vê só a tela do aceite até aceitar. São 4 mudanças.',
    });
    expect(faixaDosTermos(versao({ changes: versao().changes.slice(0, 1) }), '2026-12-01').titulo).toBe('Falta 1 dia para os Termos novos');
    expect(faixaDosTermos(versao({ changes: versao().changes.slice(0, 1) }), '2026-12-01').texto).toContain('São 1 mudança.');
  });
});

describe('a gaveta e a tela do aceite (D-A7-91 a D-A7-93)', () => {
  it('o dia em que vale, antes e no dia, e a frase do aceite junto do botão', () => {
    expect(quandoVale(versao(), false)).toBe('Valem a partir de 02/12/2026. Até lá, valem os de hoje.');
    expect(quandoVale(versao(), true)).toBe('Valem desde 02/12/2026.');
    expect(fraseDoAceite(versao(), false)).toBe('Ao aceitar, você concorda com os Termos de Uso e a Política de Privacidade que valem a partir de 02/12/2026.');
    expect(fraseDoAceite(versao(), true)).toBe('Ao aceitar, você concorda com os Termos de Uso e a Política de Privacidade que valem desde 02/12/2026.');
  });

  it('quem não concorda: o Dono cancela sem multa até a véspera (no dia, no fim do período); os outros falam com o Dono', () => {
    expect(naoConcorda(versao(), true, false)).toBe(
      'Não concorda? Você pode cancelar sem multa até 01/12/2026, em Plano e cobrança (Termos 15). Até lá, a empresa segue com os Termos de hoje.',
    );
    expect(naoConcorda(versao(), true, true)).toContain('vale no fim do período pago, e os dados ficam para exportar');
    expect(naoConcorda(versao(), false, false)).toBe('Não concorda? Fale com o Dono da empresa: só ele cancela a assinatura.');
  });

  it('o título do dia, a seção de cada mudança e a faixa do Dono em Plano e cobrança', () => {
    expect(tituloDaTelaDoDia(versao())).toBe('Os Termos novos valem desde 02/12/2026');
    expect(secaoDaMudanca(versao().changes[3]!)).toBe('Política de Privacidade · 4');
    expect(faixaDoDiaNaCobranca(versao()).texto).toBe('Para voltar às outras telas, aceite. Aqui você pode cancelar a assinatura, sem multa, e exportar os dados.');
  });
});
