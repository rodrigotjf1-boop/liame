'use client';

import { useTermos } from '@/lib/entrada';

// Rodapé das telas de entrada: termos vigentes (da API) e quem presta o serviço (CLAUDE.md §6).
export function RodapeLegal() {
  const { termos } = useTermos();
  return (
    <footer className="rodape-legal">
      {termos && (
        <>
          <a href={termos.terms_url} target="_blank" rel="noopener noreferrer">
            Termos de Uso
          </a>
          <a href={termos.privacy_url} target="_blank" rel="noopener noreferrer">
            Privacidade
          </a>
        </>
      )}
      <span>SISTER TECNOLOGIA LTDA</span>
    </footer>
  );
}
