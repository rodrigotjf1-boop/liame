import type { MonthlyReportFromAgency } from '@liame/contracts';
import { describe, expect, it } from 'vitest';
import { avisoDeSalvo, emailValido, iniciaisDaAgencia, mudancasDaMarca, problemaDoArquivo, situacaoDaResposta } from '../src/components/agencia/marca-textos';
import { detalheDaAgencia, tituloDaAgencia } from '../src/components/relatorio/da-agencia';

// A marca da agência e o que ela mandou no relatório do dono (A7, W7, parte 5a; P29 aprovado): as frases e as contas da
// tela, que só mostram o que o servidor decide.

const MARCA = { name: 'Agência Fogo', reply_to: null, pending_reply_to: null, report_mode: 'revisar' as const };

describe('a marca da agência', () => {
  it('o e-mail de resposta: confirmado, esperando o link, os dois ou nenhum', () => {
    expect(situacaoDaResposta({ reply_to: null, pending_reply_to: null })).toEqual([]);
    expect(situacaoDaResposta({ reply_to: { email: 'a@x.com', confirmed_at: '2026-10-20T15:00:00Z' }, pending_reply_to: null })).toEqual([
      { tom: 'concluido', texto: 'a@x.com: confirmado em 20/10/2026' },
    ]);
    expect(
      situacaoDaResposta({ reply_to: { email: 'a@x.com', confirmed_at: '2026-10-20T15:00:00Z' }, pending_reply_to: { email: 'b@x.com', expires_at: '2026-11-03T12:00:00Z' } }).map(
        (s) => s.tom,
      ),
    ).toEqual(['concluido', 'aguardando']);
  });

  it('o arquivo do logo: só PNG ou JPG, até 1 MB (SVG nunca)', () => {
    expect(problemaDoArquivo({ type: 'image/png', size: 200_000 })).toBeNull();
    expect(problemaDoArquivo({ type: 'image/jpeg', size: 1024 * 1024 })).toBeNull();
    expect(problemaDoArquivo({ type: 'image/svg+xml', size: 1000 })).toContain('SVG não vale');
    expect(problemaDoArquivo({ type: 'image/webp', size: 1000 })).toContain('PNG ou JPG');
    expect(problemaDoArquivo({ type: 'image/png', size: 1024 * 1024 + 1 })).toContain('passa de 1 MB');
  });

  it('o que vai no PATCH: só o que mudou; o e-mail vazio tira; o mesmo e-mail pendente não manda outro link', () => {
    expect(mudancasDaMarca(MARCA, { nome: ' Agência Fogo ', resposta: '', modo: 'revisar' })).toEqual({});
    expect(mudancasDaMarca(MARCA, { nome: 'Agência Brasa', resposta: 'Contato@Fogo.com ', modo: 'sozinho' })).toEqual({
      name: 'Agência Brasa',
      reply_to_email: 'contato@fogo.com',
      report_mode: 'sozinho',
    });
    const comEmail = { ...MARCA, reply_to: { email: 'a@x.com', confirmed_at: '2026-10-20T15:00:00Z' } };
    expect(mudancasDaMarca(comEmail, { nome: 'Agência Fogo', resposta: '', modo: 'revisar' })).toEqual({ reply_to_email: null });
    const pendente = { ...comEmail, pending_reply_to: { email: 'b@x.com', expires_at: '2026-11-03T12:00:00Z' } };
    expect(mudancasDaMarca(pendente, { nome: 'Agência Fogo', resposta: 'b@x.com', modo: 'revisar' })).toEqual({});
    expect(emailValido('contato@fogo.com')).toBe(true);
    expect(emailValido('contato@fogo')).toBe(false);
  });

  it('o aviso depois de salvar e as iniciais no lugar do logo', () => {
    expect(avisoDeSalvo({ reply_to_email: 'b@x.com' })).toBe('Marca salva. Mandamos um link para b@x.com: o e-mail novo vale depois da confirmação.');
    expect(avisoDeSalvo({ name: 'X' })).toBe('Marca salva. Vale para os próximos relatórios.');
    expect(iniciaisDaAgencia('Agência Fogo')).toBe('FO');
    expect(iniciaisDaAgencia('Estúdio Sol Nascente')).toBe('ES');
    expect(iniciaisDaAgencia('Agência Brasa Viva')).toBe('BV');
  });
});

describe('o que a agência mandou, no relatório do dono', () => {
  const AGORA = new Date('2026-11-02T15:00:00Z');
  const base: MonthlyReportFromAgency = {
    agency_name: 'Agência Fogo',
    logo_url: null,
    version: 1,
    sent_at: '2026-11-02T12:40:00Z',
    sent_by_name: 'Juliana Prado',
    comment: 'Outubro foi o melhor mês.',
  };

  it('quem mandou, quando e se é a versão corrigida', () => {
    expect(tituloDaAgencia(base, AGORA)).toMatch(/^Agência Fogo mandou este relatório hoje, \d{2}:\d{2}$/);
    expect(tituloDaAgencia({ ...base, version: 2 }, AGORA)).toMatch(/, na versão corrigida$/);
    expect(detalheDaAgencia(base)).toBe('Com um comentário de Juliana Prado.');
    expect(detalheDaAgencia({ ...base, comment: null })).toBe('Mandado por Juliana Prado, sem comentário.');
    expect(detalheDaAgencia({ ...base, comment: null, sent_by_name: null })).toBe('Saiu sozinho, no dia 2, sem comentário.');
  });
});
