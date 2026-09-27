import type { Metadata } from 'next';
import { SegurancaTela } from '@/components/seguranca/seguranca-tela';

export const metadata: Metadata = { title: 'Segurança da conta · Liame' };

export default function SegurancaPage() {
  return <SegurancaTela />;
}
