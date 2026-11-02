import type { Passkey } from '@liame/contracts';
import { dataCompleta, quandoComHora } from '@/lib/formato';

// As frases do cartão "Chaves de acesso" em Segurança da conta (A7, W9, parte 9c1; P28 aprovado,
// mockups/prototipo-chaves-de-acesso.html; D-A7-54 a D-A7-58). Funções puras: o "agora" entra como parâmetro (LIC-006).

/** O máximo de chaves por pessoa (D-A7-54); o servidor também confere. */
export const MAX_CHAVES = 10;

export function subtituloDasChaves(n: number): string {
  const base = 'Entre sem senha e confirme com a digital, o rosto ou o PIN do aparelho.';
  return n ? `${base} ${n} ${n === 1 ? 'chave' : 'chaves'}.` : base;
}

export function rotuloDeCriar(n: number): string {
  return n ? 'Criar outra chave' : 'Criar uma chave de acesso';
}

/** "Criada em 12/10/2026 · último uso: hoje, 08:10 · Chrome no Windows" (ou "ainda não usada"). */
export function detalheDaChave(k: Passkey, agora: Date): string {
  const uso = k.last_used_at ? [quandoComHora(k.last_used_at, agora), k.last_used_where].filter(Boolean).join(' · ') : 'ainda não usada';
  return `Criada em ${dataCompleta(k.created_at)} · último uso: ${uso}`;
}

export function sobreACopia(k: Passkey): string {
  return k.synced ? 'Aparece nos aparelhos da mesma conta do Google ou da Apple.' : 'Fica só neste aparelho ou nesta chave física.';
}

export function seloDaCopia(k: Passkey): { tom: 'concluido' | 'espera'; texto: string } {
  return k.synced ? { tom: 'concluido', texto: 'Sincronizada' } : { tom: 'espera', texto: 'Só neste aparelho' };
}

/** A confirmação na linha antes de tirar. */
export function textoDeTirar(ultima: boolean): string {
  return ultima ? 'Tirar a última chave? Você volta a entrar com a senha e o código do app.' : 'Tirar esta chave? Ela deixa de abrir a sua conta.';
}

/** A última chave sem o app não sai (D-A7-57): o servidor também recusa (409 `ultima-chave`). */
export const BLOQUEIO_DA_ULTIMA =
  'Esta é a sua única chave, e o app autenticador não está ativo: tirar fecharia a sua entrada. Ative o app ou crie outra chave antes.';

export const AVISO_DE_TIRADA = 'Chave tirada. Ela ainda aparece no gerenciador do aparelho: apague lá também. Mandamos um aviso para o seu e-mail.';

export const AVISO_DE_CRIADA = 'Chave criada. Mandamos um aviso para o seu e-mail.';

/** O nome digitado: de 1 a 60 letras (o servidor confere o mesmo). */
export function erroDoNome(nome: string): string {
  const n = nome.trim();
  if (!n) return 'Dê um nome à chave, como "Celular do trabalho".';
  if (n.length > 60) return 'O nome tem até 60 letras.';
  return '';
}

/** Os passos da gaveta "Criar uma chave de acesso". */
export const PASSOS_DE_CRIAR = ['Confirmar que é você', 'O seu aparelho', 'O nome da chave'] as const;

/** O texto do app autenticador para quem entra só com chave (o protótipo, "Só com chave, sem o app"). */
export const APP_PARA_QUEM_TEM_CHAVE =
  'Você entra com as chaves de acesso. O app é opcional, mas é com ele, ou com os códigos de recuperação, que você entra se perder todos os aparelhos com chave.';

/** O texto dos códigos de recuperação, com o app ou só com chave. */
export function textoDosCodigos(temApp: boolean): string {
  return temApp
    ? 'Usou vários ou acha que alguém viu? Gere códigos novos: os antigos deixam de valer na hora. Pedimos o código do app ou a chave de acesso para confirmar.'
    : 'Sem o app, eles são a sua saída se perder os aparelhos com chave. Guarde num lugar seguro, fora do celular.';
}
