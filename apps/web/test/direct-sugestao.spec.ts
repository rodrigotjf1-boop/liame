import type { DirectAiSuggestionResponse } from '@liame/contracts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PainelDoSocial } from '@/components/direct/sugestao-social';
import { dicaDoPedido, erroDaSugestao, faltaDaSugestao, ficaramDeFora, podePedirAoSocial, semIaDoDirect, ultimaDaPessoa } from '@/components/direct/textos';

// A sugestão do Social media na conversa do Direct, a pedido (A6 · Z12, parte 4b-2b; mockups/prototipo-direct.html, P39;
// D-A6-110 e D-A6-145): quando a tela oferece o pedido, o que ela mostra em cada situação (o pedido, a espera, a
// pergunta com "Conferido" ou "Precisa de você", a reclamação nos três caminhos, o "Pedir outra" uma vez) e as frases
// de quando o Social media não sugeriu.

const resposta = (o: Partial<DirectAiSuggestionResponse> = {}): DirectAiSuggestionResponse => ({
  origin: 'ia',
  reason: null,
  kind: 'pergunta',
  suggestions: [{ focus: 'Responder', text: 'Oi! Entregamos na Penha, sim. O cardápio está no link da bio.', check: 'passou' }],
  answered: true,
  missing: null,
  dropped: 0,
  retry_at: null,
  usage_id: '00000000-0000-4000-8000-0000000000aa',
  ...o,
});
const semIa = (reason: DirectAiSuggestionResponse['reason'], o: Partial<DirectAiSuggestionResponse> = {}) => resposta({ origin: 'sem_ia', reason, suggestions: [], answered: false, usage_id: null, ...o });
const TRES: DirectAiSuggestionResponse['suggestions'] = [
  { focus: 'Pedir desculpas e confirmar o pedido', text: 'Desculpa pelo pedido de ontem. Já passei para a loja conferir e te respondo aqui ainda hoje.', check: 'passou' },
  { focus: 'Explicar o que houve', text: 'Desculpa! A loja está conferindo a saída de ontem. Te respondo aqui assim que souber.', check: 'aviso' },
  { focus: 'Agradecer o aviso e dizer o que muda', text: 'Obrigado pelo aviso, e desculpa. Vamos rever a conferência na saída.', check: 'passou' },
];
const painel = (p: Partial<Parameters<typeof PainelDoSocial>[0]> = {}) =>
  renderToStaticMarkup(createElement(PainelDoSocial, { tipo: 'pergunta', dados: null, pedindo: false, outra: false, aviso: null, aoPedir: () => {}, aoUsar: () => {}, ...p }));

