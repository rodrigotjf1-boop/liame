import type { NomeIcone } from '@/components/ui/icone';

// Itens do menu na ordem do protótipo aprovado. Só entram as telas que já existem: as outras chegam
// com as suas fases (roadmap). Cada item some para quem não tem a permissão da tela.

export type ItemNav = { href: string; rotulo: string; icone: NomeIcone; permissao: string };
export type GrupoNav = { id: string; rotulo: string; itens: ItemNav[] };

export const NAVEGACAO: GrupoNav[] = [
  {
    id: 'agencia',
    rotulo: 'Agência',
    itens: [{ href: '/pessoas', rotulo: 'Pessoas e acessos', icone: 'user-plus', permissao: 'pessoas.ver' }],
  },
];

export function tituloDa(caminho: string): string {
  for (const g of NAVEGACAO) for (const i of g.itens) if (caminho === i.href || caminho.startsWith(`${i.href}/`)) return i.rotulo;
  return 'Liame';
}
