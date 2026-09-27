import type { Metadata } from 'next';
import { AtencaoTela } from '@/components/atencao/atencao-tela';

export const metadata: Metadata = { title: 'Atenção de mídia · Liame' };

export default function AtencaoPage() {
  return <AtencaoTela />;
}
