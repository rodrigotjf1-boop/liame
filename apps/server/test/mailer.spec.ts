import { describe, expect, it } from 'vitest';
import { enderecoDoRemetente, loadConfig } from '../src/config.js';
import { createMailer, MemoryMailer, SesMailer, type SesSendInput } from '../src/mail/mailer.js';

// Transporte de e-mail: o pedido que chega ao SES (sem rede: a função de envio é trocada por uma que registra).
describe('e-mail pelo SES', () => {
  it('monta o pedido do SES v2: remetente, um destinatário, assunto e texto em UTF-8, conjunto de configuração', async () => {
    const pedidos: SesSendInput[] = [];
    const mailer = new SesMailer('Liame <nao-responda@agencialiame.com>', async (input) => (pedidos.push(input), { MessageId: 'm-1' }), 'liame-transacional');
    await mailer.send({ to: 'pessoa@exemplo.com.br', subject: 'Liame: confirme o seu e-mail', text: 'Olá, ação necessária: çãõ' });
    expect(pedidos).toEqual([
      {
        FromEmailAddress: 'Liame <nao-responda@agencialiame.com>',
        Destination: { ToAddresses: ['pessoa@exemplo.com.br'] },
        Content: {
          Simple: {
            Subject: { Data: 'Liame: confirme o seu e-mail', Charset: 'UTF-8' },
            Body: { Text: { Data: 'Olá, ação necessária: çãõ', Charset: 'UTF-8' } },
          },
        },
        ConfigurationSetName: 'liame-transacional',
      },
    ]);
  });

  it('com a versão em HTML, o pedido leva as duas: o texto continua indo, para quem não mostra HTML', async () => {
    const pedidos: SesSendInput[] = [];
    const mailer = new SesMailer('Liame <nao-responda@agencialiame.com>', async (input) => (pedidos.push(input), { MessageId: 'm-2' }));
    await mailer.send({ to: 'pessoa@exemplo.com.br', subject: 'Liame: revisão da semana', text: 'Revisão em texto', html: '<p>Revisão em HTML: ção</p>' });
    expect(pedidos[0]!.Content.Simple.Body).toEqual({
      Text: { Data: 'Revisão em texto', Charset: 'UTF-8' },
      Html: { Data: '<p>Revisão em HTML: ção</p>', Charset: 'UTF-8' },
    });
    // Sem HTML (os e-mails de acesso), o campo não vai: o pedido é o de sempre.
    await mailer.send({ to: 'pessoa@exemplo.com.br', subject: 's', text: 't' });
    expect(pedidos[1]!.Content.Simple.Body).toEqual({ Text: { Data: 't', Charset: 'UTF-8' } });
  });

  it('sem conjunto de configuração, o campo não vai; erro do SES chega a quem chamou', async () => {
    const pedidos: SesSendInput[] = [];
    await new SesMailer('nao-responda@agencialiame.com', async (input) => (pedidos.push(input), {})).send({ to: 'a@b.co', subject: 's', text: 't' });
    expect(pedidos[0]).not.toHaveProperty('ConfigurationSetName');
    const recusa = Object.assign(new Error('Email address is not verified.'), { name: 'MessageRejected' });
    await expect(new SesMailer('nao-responda@agencialiame.com', async () => Promise.reject(recusa)).send({ to: 'a@b.co', subject: 's', text: 't' })).rejects.toThrow('not verified');
  });

  it('o transporte sai da configuração: memória por padrão, SES com MAIL_TRANSPORT=ses', async () => {
    expect(await createMailer(loadConfig({ NODE_ENV: 'test' } as NodeJS.ProcessEnv))).toBeInstanceOf(MemoryMailer);
    const ses = await createMailer(loadConfig({ NODE_ENV: 'test', MAIL_TRANSPORT: 'ses' } as NodeJS.ProcessEnv));
    expect(ses).toBeInstanceOf(SesMailer);
  });

  it('remetente: com ou sem nome; o endereço sai em minúsculas; o que não é e-mail é recusado', () => {
    expect(enderecoDoRemetente('Liame <Nao-Responda@AgenciaLiame.com>')).toBe('nao-responda@agencialiame.com');
    expect(enderecoDoRemetente('nao-responda@agencialiame.com')).toBe('nao-responda@agencialiame.com');
    expect(enderecoDoRemetente('Liame')).toBeNull();
    expect(enderecoDoRemetente('Liame <sem-arroba>')).toBeNull();
    expect(enderecoDoRemetente('a <b@c.com> <d@e.com>')).toBeNull();
    const c = loadConfig({ NODE_ENV: 'test', MAIL_FROM: 'Liame <nao-responda@agencialiame.com>', SES_CONFIGURATION_SET: 'liame-transacional' } as NodeJS.ProcessEnv);
    expect(c.mail).toEqual({ from: 'Liame <nao-responda@agencialiame.com>', fromAddress: 'nao-responda@agencialiame.com', region: 'sa-east-1', configurationSet: 'liame-transacional' });
  });
});
