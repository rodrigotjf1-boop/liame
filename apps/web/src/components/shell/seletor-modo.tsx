'use client';

import { useAvisar } from '@/components/ui/avisos';
import { type Modo, useModo } from '@/lib/modo';

// Seletor Lite/Pro (protótipo geral aprovado): no topo; no celular, no rodapé da gaveta do menu.
// Aparece só nas telas que têm as duas visões (a escolha vale para todas elas).

export function SeletorModo({ className }: { className?: string }) {
  const { modo, definir } = useModo();
  const avisar = useAvisar();

  function escolher(m: Modo) {
    if (m === modo) return;
    definir(m);
    avisar(m === 'pro' ? 'Modo Pro: todos os números e tabelas.' : 'Modo Lite: o essencial; o resto fica em “Ver detalhes”.');
  }

  return (
    <div className={className ? `modo ${className}` : 'modo'} role="group" aria-label="Modo de exibição">
      <button type="button" aria-pressed={modo === 'lite'} onClick={() => escolher('lite')} title="Lite: o essencial; o resto em Ver detalhes">
        Lite
      </button>
      <button type="button" aria-pressed={modo === 'pro'} onClick={() => escolher('pro')} title="Pro: todos os números e tabelas">
        Pro
      </button>
    </div>
  );
}
