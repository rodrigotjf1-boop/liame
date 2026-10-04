import type { Metadata } from 'next';
import { EquipeTela } from '@/components/equipe/equipe-tela';

export const metadata: Metadata = { title: 'Sua equipe · Liame' };

export default function EquipePage() {
  return <EquipeTela />;
}
