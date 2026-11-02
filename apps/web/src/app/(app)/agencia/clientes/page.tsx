import type { Metadata } from 'next';
import { ClientesTela } from '@/components/agencia/clientes-tela';

export const metadata: Metadata = { title: 'Clientes · Liame' };

// Clientes da agência (P27 aprovado; A7, W6, parte 5).
export default function ClientesPage() {
  return <ClientesTela />;
}
