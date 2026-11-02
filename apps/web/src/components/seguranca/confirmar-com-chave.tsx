'use client';

import type { PasskeyAssertion } from '@liame/contracts';
import { useState } from 'react';
import { Icone } from '@/components/ui/icone';
import { api, chamar, mensagemDe } from '@/lib/api';
import { fraseDoMotivo, usarAChave } from '@/lib/chave-de-acesso';
import { disparar } from '@/lib/disparar';

// "Confirmar com a chave de acesso" (A7, W9, parte 9c; P28; D-A7-56): onde se pede o código do app, a chave vem
// primeiro. O botão pede o desafio de confirmação, abre a janela do aparelho e entrega a prova a quem chamou (que manda
// `passkey` no lugar de `code`). A falha de cada passo vira uma frase para a tela, com a alternativa de quem chamou.

type Props = {
  /** O que fazer com a prova (aprovar, gerar códigos…); devolve quando terminou. */
  aoProvar: (passkey: PasskeyAssertion) => Promise<void>;
  aoErro: (texto: string) => void;
  /** A outra saída, na frase de erro ("use o código do app"). */
  alternativa?: string;
  rotulo?: string;
  /** Quem chamou está enviando outra coisa (o código): o botão espera. */
  impedido?: boolean;
  primario?: boolean;
  /** O botão recebe o foco quando o passo abre (`data-foco`, lido por quem monta o diálogo). */
  focoInicial?: boolean;
};

export function ConfirmarComChave({
  aoProvar,
  aoErro,
  alternativa = 'use o código do app',
  rotulo = 'Confirmar com a chave de acesso',
  impedido = false,
  primario = true,
  focoInicial = false,
}: Props) {
  const [ocupado, setOcupado] = useState(false);

  async function confirmar() {
    setOcupado(true);
    try {
      const r = await chamar(() => api.POST('/v1/me/passkeys/confirmation-options'));
      if (!r.ok) return aoErro(mensagemDe(r.problema));
      const chave = await usarAChave(r.data.options);
      if (!chave.ok) return aoErro(fraseDoMotivo(chave.motivo, alternativa));
      await aoProvar({ challenge_id: r.data.challenge_id, response: chave.resposta });
    } finally {
      setOcupado(false);
    }
  }

  return (
    <button
      data-foco={focoInicial ? '' : undefined}
      className={`btn chave-acesso-confirmar${primario ? ' btn--primary' : ''}`}
      type="button"
      onClick={() => disparar(confirmar())}
      disabled={ocupado || impedido}
      aria-busy={ocupado}
    >
      <Icone nome="key" />
      {ocupado ? 'Esperando o aparelho…' : rotulo}
    </button>
  );
}
