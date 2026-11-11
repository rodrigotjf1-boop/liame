import type { Metadata } from 'next';
import { Suspense } from 'react';
import { RegiaoTela } from '@/components/regiao/regiao-tela';

export const metadata: Metadata = { title: 'Região · Liame' };

// Minha marca › Região (P40 aprovado; plano da região, R1). A tela lê a marca na URL (?marca, vinda de Minha marca):
// com Cache Components, isso fica dentro de um Suspense.
export default function RegiaoPage() {
  return (
    <Suspense fallback={null}>
      <RegiaoTela />
    </Suspense>
  );
}
