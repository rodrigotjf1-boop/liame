import { describe, expect, it } from 'vitest';
import { type DadosDoEmail, emailDaRetirada, emailDoAviso, emailDoLembrete } from '../src/auth/termos/emails.js';

// Os e-mails dos Termos novos (A7, W14, parte 14c; D-A7-90), sem banco: as frases do P35 aprovado, a do Dono e a de quem
// não é, a véspera para cancelar sem multa, a contagem dos dias do lembrete e a retirada.

const dados: DadosDoEmail = {
  nome: 'Rodrigo',
  dono: true,
  valeEm: '2026-12-02',
  avisoEm: '2026-11-02',
  diasQueFaltam: 7,
  mudancas: [
    { document: 'termos', section: '4', title: 'Agências parceiras', today: 'Só a empresa.', becomes: 'Uma agência aceita pelo Dono age em nome da empresa.' },
    { document: 'privacidade', section: '4', title: 'Chaves de acesso', today: 'A senha.', becomes: 'Guardamos só a chave pública.' },
  ],
  link: 'https://app.agencialiame.com',
};

describe('os e-mails dos Termos novos', () => {
  it('o aviso: o dia, o que muda por documento e seção, nada para trás, o link e o cancelar sem multa até a véspera (Dono)', () => {
    const e = emailDoAviso(dados);
    expect(e.subject).toBe('Os Termos do Liame mudam em 02/12/2026');
    expect(e.text).toContain('Olá, Rodrigo.');
    expect(e.text).toContain('mudam em 02/12/2026. Até lá, valem os de hoje.');
    expect(e.text).toContain('- Agências parceiras (Termos de Uso · 4): Uma agência aceita pelo Dono age em nome da empresa.');
    expect(e.text).toContain('- Chaves de acesso (Política de Privacidade · 4): Guardamos só a chave pública.');
    expect(e.text).toContain('Nada muda para trás');
    expect(e.text).toContain('https://app.agencialiame.com');
    expect(e.text).toContain('Você pode cancelar a assinatura sem multa até 01/12/2026, em Plano e cobrança.');
    expect(e.text).toContain('Em 02/12/2026, quem ainda não tiver aceitado vê a tela do aceite ao entrar');
  });

  it('para quem não é o Dono, a linha do cancelar manda falar com o Dono', () => {
    const e = emailDoAviso({ ...dados, dono: false });
    expect(e.text).toContain('Não concorda? Fale com o Dono da empresa: só ele cancela a assinatura.');
    expect(e.text).not.toContain('sem multa até');
  });

  it('o lembrete conta os dias que faltam (e o último dia no singular)', () => {
    expect(emailDoLembrete({ ...dados, diasQueFaltam: 5 }).subject).toBe('Faltam 5 dias para os Termos novos do Liame');
    expect(emailDoLembrete({ ...dados, diasQueFaltam: 1 }).subject).toBe('Falta 1 dia para os Termos novos do Liame');
    expect(emailDoLembrete(dados).text).toContain('valem em 02/12/2026, e você ainda não aceitou');
  });

  it('a retirada: o dia do aviso, nada muda, e o aceite dado fica sem efeito', () => {
    const e = emailDaRetirada(dados);
    expect(e.subject).toBe('A mudança dos Termos do Liame foi cancelada');
    expect(e.text).toContain('que avisamos em 02/11/2026 não vai acontecer');
    expect(e.text).toContain('esse aceite fica sem efeito');
  });
});
