import { describe, expect, it } from 'vitest';
import { type AssuntoDoPulso, assuntosEmAlta, combinaComOCardapio, datasDoPeriodo, type EventoDoPulso } from '../src/conteudo/datas.js';

// Plano de conteúdo, PC4, parte 2 (seção 6.3): as datas do período, contas puras. O calendário comercial do Liame junto
// com os eventos do Pulso, sem repetir; o dia de comida que combina com o cardápio; o "Em alta" só com manchete.

const evento = (o: Partial<EventoDoPulso> & Pick<EventoDoPulso, 'tipo' | 'nome' | 'inicio'>): EventoDoPulso => ({
  id: `e-${o.nome}`,
  dia_inteiro: true,
  fim: null,
  fuso: 'America/Sao_Paulo',
  abrangencia: [{ nivel: 'nacional', valor: 'BR' }],
  detalhes: null,
  fonte: { nome: 'Pulso · Lei', endereco: null },
  ...o,
});

describe('as datas e as tendências do plano (PC4, parte 2)', () => {
  it('o tema do dia de comida combina com o cardápio pela palavra inteira, sem acento', () => {
    expect(combinaComOCardapio('hamburguer', 'TRIO 08 Burger 08 Trio - Burguer + Batata + Refri')).toBe(true);
    expect(combinaComOCardapio('pizza', 'TRIO 08 Batata Frita')).toBe(false);
    expect(combinaComOCardapio('batata_frita', 'Batata Frita - Grande')).toBe(true);
    // "pizzaria" não é "pizza" (palavra inteira); o Dia do Garçom nunca combina (é da equipe).
    expect(combinaComOCardapio('pizza', 'Pizzaria do Zé')).toBe(false);
    expect(combinaComOCardapio('garcom', 'Garçom')).toBe(false);
    expect(combinaComOCardapio(null, 'qualquer')).toBe(false);
  });

  it('junta o Liame e o Pulso sem repetir: o feriado nacional e a mesma data ficam com a lei do Liame', () => {
    const datas = datasDoPeriodo(
      [
        { day: '2026-12-25', name: 'Natal', kind: 'feriado_nacional', source: 'Lei 662/1949' },
        { day: '2026-12-24', name: 'Véspera de Natal', kind: 'varejo', source: 'Data do varejo: 24 de dezembro' },
        // Fora do período: não entra.
        { day: '2027-01-01', name: 'Confraternização Universal', kind: 'feriado_nacional', source: 'Lei 662/1949' },
      ],
      [
        evento({ tipo: 'feriado', nome: 'Natal (dia de Natal)', inicio: '2026-12-25' }),
        evento({ tipo: 'comemorativa', nome: 'Vespera de Natal', inicio: '2026-12-24' }),
        evento({ tipo: 'ponto_facultativo', nome: 'Ponto facultativo municipal', inicio: '2026-12-24', abrangencia: [{ nivel: 'municipio', valor: '3304557' }], fonte: { nome: 'Diário Oficial do Rio', endereco: 'https://doweb.rio/x' } }),
        evento({ tipo: 'jogo', nome: 'Flamengo x Vasco', inicio: '2026-12-20T19:30:00.000Z', dia_inteiro: false, abrangencia: [{ nivel: 'municipio', valor: '3304557' }] }),
        evento({ tipo: 'comemorativa', nome: 'Dia do Hambúrguer', inicio: '2026-12-22', detalhes: { grupo: 'comida', tema: 'hamburguer' } }),
      ],
      '2026-12-20',
      '2026-12-31',
      'TRIO 08 Burger',
    );
    expect(datas.map((d) => `${d.day} ${d.kind} ${d.name} ${d.origin}`)).toEqual([
      '2026-12-20 jogo Flamengo x Vasco pulso',
      '2026-12-22 comida Dia do Hambúrguer pulso',
      '2026-12-24 ponto_facultativo Ponto facultativo municipal pulso',
      '2026-12-24 varejo Véspera de Natal liame',
      '2026-12-25 feriado_nacional Natal liame',
    ]);
    // O jogo com hora: 19:30 UTC é 16:30 em São Paulo; o alcance é o da cidade; a fonte vem com o endereço.
    expect(datas[0]).toMatchObject({ time: '16:30', scope: 'municipio', food_theme: null, menu_match: false });
    expect(datas[1]).toMatchObject({ time: null, scope: 'nacional', food_theme: 'hamburguer', menu_match: true });
    expect(datas[2]!.source).toEqual({ name: 'Diário Oficial do Rio', url: 'https://doweb.rio/x' });
  });

  it('o evento de vários dias que começa antes do período entra; o que termina antes, não', () => {
    const datas = datasDoPeriodo(
      [],
      [
        evento({ tipo: 'estreia', nome: 'Festival', inicio: '2026-12-18', fim: '2026-12-21' }),
        evento({ tipo: 'estreia', nome: 'Antigo', inicio: '2026-12-10', fim: '2026-12-12' }),
      ],
      '2026-12-20',
      '2026-12-31',
      '',
    );
    expect(datas.map((d) => [d.name, d.day, d.end_day])).toEqual([['Festival', '2026-12-18', '2026-12-21']]);
  });

  it('o "Em alta": só com manchete, em ordem de nota, até 10, com as manchetes em título, endereço e fonte', () => {
    const assunto = (titulo: string, nota: number, manchetes = 1): AssuntoDoPulso => ({
      titulo,
      nota,
      faixa: nota >= 70 ? 'alta' : 'media',
      monte: 'em_alta',
      onde: { nivel: 'nacional', valor: null },
      manchetes: Array.from({ length: manchetes }, (_, i) => ({ titulo: `${titulo} ${i}`, link: `https://g1.globo.com/${i}`, fonte: 'g1' })),
    });
    const r = assuntosEmAlta([assunto('B', 40), assunto('A', 80), assunto('Sem manchete', 99, 0), ...Array.from({ length: 12 }, (_, i) => assunto(`X${i}`, 10))]);
    expect(r).toHaveLength(10);
    expect(r[0]).toEqual({ title: 'A', score: 80, band: 'alta', pile: 'em_alta', scope: 'nacional', headlines: [{ title: 'A 0', url: 'https://g1.globo.com/0', source: 'g1' }] });
    expect(r.map((a) => a.title)).not.toContain('Sem manchete');
  });
});
