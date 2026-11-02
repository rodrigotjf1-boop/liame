import type { MemberResponse, PartnerRequestResponse, PartnerResponse, PartnerRole } from '@liame/contracts';
import { dataCompleta, dia, moeda } from '@/lib/formato';
import { APROVAM, NIVEIS, RANK } from '@/lib/niveis';

// As agências em Pessoas e acessos (P27 aprovado; A7, W6, parte 4): as frases do pedido, da agência com acesso e do
// que muda ao mexer no máximo. Quem decide é o servidor (`vinculo.service.ts`); aqui só se mostra e se evita pedir o
// que ele recusaria, com a mesma conta de "subir" (V74).

/** Os níveis que o Dono dá a uma agência, do maior ao menor (nunca o Dono, nunca "só relatórios"). */
export const NIVEIS_DO_PARCEIRO: PartnerRole[] = ['administrador', 'gestor', 'aprovador', 'somente_leitura'];

/** "não aprova gasto", "aprova sozinho até R$ 500,00 por ação; acima disso, você também aprova"... */
export function aprovaTxt(nivel: PartnerRole, limite: number | null, dupla: boolean): string {
  if (!APROVAM.has(nivel)) return 'não aprova gasto';
  if (limite === null) return 'aprova sem limite';
  if (limite === 0) return 'todo gasto passa também por você';
  return `aprova sozinho até ${moeda(limite)} por ação${dupla ? '; acima disso, você também aprova' : ''}`;
}

/** A linha da agência com acesso: "No máximo Gestor · aprova sozinho até... · sem prazo". */
export function detalheDaAgencia(p: Pick<PartnerResponse, 'max_role' | 'approve_limit_micros' | 'dual_approval' | 'ends_at'>): string {
  const fim = p.ends_at ? `até ${dataCompleta(p.ends_at)}` : 'sem prazo';
  return `No máximo ${NIVEIS[p.max_role].nome} · ${aprovaTxt(p.max_role, p.approve_limit_micros, p.dual_approval)} · ${fim}`;
}

/** "da Agência Fogo", "de Estúdio Brasa": a preposição pelo começo do nome (o nome que começa por "Agência" pede "da"). */
export function daAgencia(nome: string): string {
  return /^ag[êe]ncia\b/i.test(nome.trim()) ? `da ${nome}` : `de ${nome}`;
}

/** O CNPJ como se lê: 11.222.333/0001-81. */
export function cnpjTxt(cnpj: string): string {
  return cnpj.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
}

/** O que a agência pede, com o que o nível faz: "Gestor: opera campanhas e aprova até o limite". */
export function pedeTxt(nivel: PartnerRole): string {
  const desc: Record<PartnerRole, string> = {
    administrador: 'cuida de campanhas, equipe e aprovações até o limite',
    gestor: 'opera campanhas e aprova até o limite',
    aprovador: 'aprova ou recusa o que a equipe propõe, até o limite',
    somente_leitura: 'vê resultados e relatórios',
  };
  return `${NIVEIS[nivel].nome}: ${desc[nivel]}`;
}

/** "Recebido hoje · vale até 06/11/2026". */
export function recebidoTxt(p: PartnerRequestResponse, agora = new Date()): string {
  const d = dia(p.created_at, agora);
  return `Recebido ${d === 'hoje' ? 'hoje' : `em ${d}`} · vale até ${dataCompleta(p.expires_at)}`;
}

/** As pessoas da lista que vêm de uma agência, por vínculo; as outras são as diretas. */
export function separarPorAgencia(members: MemberResponse[]): { diretas: MemberResponse[]; porVinculo: Map<string, MemberResponse[]> } {
  const diretas: MemberResponse[] = [];
  const porVinculo = new Map<string, MemberResponse[]>();
  for (const m of members) {
    if (m.partner) porVinculo.set(m.partner.link_id, [...(porVinculo.get(m.partner.link_id) ?? []), m]);
    else diretas.push(m);
  }
  return { diretas, porVinculo };
}

/** A contagem de "Com acesso", com os pedidos e as agências (P27). */
export function contagemComAgencias(diretas: number, convites: number, pedidos: number, agencias: Array<{ nome: string; pessoas: number }>): string {
  const total = diretas + agencias.reduce((s, a) => s + a.pessoas, 0);
  let t = `${total} ${total === 1 ? 'pessoa' : 'pessoas'}`;
  if (agencias.length === 1 && agencias[0]!.pessoas) t += `, ${agencias[0]!.pessoas} ${daAgencia(agencias[0]!.nome)}`;
  if (agencias.length) t += `, e ${agencias.length} ${agencias.length === 1 ? 'agência' : 'agências'}`;
  t += '.';
  if (convites) t += ` ${convites} ${convites === 1 ? 'convite esperando resposta' : 'convites esperando resposta'}.`;
  if (pedidos) t += ` ${pedidos} ${pedidos === 1 ? 'pedido de agência esperando você' : 'pedidos de agência esperando você'}.`;
  return t;
}

export type Maximo = { nivel: PartnerRole; limite: number | null; dupla: boolean };

/**
 * Subir é dar mais poder à agência e pede o código do app (D-A7-49): a mesma conta de `sobe` do servidor (o nível
 * acima; passar a aprovar; o limite maior ou sem limite; tirar o "eu também aprovo"). A tela não muda a data de fim.
 */
export function sobe(antes: Maximo, depois: Maximo): boolean {
  if (RANK[depois.nivel] > RANK[antes.nivel]) return true;
  if (APROVAM.has(depois.nivel)) {
    if (!APROVAM.has(antes.nivel)) return true;
    if (antes.limite !== null && (depois.limite === null || depois.limite > antes.limite)) return true;
    if (antes.dupla && !depois.dupla) return true;
  }
  return false;
}

/** O que muda para o time da agência ao baixar o máximo, como no P27 (o servidor faz o mesmo ajuste, `ajustarAoMaximo`). */
export function efeitosDaMudanca(antes: Maximo, depois: Maximo, time: MemberResponse[]): string[] {
  const r: string[] = [];
  for (const p of time) {
    const nivel = p.role as PartnerRole;
    if (RANK[nivel] > RANK[depois.nivel]) r.push(`${p.name} desce de ${NIVEIS[nivel].nome} para ${NIVEIS[depois.nivel].nome}, na hora.`);
    else if (APROVAM.has(depois.nivel) && depois.limite !== null && (p.approve_limit_micros === null || p.approve_limit_micros > depois.limite)) {
      r.push(`O limite de ${p.name} baixa para ${moeda(depois.limite)} por ação.`);
    }
  }
  if (!APROVAM.has(depois.nivel) && APROVAM.has(antes.nivel)) r.push('Ninguém da agência aprova mais gasto.');
  if (r.length) r.push('A agência recebe um aviso do que mudou.');
  return r;
}
