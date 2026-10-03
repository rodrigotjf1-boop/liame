'use client';

import type { ExplanationResponse } from '@liame/contracts';
import { useCallback, useRef, useState } from 'react';
import type { Problema } from '@/lib/api';
import { type PedidoDeExplicacao, pedirExplicacao } from './pedir';

// O estado de uma explicação na tela: fechada, carregando, pronta ou com erro. Trocar o que está sendo
// explicado (outro período, outra marca) fecha a explicação aberta: ela era de outros números.

export type EstadoDaExplicacao =
  | { tipo: 'fechada' }
  | { tipo: 'carregando' }
  | { tipo: 'pronta'; resposta: ExplanationResponse }
  | { tipo: 'erro'; problema: Problema };

const FECHADA: EstadoDaExplicacao = { tipo: 'fechada' };

export function useExplicacao(pedido: PedidoDeExplicacao | null) {
  const chave = pedido ? JSON.stringify(pedido) : '';
  // A fase vale para a chave em que nasceu: com outra chave, a explicação está fechada.
  const [interno, setInterno] = useState<{ chave: string; id: number; fase: EstadoDaExplicacao }>({ chave, id: 0, fase: FECHADA });
  const contador = useRef(0);
  const estado = interno.chave === chave ? interno.fase : FECHADA;

  const pedir = useCallback(async () => {
    if (!pedido) return;
    const id = ++contador.current;
    setInterno({ chave, id, fase: { tipo: 'carregando' } });
    const r = await pedirExplicacao(pedido);
    // Só a resposta do último pedido vale (fechar ou pedir de novo no meio descarta a anterior).
    setInterno((atual) => (atual.id === id ? { chave, id, fase: r.ok ? { tipo: 'pronta', resposta: r.data } : { tipo: 'erro', problema: r.problema } } : atual));
    // `chave` é o próprio pedido em texto: o mesmo conteúdo dá a mesma função.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chave]);

  const fechar = useCallback(() => setInterno({ chave, id: ++contador.current, fase: FECHADA }), [chave]);

  return { estado, aberta: estado.tipo !== 'fechada', pedir, fechar };
}
