import type { ReactNode } from 'react';
import { Shell } from '@/components/shell/shell';
import { SessaoProvider } from '@/lib/sessao';

// App logado: a sessão vem da API (cookie httpOnly dela) e decide entre a tela, o segundo fator e a entrada.
export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <SessaoProvider>
      <Shell>{children}</Shell>
    </SessaoProvider>
  );
}
