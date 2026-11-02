import type { Metadata } from 'next';
import { Suspense } from 'react';
import { RevisarRelatorioTela } from '@/components/agencia/revisar-relatorio-tela';

export const metadata: Metadata = { title: 'Relatório do cliente · Liame' };

// Revisar e mandar o relatório do mês de um cliente (P29 aprovado; A7, W7, parte 5b). A tela lê a URL (`vinculo` e
// `relatorio`): fica dentro de um Suspense.
export default function RevisarRelatorioPage() {
  return (
    <Suspense fallback={null}>
      <RevisarRelatorioTela />
    </Suspense>
  );
}
