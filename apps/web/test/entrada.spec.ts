import type { MeResponse } from '@liame/contracts';
import { describe, expect, it } from 'vitest';
import { destinoDepoisDeEntrar, voltaSegura } from '@/lib/entrada';

// Para onde a pessoa vai depois de entrar: só caminhos do próprio app, e o segundo fator antes de tudo.

describe('voltaSegura', () => {
  it('aceita caminhos do app, com ou sem consulta', () => {
    expect(voltaSegura('/pessoas')).toBe('/pessoas');
    expect(voltaSegura('/convite?token=abc')).toBe('/convite?token=abc');
  });

  it('recusa endereço de fora, "//outro-site" e barra invertida (redirecionamento aberto)', () => {
    for (const ruim of ['https://phishing.example', '//phishing.example', '/\\phishing.example', 'javascript:alert(1)', '', null, undefined]) {
      expect(voltaSegura(ruim)).toBe('/');
    }
  });
});

describe('destinoDepoisDeEntrar', () => {
  const me = (mfa: MeResponse['mfa'], mfa_enrollment_required = false): MeResponse => ({
    user: { id: '00000000-0000-0000-0000-000000000001', name: 'Ana', email: 'ana@example.com' },
    organizations: [],
    active_organization_id: null,
    mfa,
    mfa_enrollment_required,
    permissions: [],
  });

  it('com o app configurado, pede o código antes da tela', () => {
    expect(destinoDepoisDeEntrar(me('required'), '/pessoas')).toBe('/segundo-fator?volta=%2Fpessoas');
  });

  it('nível que exige o app e ainda não tem: vai ativar', () => {
    expect(destinoDepoisDeEntrar(me('not_configured', true), '/convite?token=x')).toBe('/segundo-fator/ativar?volta=%2Fconvite%3Ftoken%3Dx');
  });

  it('sessão confirmada (ou nível sem exigência): segue para onde ia', () => {
    expect(destinoDepoisDeEntrar(me('verified'), '/pessoas')).toBe('/pessoas');
    expect(destinoDepoisDeEntrar(me('not_configured'), '/')).toBe('/');
  });
});
