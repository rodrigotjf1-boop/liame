import type { Metadata } from 'next';
import { Suspense } from 'react';
import { RelatorioTela } from '@/components/relatorio/relatorio-tela';

export const metadata: Metadata = { title: 'Relatório do mês · Liame' };

// A tela lê a marca e o mês na URL (?marca, ?mes, do link do e-mail do mês): com Cache Components, isso fica dentro de um Suspense.
export default function RelatorioPage() {
  return (
    <Suspense fallback={null}>
      <RelatorioTela />
    </Suspense>
  );
}
