import { z } from 'zod';

// Sua equipe (A3, I13b; protótipo P7, aguardando aprovação): quem trabalha para a marca, em que situação, quanto a IA
// dele custou no mês e o que ele fez, contado pelo código. A descrição de cada funcionário (o que faz e o que nunca
// faz) e os da fase seguinte são da tela. O custo de IA vai em micros de dólar (texto): é a moeda do fornecedor e do
// teto da empresa. Parar a equipe inteira é a parada da empresa (`/v1/kill-switches`, nível `tenant`). Listas que
// crescem vão como texto (V23); no pedido, a lista fechada.

const Slug = z.string().regex(/^[a-z0-9_]+$/).max(60);
/** Inteiro em texto (cabe em bigint): contagem ou micros de moeda. */
const Inteiro = z.string().regex(/^-?\d+$/);
const Pessoa = z.strictObject({ id: z.uuid(), name: z.string() }).nullable();

/** Os membros da equipe na A3. */
export const TEAM_MEMBERS = ['lia', 'analista', 'relatorios', 'compliance', 'estrategista', 'pesquisador', 'trafego'] as const;
export const TeamMemberKey = z.enum(TEAM_MEMBERS);
export type TeamMemberKey = z.infer<typeof TeamMemberKey>;

export const TeamStat = z.strictObject({
  /**
   * O que foi contado no mês. LIA: `respostas`, `fez_sentido`, `discordo`, `demandas`. Analista: `explicacoes`,
   * `fez_sentido`, `discordo`. Relatórios: `revisoes`, `com_leitura_da_ia`, `so_do_sistema`. Estrategista:
   * `planos_aprovados`, `planos_recusados`, `planos_esperando`, `em_preparo`. Pesquisador: `paginas_lidas`,
   * `recusadas`, `sugestoes`. Gestor de tráfego: `recomendacoes`, `comparaveis`, `mesma_direcao` e
   * `arrependimento` (em micros de real; negativo: as recomendações teriam feito melhor que o que foi feito).
   */
  key: Slug,
  value: Inteiro,
  /** `qtd` (contagem) ou `brl_micros`. */
  unit: Slug,
});
export type TeamStat = z.infer<typeof TeamStat>;

export const TeamMember = z.strictObject({
  key: Slug,
  /** `ia` (usa modelo: tem custo e para com a IA desligada ou com a parada) ou `regra` (trabalha por regra). */
  kind: Slug,
  /**
   * `ativo`; `sombra` (o Gestor de tráfego registra e compara, sem mostrar nem mexer); `desligado` (pela empresa,
   * nesta marca); `desligado_pela_liame` (fora do plano, ou a IA ou a sombra desligada pela distribuição); `parado`
   * (a parada da empresa, ou da Liame, trava a IA).
   */
  status: Slug,
  /** Tem trabalho em andamento agora (um plano em preparo, uma página sendo lida). */
  working_now: z.boolean(),
  /** A empresa pode desligar (o Compliance não). */
  can_pause: z.boolean(),
  /** Quem desligou, quando e por quê, enquanto estiver desligado pela empresa. */
  paused: z.strictObject({ by: Pessoa, at: z.iso.datetime(), reason: z.string().nullable() }).nullable(),
  /** O custo de IA nesta marca no mês (micros de dólar) e as chamadas ao modelo. */
  cost: z.strictObject({ usd_micros: Inteiro, calls: z.int().min(0) }),
  stats: z.array(TeamStat),
});
export type TeamMember = z.infer<typeof TeamMember>;

export const TeamQuery = z.strictObject({ brand_id: z.uuid() });
export type TeamQuery = z.infer<typeof TeamQuery>;

export const TeamResponse = z.strictObject({
  brand_id: z.uuid(),
  /** O mês corrente, no fuso da empresa (o mesmo do teto de IA). */
  month: z.strictObject({ from: z.iso.date(), to: z.iso.date(), timezone: z.string() }),
  /** A IA da empresa no mês (todas as marcas): ligada, o gasto, o teto e a faixa (`livre`, `alerta`, `economico`, `bloqueado`). */
  ai: z.strictObject({ enabled: z.boolean(), spent_usd_micros: Inteiro, ceiling_usd_micros: Inteiro, band: Slug }),
  /** A parada que vale para a marca agora (da empresa ou da Liame), ou nula. */
  stop: z.strictObject({ id: z.uuid(), level: Slug, by_company: z.boolean(), since: z.iso.datetime(), reason: z.string(), by: Pessoa }).nullable(),
  members: z.array(TeamMember),
  /** A pessoa pode desligar e ligar um funcionário (`agentes.gerenciar`). */
  can_manage: z.boolean(),
  /** A pessoa pode parar e retomar a equipe (`parada.acionar`). */
  can_stop: z.boolean(),
  generated_at: z.iso.datetime(),
});
export type TeamResponse = z.infer<typeof TeamResponse>;

export const PauseTeamMemberRequest = z.strictObject({ brand_id: z.uuid(), reason: z.string().trim().min(3).max(300).optional() });
export type PauseTeamMemberRequest = z.infer<typeof PauseTeamMemberRequest>;

export const ResumeTeamMemberRequest = z.strictObject({ brand_id: z.uuid() });
export type ResumeTeamMemberRequest = z.infer<typeof ResumeTeamMemberRequest>;
