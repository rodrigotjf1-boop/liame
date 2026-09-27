import type { NomeIcone } from '@/components/ui/icone';

// Itens do menu na ordem do protótipo aprovado. Só entram as telas que já existem: as outras chegam
// com as suas fases (roadmap). Cada item some para quem não tem a permissão da tela; os itens de
// "Sua conta" são da própria pessoa (valem para todas as empresas, inclusive sem empresa ativa).

export type ItemNav = {
  href: string;
  rotulo: string;
  /** Título da tela e da trilha, quando difere do rótulo curto do menu. */
  titulo?: string;
  icone: NomeIcone;
  /** Sem permissão = tela da própria pessoa (Segurança da conta). */
  permissao?: string;
};
export type GrupoNav = { id: string; rotulo: string; pessoal?: boolean; itens: ItemNav[] };

export const NAVEGACAO: GrupoNav[] = [
  {
    id: 'agencia',
    rotulo: 'Agência',
    itens: [
      { href: '/contas', rotulo: 'Contas conectadas', icone: 'plug', permissao: 'contas.ver' },
      { href: '/pessoas', rotulo: 'Pessoas e acessos', icone: 'user-plus', permissao: 'pessoas.ver' },
    ],
  },
  {
    id: 'conta',
    rotulo: 'Sua conta',
    pessoal: true,
    itens: [{ href: '/seguranca', rotulo: 'Segurança da conta', icone: 'shield' }],
  },
];

/** A tela do item está aberta (a própria rota ou uma rota abaixo dela). */
export function itemAtual(caminho: string, href: string): boolean {
  return caminho === href || caminho.startsWith(`${href}/`);
}

export function tituloDa(caminho: string): string {
  for (const g of NAVEGACAO) for (const i of g.itens) if (itemAtual(caminho, i.href)) return i.titulo ?? i.rotulo;
  return 'Liame';
}

/** Tela da própria pessoa: abre sem empresa ativa e mostra o nome dela na trilha. */
export function rotaPessoal(caminho: string): boolean {
  return NAVEGACAO.some((g) => g.pessoal && g.itens.some((i) => itemAtual(caminho, i.href)));
}
