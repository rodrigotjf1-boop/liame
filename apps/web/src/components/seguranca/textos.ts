import type { SecurityEvent, SecuritySummaryResponse, SessionResponse } from '@liame/contracts';
import { diaHora, diasAte, horaDe, quando } from '@/lib/formato';

// Regras e frases da tela "Segurança da conta" (mockups/prototipo-seguranca.html). Funções puras: o
// "agora" entra como parâmetro (LIC-006), nunca o relógio de dentro.

/** Situação do app autenticador, como as quatro do protótipo. */
export type SituacaoApp = 'app' | 'recuperacao' | 'pedido' | 'sem-app';

export function situacaoDoApp(r: SecuritySummaryResponse): SituacaoApp {
  if (!r.mfa_enabled_since) return 'sem-app';
  if (r.change_request) return 'pedido';
  if (r.session_mfa_method === 'recuperacao') return 'recuperacao';
  return 'app';
}

/**
 * Quando o pedido de troca do app libera: "amanhã, 27/09, às 21:40" e quanto falta ("23 h 58 min",
 * arredondado para cima, para nunca mostrar "0 min" antes da hora).
 */
export function liberacao(usableAfter: string, agora: Date): { liberado: boolean; quando: string; falta: string } {
  const restante = new Date(usableAfter).getTime() - agora.getTime();
  const dias = diasAte(usableAfter, agora);
  const d = new Date(usableAfter);
  const data = `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;
  const quandoLibera =
    dias === 0 ? `hoje, às ${horaDe(usableAfter)}` : dias === 1 ? `amanhã, ${data}, às ${horaDe(usableAfter)}` : `${data}, às ${horaDe(usableAfter)}`;
  if (restante <= 0) return { liberado: true, quando: quandoLibera, falta: '' };
  const minutos = Math.ceil(restante / 60_000);
  const h = Math.floor(minutos / 60);
  const m = minutos % 60;
  const falta = h ? (m ? `${h} h ${m} min` : `${h} h`) : `${m} min`;
  return { liberado: false, quando: quandoLibera, falta };
}

/** Sigla do aparelho no quadradinho da lista (PC, CEL, TAB). */
export function siglaDoAparelho(device: string): string {
  if (/iPhone|Android/.test(device)) return 'CEL';
  if (/iPad/.test(device)) return 'TAB';
  if (/desconhecido/i.test(device)) return '?';
  return 'PC';
}

/** "IP 177.52.18.x · entrou em 20/09, 08:10 · agora" (este aparelho) ou "· último acesso ontem, 22:05". */
export function detalheDoAparelho(s: SessionResponse, agora: Date): string {
  const partes = [
    ...(s.ip ? [`IP ${s.ip}`] : []),
    `entrou em ${diaHora(s.created_at, agora)}`,
    s.current ? 'agora' : `último acesso ${quando(s.last_seen_at, agora)}`,
  ];
  return partes.join(' · ');
}

/** O que aconteceu, em palavras da pessoa; `alerta` marca o que merece atenção (senha errada). */
export function textoDoEvento(e: SecurityEvent): { texto: string; alerta: boolean } {
  switch (e.action) {
    case 'sessao.abrir':
      return { texto: 'Entrou com a senha', alerta: false };
    case 'sessao.falhar':
      return { texto: 'Senha errada', alerta: true };
    case 'segundo_fator.verificar':
      if (e.detail === 'recuperacao') return { texto: 'Usou um código de recuperação', alerta: false };
      return { texto: 'Entrou com o app autenticador', alerta: false };
    case 'segundo_fator.ativar':
      return { texto: 'Ativou o app autenticador', alerta: false };
    case 'segundo_fator.pedir_troca':
      return { texto: 'Pediu a troca do app autenticador', alerta: false };
    case 'segundo_fator.gerar_codigos':
      return { texto: 'Gerou códigos de recuperação novos', alerta: false };
    case 'sessao.encerrar':
      return { texto: e.device ? `Desconectou ${e.device}` : 'Desconectou um aparelho', alerta: false };
    case 'sessao.encerrar_outras':
      return { texto: 'Saiu de todos os outros aparelhos', alerta: false };
    case 'senha.redefinir':
      return { texto: 'Trocou a senha', alerta: false };
    case 'email.confirmar':
      return { texto: 'Confirmou o e-mail', alerta: false };
    default:
      return { texto: 'Outra ação de segurança', alerta: false };
  }
}

/** Onde aconteceu: "Chrome no Windows · 177.52.18.x", ou um traço quando a API não sabe. */
export function ondeDoEvento(e: SecurityEvent): string {
  // No "desconectou", o aparelho já está no texto: ele é o alvo, não onde a pessoa estava.
  const aparelho = e.action === 'sessao.encerrar' ? null : e.device;
  return [aparelho, e.ip].filter(Boolean).join(' · ') || '—';
}

/** "Os 7 códigos que ainda valem deixam de funcionar na hora." (vazio quando não há nenhum). */
export function avisoDosCodigos(restantes: number): string {
  if (restantes <= 0) return '';
  if (restantes === 1) return 'O código que ainda vale deixa de funcionar na hora.';
  return `Os ${restantes} códigos que ainda valem deixam de funcionar na hora.`;
}
