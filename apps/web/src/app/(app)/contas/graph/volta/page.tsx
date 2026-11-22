import type { Metadata } from 'next';
import { VoltaDmsGraph } from '@/components/contas/volta-dms-graph';

export const metadata: Metadata = { title: 'Conectar ao DMS Graph' };

export default function VoltaDoDmsGraphPage() {
  return <VoltaDmsGraph />;
}
