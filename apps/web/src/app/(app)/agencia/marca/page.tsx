import type { Metadata } from 'next';
import { MarcaTela } from '@/components/agencia/marca-tela';

export const metadata: Metadata = { title: 'A marca da agência · Liame' };

// A marca da agência (P29 aprovado; A7, W7, parte 5a).
export default function MarcaDaAgenciaPage() {
  return <MarcaTela />;
}
