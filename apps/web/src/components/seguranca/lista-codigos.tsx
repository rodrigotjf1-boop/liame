'use client';

import { useState } from 'react';
import { Icone } from '@/components/ui/icone';
import { disparar } from '@/lib/disparar';

// Os 10 códigos de recuperação, mostrados uma vez só, com copiar e baixar (como na ativação do app).

export function baixarCodigos(codigos: string[]): void {
  const txt = `Liame · códigos de recuperação (cada um vale uma vez)\n\n${codigos.join('\n')}\n`;
  const url = URL.createObjectURL(new Blob([txt], { type: 'text/plain;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = 'liame-codigos-de-recuperacao.txt';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function ListaCodigos({ codigos }: { codigos: string[] }) {
  const [copiados, setCopiados] = useState(false);

  async function copiar() {
    try {
      await navigator.clipboard.writeText(codigos.join('\n'));
      setCopiados(true);
    } catch {
      // Sem acesso à área de transferência: a pessoa ainda pode baixar o arquivo ou anotar.
      setCopiados(false);
    }
  }

  return (
    <>
      <ol className="codigos" aria-label="Códigos de recuperação">
        {codigos.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ol>
      <div className="acoes-linha">
        <button className="btn btn--sm" type="button" onClick={() => disparar(copiar())}>
          <Icone nome="copy" pequeno />
          {copiados ? 'Copiados' : 'Copiar'}
        </button>
        <button className="btn btn--sm" type="button" onClick={() => baixarCodigos(codigos)}>
          <Icone nome="download" pequeno />
          Baixar arquivo
        </button>
      </div>
    </>
  );
}
