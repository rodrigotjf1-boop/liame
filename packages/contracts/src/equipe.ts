import { z } from 'zod';

// Sua equipe (A3, I13b; protótipo P7, aprovado em 03/10/2026): quem trabalha para a marca, em que situação, quanto a IA
// dele custou no mês e o que ele fez, contado pelo código (inclusive o que a conferência recusou, sem o texto). A
// descrição de cada funcionário (o que faz e o que nunca faz) e os da fase seguinte são da tela. O custo de IA vai em
// micros de dólar (texto): é a moeda do fornecedor e do teto da empresa. Parar a equipe inteira é a parada da empresa
// (`/v1/kill-switches`, nível `tenant`). Listas que crescem vão como texto (V23); no pedido, a lista fechada.

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
   * `recusadas`, `sugestoes`. LIA, Analista, Estrategista e Pesquisador levam também `retiradas_na_conferencia`
   * (os textos deles que a conferência não deixou aparecer); `respostas` e `explicacoes` são as que chegaram à pessoa,
   * sem as retiradas. Compliance: `textos_conferidos` (todo texto de IA que chegou à conferência, entregue ou
   * retirado) e `textos_barrados` (os que uma regra de texto, ou o revisor de IA, barrou). Gestor de
   * tráfego: `recomendacoes`, `comparaveis`, `mesma_direcao` e `arrependimento` (em micros de real; negativo: as
   * recomendações teriam feito melhor que o que foi feito).
   */
  key: Slug,
  value: Inteiro,
  /** `qtd` (contagem) ou `brl_micros`. */
  unit: Slug,
});
export type TeamStat = z.infer<typeof TeamStat>;

