'use client';

import { useEffect, useState } from 'react';
import { Icone } from '@/components/ui/icone';
import { CHAVE_TEMA as CHAVE } from '@/lib/tema';

// Tema claro (Papel) ou escuro (Noite). Sem escolha, segue o sistema. A escolha é conveniência de quem
// usa este navegador: fica no localStorage, nunca dado de negócio (e o acesso pode falhar sem quebrar nada).

function temaAtual(): 'light' | 'dark' {
  const escolhido = document.documentElement.dataset.theme;
  if (escolhido === 'light' || escolhido === 'dark') return escolhido;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function BotaoTema() {
  const [tema, setTema] = useState<'light' | 'dark' | null>(null);
  useEffect(() => setTema(temaAtual()), []);

  function alternar() {
    const novo = temaAtual() === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = novo;
    try {
      localStorage.setItem(CHAVE, novo);
    } catch {
      // Navegador sem armazenamento: o tema vale só nesta visita.
    }
    setTema(novo);
  }

  const escuro = tema === 'dark';
  const rotulo = escuro ? 'Usar tema claro' : 'Usar tema escuro';
  return (
    <button className="btn btn--ghost btn--icon" type="button" onClick={alternar} aria-pressed={escuro} aria-label={rotulo} title={rotulo}>
      <Icone nome={escuro ? 'sun' : 'moon'} />
    </button>
  );
}

/** Aplica o tema salvo antes da primeira pintura (sem piscar o tema errado). */
