import Link from 'next/link';
import type { ReactNode } from 'react';
import { LiaProvider, PalcoLia } from '@/components/entrada/lia';
import { RodapeLegal } from '@/components/entrada/rodape-legal';
import { LogoCompleto } from '@/components/marca/logo';

// Telas de entrada (mockups/prototipo-entrada.html, caminho B "Painel com a marca", aprovado em 26/09/2026):
// formulário à esquerda, palco com a LIA à direita. No celular e no tablet, só o avatar 2D ao lado do logo.

/** Cor do palco no tema claro: "noite" (sempre escuro) ou "tema" (acompanha). Aguarda o dono (ux §10.3, item 2). */
const PALCO: 'noite' | 'tema' = 'noite';

export default function EntradaLayout({ children }: { children: ReactNode }) {
  return (
    <LiaProvider>
      <div className="entrada" data-palco={PALCO}>
        <main className="coluna" id="conteudo">
          <div className="coluna-topo">
            <Link href="/entrar" aria-label="Liame: entrar">
              <LogoCompleto />
            </Link>
            <span className="lia-mini" aria-hidden="true">
              <img src="/lia/lia-avatar.svg" alt="" width={36} height={36} />
            </span>
          </div>
          <div className="miolo">{children}</div>
          <RodapeLegal />
        </main>
        <PalcoLia />
      </div>
    </LiaProvider>
  );
}
