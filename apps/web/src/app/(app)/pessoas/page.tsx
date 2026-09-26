import type { Metadata } from 'next';
import { PessoasTela } from '@/components/pessoas/pessoas-tela';

export const metadata: Metadata = { title: 'Pessoas e acessos · Liame' };

export default function PessoasPage() {
  return <PessoasTela />;
}
