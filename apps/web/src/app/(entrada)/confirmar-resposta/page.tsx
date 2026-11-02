import type { Metadata } from 'next';
import { Suspense } from 'react';
import { TelaConfirmarResposta } from '@/components/entrada/tela-confirmar-resposta';

export const metadata: Metadata = { title: 'Confirmar o e-mail de resposta · Liame' };

// O link do e-mail de resposta da agência (A7, W7, parte 5a). A tela lê a URL (o token): fica dentro de um Suspense.
export default function Pagina() {
  return (
    <Suspense fallback={null}>
      <TelaConfirmarResposta />
    </Suspense>
  );
}
