'use client';

import { type RefObject, useCallback, useEffect, useRef } from 'react';

/**
 * Diálogo nativo (`<dialog>`) aberto ao montar, com o foco no elemento pedido e de volta em quem abriu
 * ao fechar. Se quem abriu sumiu da tela (linha removida), o foco vai para a reserva (o título da tela).
 * O modo estrito do React roda o efeito duas vezes: por isso a guarda do `open`.
 */
export function useDialogo({
  focoInicial,
  reserva,
}: {
  focoInicial?: RefObject<HTMLElement | null>;
  reserva?: RefObject<HTMLElement | null>;
} = {}) {
  const ref = useRef<HTMLDialogElement>(null);
  const origem = useRef<Element | null>(null);

  useEffect(() => {
    const d = ref.current;
    if (!d || d.open) return;
    origem.current = document.activeElement;
    d.showModal();
    focoInicial?.current?.focus();
    // Só na montagem: o diálogo abre uma vez e fecha pelo `close` (refs não mudam entre renders).
  }, [focoInicial]);

  const fechar = useCallback(() => ref.current?.close(), []);

  const devolverFoco = useCallback(() => {
    const alvo = origem.current;
    if (alvo instanceof HTMLElement && alvo.isConnected) alvo.focus({ preventScroll: true });
    else reserva?.current?.focus({ preventScroll: true });
  }, [reserva]);

  return { ref, fechar, devolverFoco };
}