export const TeamMember = z.strictObject({
  key: Slug,
  /**
   * `ia` (usa modelo: tem custo e para com a IA desligada ou com a parada) ou `regra` (trabalha por regra). O
   * Compliance é `regra` e pode ter custo: o do revisor de IA, para a empresa que o tem ligado.
   */
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
  /** O custo de IA nesta marca no mês (micros de dólar) e as chamadas ao modelo (todas, não só as que viraram resposta). */
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
  /**
   * A cotação de referência para a tela mostrar o custo em reais (D-A3-14): a PTAX de venda do Banco Central do dia útil
   * mais recente que o Liame leu (`rate` = reais por dólar; `date` = o dia do boletim). O custo e o teto seguem medidos e
   * limitados em dólar. Nula antes da primeira leitura: a tela mostra só o dólar.
   */
  usd_brl: z.strictObject({ rate: z.string().regex(/^\d{1,4}\.\d{1,6}$/), date: z.iso.date(), source: Slug }).nullable(),
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

// ---------------------------------------------------------------- o que cada um fez

export const TeamActivityQuery = z.strictObject({ brand_id: z.uuid(), limit: z.coerce.number().int().min(1).max(50).default(20) });
export type TeamActivityQuery = z.infer<typeof TeamActivityQuery>;

export const TeamActivityItem = z.strictObject({
  at: z.iso.datetime(),
  /**
   * O que aconteceu (lista que cresce; o que a tela não conhece, mostra de forma genérica). LIA: `respondeu`,
   * `abriu_demanda`. Analista: `explicou_resultados`, `explicou_aviso`. Relatórios: `gerou_revisao`, `enviou_revisao`.
   * Compliance: `barrou_texto`. Estrategista: `recebeu_demanda`, `montou_plano`, `plano_aprovado`, `plano_recusado`,
   * `plano_nova_analise`. Pesquisador: `leu_pagina`, `pagina_recusada`, `pagina_falhou`. Gestor de tráfego:
   * `recomendou`, `comparou`, `promocao_proposta`, `promocao_aprovada`, `promocao_recusada`, `promocao_retirada`,
   * `voltou_para_sombra`. De qualquer um: `retirada_na_conferencia` (um texto dele que a conferência não deixou
   * aparecer), `desligado` e `ligado` (pela empresa, nesta marca).
   */
  kind: Slug,
  /**
   * O nome do que foi tratado, quando a pessoa pode vê-lo na tela de origem: o título da conversa (só a própria), da
   * demanda ou do plano, o site lido, a campanha, a conta de anúncio. Nulo quando não há ou quando falta a permissão.
   */
  subject: z.string().nullable(),
  /**
   * Um código que completa o `kind` (lista que cresce): o tipo da demanda ou do plano; quem escreveu a leitura da
   * revisão (`lia` ou `sistema`); o funcionário que escreveu o texto barrado; o porquê da retirada, da recusa ou da
   * falha; a ação recomendada ou promovida (`orcamento_reduzir`…); o resultado da comparação (`teria_melhorado`…).
   */
  detail: Slug.nullable(),
  /** A semana da revisão. */
  period: z.strictObject({ from: z.iso.date(), to: z.iso.date() }).nullable(),
  /**
   * Um número do acontecimento: as pessoas que receberam o e-mail, as partes do dossiê que ganharam sugestão, os textos
   * barrados de uma vez, a versão do plano, o percentual da verba recomendado.
   */
  count: z.int().nullable(),
  /**
   * As regras de texto que barraram (`barrou_texto` e `retirada_na_conferencia`), pelo nome. Quando quem barrou foi o
   * revisor de IA do Compliance, as categorias que ele apontou: `tom`, `clareza`, `alegacao`.
   */
  rules: z.array(Slug),
  /**
   * Quem pediu ou decidiu. Nas respostas e explicações da IA, só quando foi a própria pessoa (o que os outros perguntam
   * não aparece); nulo em rotina do sistema.
   */
  by: Pessoa,
  /** Foi a própria pessoa que pediu ou decidiu. */
  mine: z.boolean(),
  /** O retorno das pessoas sobre aquele texto: `fez_sentido` ou `discordo` (o mais recente); nulo sem retorno. */
  feedback: Slug.nullable(),
});
export type TeamActivityItem = z.infer<typeof TeamActivityItem>;

export const TeamActivityResponse = z.strictObject({
  brand_id: z.uuid(),
  member: Slug,
  /** Desde quando a lista olha (os últimos 90 dias). */
  since: z.iso.datetime(),
  /** Do mais novo para o mais antigo. */
  items: z.array(TeamActivityItem),
  /** Há mais acontecimentos no período do que os devolvidos. */
  has_more: z.boolean(),
  generated_at: z.iso.datetime(),
});
export type TeamActivityResponse = z.infer<typeof TeamActivityResponse>;

// ---------------------------------------------------------------- a sombra do Gestor de tráfego

export const TeamShadowQuery = z.strictObject({ brand_id: z.uuid(), limit: z.coerce.number().int().min(1).max(100).default(30) });
export type TeamShadowQuery = z.infer<typeof TeamShadowQuery>;

export const TeamShadowDecision = z.strictObject({
  id: z.uuid(),
  /** O dia da recomendação, no fuso da loja. */
  decided_on: z.iso.date(),
  campaign: z.strictObject({ id: z.uuid(), name: z.string(), provider: Slug }),
  /** O que ele faria: `orcamento_reduzir`, `campanha_pausar` ou `orcamento_aumentar`. Nada é executado. */
  tool: Slug,
  /** O percentual da mudança de verba recomendada; nulo ao pausar. */
  percent: z.int().nullable(),
  /** A confiança da recomendação, em % com uma casa. */
  confidence_pct: z.string().regex(/^\d{1,3}\.\d$/),
  /** `aberta` (ainda não dá para comparar), `avaliada` ou `descartada` (ficou sem dado para comparar). */
  status: Slug,
  /** O primeiro dia em que dá para comparar. */
  evaluate_on: z.iso.date(),
  /**
   * O que a pessoa fez na plataforma depois, visto pela leitura diária: `pausou`, `reduziu_verba`, `aumentou_verba` ou
   * `nenhuma`; nulo enquanto nada foi visto.
   */
  human_action: Slug.nullable(),
  human_action_on: z.iso.date().nullable(),
  /** `igual`, `mesma_direcao`, `contraria` ou `nenhuma`; nulo antes de a pessoa agir ou de comparar. */
  agreement: Slug.nullable(),
  /** `teria_melhorado`, `teria_piorado`, `igual` ou `sem_dado`; nulo antes de comparar. */
  regret_label: Slug.nullable(),
  /**
   * O resultado de verdade menos o estimado com a recomendação, em micros de real: negativo, a recomendação teria
   * rendido mais; nulo sem dado para comparar.
   */
  regret_micros: Inteiro.nullable(),
});
export type TeamShadowDecision = z.infer<typeof TeamShadowDecision>;

export const TeamShadowResponse = z.strictObject({
  brand_id: z.uuid(),
  /** A versão das regras da sombra em uso. */
  rule_version: z.int().min(1),
  /**
   * A vez mais recente da sombra nesta marca: o último dia da loja em que a rotina terminou (`on`), como terminou a
   * última tentativa (`feito`, `dado_velho`, `ja_rodou`, `desligada`, `desligada_pela_empresa`) e quando foi; nula
   * antes da primeira.
   */
  last_run: z.strictObject({ on: z.iso.date().nullable(), status: Slug.nullable(), at: z.iso.datetime().nullable() }).nullable(),
  /** Da mais nova para a mais antiga. */
  items: z.array(TeamShadowDecision),
  has_more: z.boolean(),
  generated_at: z.iso.datetime(),
});
export type TeamShadowResponse = z.infer<typeof TeamShadowResponse>;

export const PauseTeamMemberRequest = z.strictObject({ brand_id: z.uuid(), reason: z.string().trim().min(3).max(300).optional() });
export type PauseTeamMemberRequest = z.infer<typeof PauseTeamMemberRequest>;

export const ResumeTeamMemberRequest = z.strictObject({ brand_id: z.uuid() });
export type ResumeTeamMemberRequest = z.infer<typeof ResumeTeamMemberRequest>;
