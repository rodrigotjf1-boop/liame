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
  /** Mostra ao lado o número de avisos de mídia (crítico + atenção). */
  contador?: 'atencao';
  /** A tela tem as duas visões (Lite e Pro): o seletor de modo aparece no topo. */
  modos?: boolean;
};
export type GrupoNav = { id: string; rotulo: string; pessoal?: boolean; itens: ItemNav[] };

export const NAVEGACAO: GrupoNav[] = [
  {
    id: 'agencia',
    rotulo: 'Agência',
    itens: [
      { href: '/atencao', rotulo: 'Atenção', titulo: 'Atenção de mídia', icone: 'atencao', permissao: 'campanhas.ver', contador: 'atencao' },
      { href: '/resultados', rotulo: 'Resultados', icone: 'chart', permissao: 'vendas.ver', modos: true },
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

/** Itens que a pessoa vê no grupo: some o que exige permissão que ela não tem (o servidor também barra). */
export function itensVisiveis(grupo: GrupoNav, pode: (permissao: string) => boolean): ItemNav[] {
  return grupo.itens.filter((i) => !i.permissao || pode(i.permissao));
}

/** A tela aberta tem as visões Lite e Pro e a pessoa pode vê-la (sem permissão, a tela é só o aviso). */
export function temModos(caminho: string, pode: (permissao: string) => boolean): boolean {
  return NAVEGACAO.some((g) => g.itens.some((i) => i.modos && itemAtual(caminho, i.href) && (!i.permissao || pode(i.permissao))));
}
