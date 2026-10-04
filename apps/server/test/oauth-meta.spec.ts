import { describe, expect, it } from 'vitest';
import { configuracaoDaMeta, urlDeAutorizacao } from '../src/connections/oauth.js';

// A4: o login da Meta tem duas configurações no mesmo app. A de leitura é a de todo mundo (a análise da Meta usa
// ela); a de escrita, que também pede para gerenciar anúncios, só entra para a empresa com a escrita ligada.

const meta = { appId: '1234567890123', appSecret: 'segredo-do-app-meta-teste', configId: '99887766554433', writeConfigId: '11223344556677', dialogUrl: 'https://www.facebook.com' };

describe('login da Meta: configuração de leitura ou de escrita', () => {
  it('a de escrita só entra com a escrita ligada para a empresa e quando a distribuição a configurou', () => {
    expect(configuracaoDaMeta(meta, true)).toEqual({ configId: '11223344556677', acesso: 'escrita' });
    expect(configuracaoDaMeta(meta, false)).toEqual({ configId: '99887766554433', acesso: 'leitura' });
    // Sem a configuração de escrita, a flag sozinha não muda o que a empresa autoriza (nem o que a auditoria diz).
    expect(configuracaoDaMeta({ ...meta, writeConfigId: null }, true)).toEqual({ configId: '99887766554433', acesso: 'leitura' });
  });

  it('a página de autorização leva a configuração escolhida; sem escolha, a de leitura', () => {
    const config = { oauth: { meta, google: null, regem: null } };
    const p = { estado: 'estado-de-teste', redirectUri: 'https://api.agencialiame.com/v1/oauth/callback', versaoMeta: 'v26.0' };
    const pedida = (url: string) => new URL(url).searchParams.get('config_id');
    expect(pedida(urlDeAutorizacao('meta', config, p))).toBe('99887766554433');
    expect(pedida(urlDeAutorizacao('meta', config, { ...p, configMeta: '11223344556677' }))).toBe('11223344556677');
    // A configuração é da Meta: nas outras plataformas ela não entra na página.
    const google = { oauth: { meta, google: { clientId: 'cliente-google-teste.apps.googleusercontent.com', clientSecret: 'segredo-cliente-google-teste', authUrl: 'https://accounts.google.com', tokenUrl: 'https://oauth2.googleapis.com' }, regem: null } };
    expect(pedida(urlDeAutorizacao('google', google, { ...p, verificador: 'verificador-de-teste', configMeta: '11223344556677' }))).toBeNull();
  });
});
