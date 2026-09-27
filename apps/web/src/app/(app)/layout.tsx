import { connection } from 'next/server';
import type { ReactNode } from 'react';
import { Shell } from '@/components/shell/shell';
import { SessaoProvider } from '@/lib/sessao';

// App logado: a sessão vem da API (cookie httpOnly dela) e decide entre a tela, o segundo fator e a entrada.
// Renderizado a cada acesso (sem casca pré-renderizada): é o que permite a CSP com nonce do proxy, que o
// Next aplica aos scripts da página. O conteúdo é da sessão, então a pré-renderização quase não ajudava.
export const instant = false;

export default async function AppLayout({ children }: { children: ReactNode }) {
  await connection();
  return (
    <SessaoProvider>
      <Shell>{children}</Shell>
    </SessaoProvider>
  );
}
