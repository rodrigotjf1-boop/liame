import type { Metadata } from 'next';
import { Suspense } from 'react';
import { CobrancaTela } from '@/components/cobranca/cobranca-tela';

export const metadata: Metadata = { title: 'Plano e cobrança · Liame' };

// A tela lê a marca a abrir na URL (?marca, do e-mail do atraso): com Cache Components, isso fica dentro de um Suspense.
export default function CobrancaPage() {
  return (
    <Suspense fallback={null}>
      <CobrancaTela />
    </Suspense>
  );
}
