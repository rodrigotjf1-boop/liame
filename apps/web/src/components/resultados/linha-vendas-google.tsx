import Link from 'next/link';
import type { LinhaDasVendas } from '@/components/contas/vendas-google';
import { Icone } from '@/components/ui/icone';

// A linha das vendas informadas ao Google, no cartão das campanhas (protótipo P14, parte B, aprovado em 09/10/2026):
// quantas vendas o Liame informou ao Google nos últimos 30 dias, com o atalho para o cartão de Contas conectadas.
// Quando o envio para sem ninguém mandar parar, a linha vira aviso. Só aparece com a função ligada para a marca e
// para quem pode ver Contas conectadas (quem decide o que entra é `linhaDasVendas`).

export function LinhaVendasGoogle({ linha }: { linha: LinhaDasVendas }) {
  return (
    <p className={linha.tom === 'neutro' ? 'vg-linha' : `vg-linha vg-linha--${linha.tom}`} role={linha.tom === 'atencao' ? 'status' : undefined}>
      <Icone nome={linha.icone} pequeno />
      <span>
        {linha.antes}
        {linha.forte && <b>{linha.forte}</b>}
        {linha.depois} <Link href={linha.atalho.href}>{linha.atalho.rotulo}</Link>
      </span>
    </p>
  );
}
