import type { Metadata } from 'next';
import { RelatoriosTela } from '@/components/agencia/relatorios-tela';

export const metadata: Metadata = { title: 'Relatórios · Liame' };

// Os relatórios do mês dos clientes da agência (P29 aprovado; A7, W7, parte 5b).
export default function RelatoriosDaAgenciaPage() {
  return <RelatoriosTela />;
}
