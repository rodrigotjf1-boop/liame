import type { SecurityEvent, SecuritySummaryResponse, SessionResponse } from '@liame/contracts';
import { describe, expect, it } from 'vitest';
import {
  avisoDosCodigos,
  detalheDoAparelho,
  liberacao,
  ondeDoEvento,
  siglaDoAparelho,
  situacaoDoApp,
  textoDoEvento,
} from '@/components/seguranca/textos';
import { diaHora, quandoComHora } from '@/lib/formato';

// Regras puras da tela "Segurança da conta": situação do app, pedido de troca, aparelhos e atividade.
// Datas fixas no fuso local, nunca o relógio real (LIC-006, ERR-023).

const agora = new Date(2026, 8, 26, 21, 42, 0); // 26/09/2026 21:42
const local = (d: number, h: number, m = 0) => new Date(2026, 8, d, h, m).toISOString();

const resumo = (extra: Partial<SecuritySummaryResponse> = {}): SecuritySummaryResponse => ({
  mfa_enabled_since: local(20, 8, 5),
  session_mfa_method: 'totp',
  recovery_codes_left: 7,
  change_request: null,
  ...extra,
});

describe('situação do app autenticador', () => {
  it('as quatro situações do protótipo', () => {
    expect(situacaoDoApp(resumo())).toBe('app');
    expect(situacaoDoApp(resumo({ session_mfa_method: 'recuperacao' }))).toBe('recuperacao');
    expect(situacaoDoApp(resumo({ session_mfa_method: 'recuperacao', change_request: { usable_after: local(27, 21, 40), expires_at: local(29, 21, 40) } }))).toBe(
      'pedido',
    );
    expect(situacaoDoApp(resumo({ mfa_enabled_since: null, session_mfa_method: null, recovery_codes_left: 0 }))).toBe('sem-app');
  });

  it('pedido de troca: quando libera e quanto falta, arredondado para cima', () => {
    expect(liberacao(local(27, 21, 40), agora)).toEqual({ liberado: false, quando: 'amanhã, 27/09, às 21:40', falta: '23 h 58 min' });
    expect(liberacao(local(26, 23, 0), agora)).toEqual({ liberado: false, quando: 'hoje, às 23:00', falta: '1 h 18 min' });
    expect(liberacao(new Date(2026, 8, 26, 21, 42, 30).toISOString(), agora).falta).toBe('1 min');
    expect(liberacao(local(26, 22, 42), agora).falta).toBe('1 h');
    expect(liberacao(local(28, 9, 5), agora).quando).toBe('28/09, às 09:05');
    expect(liberacao(local(26, 21, 40), agora)).toMatchObject({ liberado: true, falta: '' });
  });

  it('aviso dos códigos que deixam de valer', () => {
    expect(avisoDosCodigos(7)).toBe('Os 7 códigos que ainda valem deixam de funcionar na hora.');
    expect(avisoDosCodigos(1)).toBe('O código que ainda vale deixa de funcionar na hora.');
    expect(avisoDosCodigos(0)).toBe('');
  });
});

describe('aparelhos conectados', () => {
  const sessao = (extra: Partial<SessionResponse>): SessionResponse => ({
    id: '0199a8f0-0000-7000-8000-000000000001',
    device: 'Chrome no Windows',
    ip: '177.52.18.x',
    created_at: local(20, 8, 10),
    last_seen_at: local(26, 21, 41),
    current: true,
    ...extra,
  });

  it('este aparelho e os outros, como no protótipo', () => {
    expect(detalheDoAparelho(sessao({}), agora)).toBe('IP 177.52.18.x · entrou em 20/09, 08:10 · agora');
    expect(detalheDoAparelho(sessao({ current: false, created_at: local(24, 19, 32), last_seen_at: local(25, 22, 5) }), agora)).toBe(
      'IP 177.52.18.x · entrou em 24/09, 19:32 · último acesso ontem, 22:05',
    );
    expect(detalheDoAparelho(sessao({ current: false, ip: null, last_seen_at: local(19, 10, 0) }), agora)).toBe('entrou em 20/09, 08:10 · último acesso 19/09');
  });

  it('sigla do aparelho', () => {
    expect(siglaDoAparelho('Safari no iPhone')).toBe('CEL');
    expect(siglaDoAparelho('Chrome no Android')).toBe('CEL');
    expect(siglaDoAparelho('Safari no iPad')).toBe('TAB');
    expect(siglaDoAparelho('Edge no Windows')).toBe('PC');
    expect(siglaDoAparelho('Aparelho desconhecido')).toBe('?');
  });
});

describe('atividade de segurança', () => {
  const evento = (action: string, extra: Partial<SecurityEvent> = {}): SecurityEvent => ({
    action,
    occurred_at: local(26, 8, 10),
    device: 'Chrome no Windows',
    ip: '177.52.18.x',
    detail: null,
    ...extra,
  });

  it('texto de cada ação e o que merece atenção', () => {
    expect(textoDoEvento(evento('segundo_fator.verificar', { detail: 'totp' }))).toEqual({ texto: 'Entrou com o app autenticador', alerta: false });
    expect(textoDoEvento(evento('segundo_fator.verificar', { detail: 'recuperacao' })).texto).toBe('Usou um código de recuperação');
    expect(textoDoEvento(evento('sessao.falhar'))).toEqual({ texto: 'Senha errada', alerta: true });
    expect(textoDoEvento(evento('segundo_fator.ativar')).texto).toBe('Ativou o app autenticador');
    expect(textoDoEvento(evento('sessao.encerrar', { device: 'Safari no iPhone', ip: null })).texto).toBe('Desconectou Safari no iPhone');
    expect(textoDoEvento(evento('senha.redefinir')).texto).toBe('Trocou a senha');
    expect(textoDoEvento(evento('acao.nova_que_ainda_nao_existe')).texto).toBe('Outra ação de segurança');
  });

  it('onde aconteceu', () => {
    expect(ondeDoEvento(evento('sessao.abrir'))).toBe('Chrome no Windows · 177.52.18.x');
    expect(ondeDoEvento(evento('segundo_fator.verificar', { device: null, ip: null }))).toBe('—');
    expect(ondeDoEvento(evento('sessao.encerrar', { device: 'Safari no iPhone', ip: null }))).toBe('—');
  });

  it('quando, sempre com a hora', () => {
    expect(quandoComHora(local(26, 8, 10), agora)).toBe('hoje, 08:10');
    expect(quandoComHora(local(25, 23, 47), agora)).toBe('ontem, 23:47');
    expect(quandoComHora(local(24, 19, 32), agora)).toBe('24/09, 19:32');
    expect(diaHora(new Date(2025, 11, 31, 9, 0).toISOString(), agora)).toBe('31/12/2025, 09:00');
  });
});
