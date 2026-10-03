import type { NomeIcone } from '@/components/ui/icone';
import type { Modo } from '@/lib/modo';

// Itens do menu na ordem do protótipo aprovado. Só entram as telas que já existem: as outras chegam
// com as suas fases (roadmap). Cada item some para quem não tem a permissão da tela; os itens de
// "Sua conta" são da própria pessoa (valem para todas as empresas, inclusive sem empresa ativa).
// Os grupos de ferramenta ficam em "Mais ferramentas": recolhido no Lite, aberto no Pro
// (ux-modelo-interface §4.1).

export type ItemNav = {
  href: string;
  rotulo: string;
  /** Título da tela e da trilha, quando difere do rótulo curto do menu. */
  titulo?: string;
  icone: NomeIcone;
  /** Sem permissão = tela da própria pessoa (Segurança da conta). */
  permissao?: string;
  /**
   * Mostra ao lado um número: os avisos (crítico + atenção), os pedidos esperando aprovação ou, no Resumo, os
   * pontos que pedem a pessoa (os avisos e, havendo pedido esperando, mais um).
   */
  contador?: 'atencao' | 'aprovacoes' | 'resumo';
  /** A tela tem as duas visões (Lite e Pro): o seletor de modo aparece no topo. */
  modos?: boolean;
  /**
   * Item de um modo só: a página inicial muda com ele (Resumo no Lite, Atenção no Pro; protótipo P8). No outro
   * modo, o item aparece se o grupo não tem nenhum item daquele modo para a pessoa (sem ver as vendas, não há
   * Resumo, e a Atenção fica no Lite também).
   */
  soNo?: Modo;
};
export type GrupoNav = {
  id: string;
  rotulo: string;
  pessoal?: boolean;
  /** Grupo de ferramentas: no Lite, fica dentro de "Mais ferramentas" (recolhido); no Pro, aberto. */
  ferramenta?: boolean;
  itens: ItemNav[];
};

export const NAVEGACAO: GrupoNav[] = [
  {
    id: 'agencia',
    rotulo: 'Agência',
    itens: [
      { href: '/resumo', rotulo: 'Resumo', icone: 'home', permissao: 'vendas.ver', contador: 'resumo', modos: true, soNo: 'lite' },
      { href: '/atencao', rotulo: 'Atenção', titulo: 'Atenção de mídia', icone: 'atencao', permissao: 'campanhas.ver', contador: 'atencao', modos: true, soNo: 'pro' },
      { href: '/aprovacoes', rotulo: 'Aprovações', icone: 'check-circle', permissao: 'campanhas.ver', contador: 'aprovacoes', modos: true },
      { href: '/resultados', rotulo: 'Resultados', icone: 'chart', permissao: 'vendas.ver', modos: true },
      { href: '/marca', rotulo: 'Minha marca', icone: 'palette', permissao: 'dossie.ver' },
      { href: '/contas', rotulo: 'Contas conectadas', icone: 'plug', permissao: 'contas.ver' },
      { href: '/pessoas', rotulo: 'Pessoas e acessos', icone: 'user-plus', permissao: 'pessoas.ver' },
    ],
  },
  {
    id: 'operacao',
    rotulo: 'Operação',
    ferramenta: true,
    itens: [{ href: '/links', rotulo: 'Links e cupons', icone: 'link', permissao: 'vendas.ver' }],
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

/**
 * Telas abaixo de um item do menu, com título próprio na trilha. `modos`: a subtela tem as visões Lite e
 * Pro? (A revisão da semana é uma só; o seletor some nela.)
 */
const SUBTELAS: Record<string, { titulo: string; modos: boolean }> = {
  '/resultados/revisao': { titulo: 'Resultados · Revisão da semana', modos: false },
};

export function tituloDa(caminho: string): string {
  const sub = SUBTELAS[caminho];
  if (sub) return sub.titulo;
  for (const g of NAVEGACAO) for (const i of g.itens) if (itemAtual(caminho, i.href)) return i.titulo ?? i.rotulo;
  return 'Liame';
}

/** Tela da própria pessoa: abre sem empresa ativa e mostra o nome dela na trilha. */
export function rotaPessoal(caminho: string): boolean {
  return NAVEGACAO.some((g) => g.pessoal && g.itens.some((i) => itemAtual(caminho, i.href)));
}

/**
 * Itens que a pessoa vê no grupo: some o que exige permissão que ela não tem (o servidor também barra) e, com o
 * modo dado, o item do outro modo (salvo quando o grupo não tem nenhum item deste modo para ela).
 */
export function itensVisiveis(grupo: GrupoNav, pode: (permissao: string) => boolean, modo?: Modo): ItemNav[] {
  const permitidos = grupo.itens.filter((i) => !i.permissao || pode(i.permissao));
  if (!modo) return permitidos;
  const temDoModo = permitidos.some((i) => i.soNo === modo);
  return permitidos.filter((i) => !i.soNo || i.soNo === modo || !temDoModo);
}

/** A tela aberta está num grupo de ferramentas ("Mais ferramentas" começa aberto nela). */
export function emFerramenta(caminho: string): boolean {
  return NAVEGACAO.some((g) => g.ferramenta && g.itens.some((i) => itemAtual(caminho, i.href)));
}

/** A tela aberta tem as visões Lite e Pro e a pessoa pode vê-la (sem permissão, a tela é só o aviso). */
export function temModos(caminho: string, pode: (permissao: string) => boolean): boolean {
  if (SUBTELAS[caminho] && !SUBTELAS[caminho].modos) return false;
  return NAVEGACAO.some((g) => g.itens.some((i) => i.modos && itemAtual(caminho, i.href) && (!i.permissao || pode(i.permissao))));
}
