'use client';

import { useEffect, useState } from 'react';

/**
 * "Agora" da tela, atualizado a cada minuto (prazos e "há quanto tempo" andam sozinhos) e também quando
 * `marco` muda (dados novos chegaram: o prazo é calculado com o relógio do momento em que chegaram).
 */
export function useAgora(intervaloMs = 60_000, marco?: unknown): Date {
  const [agora, setAgora] = useState(() => new Date());
  useEffect(() => {
    setAgora(new Date());
    const t = setInterval(() => setAgora(new Date()), intervaloMs);
    return () => clearInterval(t);
  }, [intervaloMs, marco]);
  return agora;
}