describe('a sugestão do Social media no Direct, a pedido (A6 · Z12, parte 4b-2b)', () => {
  it('a tela só oferece o pedido na pergunta e na reclamação que esperam resposta; a sugestão vale para a última mensagem da pessoa', () => {
    expect(podePedirAoSocial({ status: 'espera', kind: 'pergunta' })).toBe(true);
    expect(podePedirAoSocial({ status: 'espera', kind: 'reclamacao' })).toBe(true);
    // O elogio e a menção têm a resposta pronta; o golpe e a ofensa, nenhuma; o que a regra não decide fica com a pessoa.
    for (const kind of ['elogio', 'mencao', 'golpe', 'ofensivo', 'algo_novo', null]) expect(podePedirAoSocial({ status: 'espera', kind })).toBe(false);
    for (const status of ['respondida', 'fora', 'algo_novo']) expect(podePedirAoSocial({ status, kind: 'pergunta' })).toBe(false);
    expect(
      ultimaDaPessoa([
        { id: 'm1', direction: 'entrada' },
        { id: 'm2', direction: 'saida' },
        { id: 'm3', direction: 'entrada' },
        { id: 'm4', direction: 'saida' },
      ]),
    ).toBe('m3');
    expect(ultimaDaPessoa([{ id: 'm1', direction: 'saida' }])).toBe('');
    expect(ultimaDaPessoa([])).toBe('');
  });

  it('antes de pedir: o botão e o que o Social media faz em cada tipo, com "nada sai sem você mandar"', () => {
    const pergunta = painel();
    expect(pergunta).toContain('Pedir ao Social media');
    expect(pergunta).toContain(dicaDoPedido('pergunta'));
    expect(pergunta).toContain('aria-live="polite"');
    expect(pergunta).not.toContain('dir-sug"');
    expect(dicaDoPedido('pergunta')).toBe('Ele lê as últimas mensagens e responde com o que Minha marca diz, conferido. Nada sai sem você mandar.');
    expect(dicaDoPedido('reclamacao')).toBe('Ele lê as últimas mensagens e escreve três jeitos de responder, conferidos. Nada sai sem você mandar.');
    expect(painel({ tipo: 'reclamacao' })).toContain(dicaDoPedido('reclamacao'));
  });

  it('a espera: o botão sai e a tela diz que o Compliance confere antes de a sugestão chegar', () => {
    const html = painel({ pedindo: true });
    expect(html).toContain('O Social media está escrevendo, e o Compliance confere antes de chegar aqui.');
    expect(html).not.toContain('<button');
  });

  it('a pergunta respondida: "Conferido com Minha marca", o texto, "Usar esta" e "Pedir outra" uma vez', () => {
    const html = painel({ dados: resposta() });
    expect(html).toContain('aria-label="Sugestão do Social media"');
    expect(html).toContain('Conferido com Minha marca');
    expect(html).toContain('Oi! Entregamos na Penha, sim. O cardápio está no link da bio.');
    expect(html).toContain('Usar esta');
    expect(html).toContain('Pedir outra');
    expect(html).not.toContain('Precisa de você');
    // Depois de pedir outra: o botão sai (uma vez por mensagem), e "Usar esta" fica.
    const depois = painel({ dados: resposta(), outra: true });
    expect(depois).toContain('Usar esta');
    expect(depois).not.toContain('Pedir outra');
    // Pedindo outra: a sugestão que já está na tela continua, com a espera e sem o botão de pedir.
    const pedindo = painel({ dados: resposta(), pedindo: true });
    expect(pedindo).toContain('Oi! Entregamos na Penha');
    expect(pedindo).toContain('O Social media está escrevendo');
    expect(pedindo).not.toContain('Pedir outra');
  });

  it('a pergunta que ele não respondeu só com Minha marca: "Precisa de você", com o que faltou ou o aviso geral, e sem "Conferido"', () => {
    const comFalta = resposta({ answered: false, missing: 'o horário do feriado' });
    expect(faltaDaSugestao(comFalta)).toBe('Precisa de você: Minha marca não diz o horário do feriado. Confirme e complete antes de mandar.');
    expect(faltaDaSugestao(resposta({ answered: false, missing: null }))).toBe('Precisa de você: o Social media não achou tudo em Minha marca. Confira e complete antes de mandar.');
    expect(faltaDaSugestao(resposta())).toBeNull();
    // Na reclamação, a conferência aparece em cada caminho: sem o aviso da pergunta.
    expect(faltaDaSugestao(resposta({ kind: 'reclamacao', answered: false, suggestions: TRES }))).toBeNull();
    const html = painel({ dados: comFalta });
    expect(html).toContain('Precisa de você: Minha marca não diz o horário do feriado.');
    expect(html).not.toContain('Conferido');
    expect(html).toContain('Usar esta');
  });

  it('a reclamação: os caminhos na ordem, cada um com o enfoque, a conferência e "Usar este"; "Pedir outras" uma vez; o que ficou de fora', () => {
    const dados = resposta({ kind: 'reclamacao', answered: false, suggestions: TRES });
    const html = painel({ tipo: 'reclamacao', dados });
    expect(html).toContain('aria-label="Sugestões do Social media"');
    const ordem = TRES.map((s) => html.indexOf(s.focus));
    expect(ordem.every((p) => p >= 0)).toBe(true);
    expect([...ordem].sort((a, b) => a - b)).toEqual(ordem);
    expect(html.match(/Usar este/g)).toHaveLength(3);
    expect(html.match(/Conferido<\/span>/g)).toHaveLength(2);
    expect(html.match(/Confira antes de mandar/g)).toHaveLength(1);
    expect(html).toContain('Pedir outras');
    expect(html).not.toContain('Usar esta<');
    const depois = painel({ tipo: 'reclamacao', dados, outra: true });
    expect(depois).toContain('Você já pediu outras sugestões para esta mensagem.');
    expect(depois).not.toContain('Pedir outras');
    expect(ficaramDeFora(dados)).toBeNull();
    expect(ficaramDeFora({ kind: 'reclamacao', dropped: 1 })).toBe('Uma sugestão ficou de fora na conferência.');
    expect(ficaramDeFora({ kind: 'reclamacao', dropped: 2 })).toBe('2 sugestões ficaram de fora na conferência.');
    expect(ficaramDeFora({ kind: 'pergunta', dropped: 1 })).toBeNull();
    expect(painel({ tipo: 'reclamacao', dados: { ...dados, suggestions: TRES.slice(0, 2), dropped: 1 } })).toContain('Uma sugestão ficou de fora na conferência.');
  });

  it('quando o Social media não sugeriu: a frase de cada motivo, e "Pedir de novo" só onde adianta', () => {
    expect(semIaDoDirect(semIa('sem-rota'))).toEqual({ texto: 'O Social media ainda não sugere respostas nas conversas. Por enquanto, escreva você.', deNovo: false });
    expect(semIaDoDirect(semIa('ia_desligada'))).toEqual({ texto: 'A IA está desligada para esta empresa. Escreva a resposta você.', deNovo: false });
    expect(semIaDoDirect(semIa('funcionario_desligado'))).toEqual({ texto: 'O Social media está desligado em Sua equipe. Escreva a resposta você.', deNovo: false });
    expect(semIaDoDirect(semIa('teto'))).toEqual({ texto: 'A IA chegou ao limite de gasto. Escreva a resposta você.', deNovo: false });
    expect(semIaDoDirect(semIa('teto', { retry_at: '2026-12-01T03:00:00Z' })).texto).toMatch(/^A IA chegou ao limite de gasto\. Ela volta em .+; até lá, escreva você\.$/);
    expect(semIaDoDirect(semIa('limite-usuario')).deNovo).toBe(true);
    expect(semIaDoDirect(semIa('entrada-grande')).deNovo).toBe(false);
    expect(semIaDoDirect(semIa('tipo_sem_ia'))).toEqual({ texto: 'O Social media só sugere resposta para pergunta e para reclamação. Escreva a resposta você.', deNovo: false });
    for (const motivo of ['barrado', 'formato'] as const) expect(semIaDoDirect(semIa(motivo))).toEqual({ texto: 'A sugestão do Social media não passou na conferência do Compliance. Peça outra, ou escreva você.', deNovo: true });
    for (const motivo of ['indisponivel', 'parada', 'travada'] as const) expect(semIaDoDirect(semIa(motivo))).toEqual({ texto: 'A IA não respondeu agora. Tente de novo em instantes, ou escreva você.', deNovo: true });
    // Um motivo que esta versão da tela não conhece (V23): a frase geral.
    expect(semIaDoDirect({ reason: 'algo_novo' as never, retry_at: null })).toEqual({ texto: 'O Social media não sugeriu agora. Peça de novo, ou escreva você.', deNovo: true });

    // Sem a rota do modelo (como nasce): a frase fica, e o botão de pedir sai.
    const semRota = painel({ aviso: semIaDoDirect(semIa('sem-rota')) });
    expect(semRota).toContain('O Social media ainda não sugere respostas nas conversas.');
    expect(semRota).not.toContain('<button');
    // A conferência barrou: a frase e "Pedir de novo".
    const barrado = painel({ aviso: semIaDoDirect(semIa('barrado')) });
    expect(barrado).toContain('não passou na conferência do Compliance');
    expect(barrado).toContain('Pedir de novo');
    expect(barrado).not.toContain('Pedir ao Social media');
    // O "Pedir outra" que não veio: a sugestão que já estava na tela continua, com o porquê.
    const outraFalhou = painel({ dados: resposta(), aviso: semIaDoDirect(semIa('teto')) });
    expect(outraFalhou).toContain('Oi! Entregamos na Penha');
    expect(outraFalhou).toContain('A IA chegou ao limite de gasto.');
    expect(outraFalhou).toContain('Usar esta');
    expect(outraFalhou).not.toContain('Pedir outra');
  });

  it('o pedido que nem chegou: a conversa deixou de esperar ou saiu do Liame (a tela lê de novo); a rede caída deixa pedir de novo', () => {
    expect(erroDaSugestao({ status: 409, code: 'conversa-nao-espera', title: 'x' })).toEqual({ texto: 'Esta conversa não espera mais resposta.', deNovo: false, reler: true });
    expect(erroDaSugestao({ status: 404, code: 'nao-encontrado', title: 'x' })).toEqual({ texto: 'A conversa não está mais no Liame.', deNovo: false, reler: true });
    expect(erroDaSugestao({ status: 0, code: 'sem-conexao', title: 'Sem conexão', detail: 'Não conseguimos falar com o Liame. Confira a internet e tente de novo.' })).toMatchObject({ deNovo: true, reler: false });
    expect(erroDaSugestao({ status: 503, code: 'sem-banco', title: 'Indisponível' })).toMatchObject({ deNovo: true, reler: false });
    expect(erroDaSugestao({ status: 403, code: 'sem-permissao', title: 'Sem permissão' })).toMatchObject({ deNovo: false, reler: false });
  });
});
