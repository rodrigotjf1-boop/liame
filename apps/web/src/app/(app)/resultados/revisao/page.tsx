import type { Metadata } from 'next';
import { Suspense } from 'react';
import { RevisaoTela } from '@/components/revisao/revisao-tela';

export const metadata: Metadata = { title: 'Revisão da semana · Liame' };

// A tela lê a marca e a semana na URL (?marca, ?semana, do link do e-mail): com Cache Components, isso fica dentro de um Suspense.
export default function RevisaoPage() {
  return (
    <Suspense fallback={null}>
      <RevisaoTela />
    </Suspense>
  );
}
