import type { Metadata } from 'next';
import { DirectTela } from '@/components/direct/direct-tela';

export const metadata: Metadata = { title: 'Direct · Liame' };

export default function DirectPage() {
  return <DirectTela />;
}
