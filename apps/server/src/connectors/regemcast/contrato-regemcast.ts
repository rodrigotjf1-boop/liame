import { z } from 'zod';
import { pagina } from '../regem/contrato-regem.js';

// Contrato RegemCast → Liame, versão 2 (docs/integracoes/regemcast.md; emendas da ADR-008 e da ADR-019): o
// que as ferramentas do MCP do RegemCast devolvem em `structuredContent`, conferido campo a campo. O que
// foge do contrato vira erro definitivo do conector, nunca dado torto no banco.

const Instante = z.iso.datetime({ offset: true });
const Id = z.string().min(1).max(100);

/** `integracao_situacao`: de quem é o token. `contaId` é o identificador da conta (não muda com o token). */
export const SituacaoRegemcast = z.object({
  contaId: Id,
  conta: z.string().min(1).max(300),
  fuso: z.string().min(1).max(100),
  produto: z.string().min(1).max(40),
  classe: z.enum(['dms', 'externo']),
  token: z.string().max(200),
  permissoes: z.array(z.object({ id: z.string().min(1).max(100), rotulo: z.string().max(200), descricao: z.string().max(1000) })).max(50),
  limitePorMinuto: z.number().int().min(0).max(1_000_000),
});
export type SituacaoRegemcast = z.infer<typeof SituacaoRegemcast>;

/** Uma conversa aberta por anúncio (`conversas_anuncio_listar`): só a origem, o momento e o telefone. */
export const ConversaAnuncio = z.object({
  id: Id,
  /** A linha não muda depois de entrar no RegemCast: sempre 1 (contrato §4). */
  versao: z.number().int().min(1).max(1_000_000),
  atualizado_em: Instante,
  numero_loja: z.string().max(40).nullable(),
  telefone: z.string().min(1).max(40),
  aberta_em: Instante,
  anuncio_id: Id,
  /** `ad` (anúncio) ou `post` (publicação); texto com padrão, não `enum` (V23): a Meta pode trazer outro. */
  tipo_origem: z.string().regex(/^[a-z_]{1,30}$/),
  ctwa_clid: z.string().min(1).max(1000).nullable(),
  url_origem: z.string().min(1).max(2000).nullable(),
});
export type ConversaAnuncio = z.infer<typeof ConversaAnuncio>;

export const PaginaConversas = pagina(ConversaAnuncio);

// ---------------------------------------------------------------- a mensageria (A5, Y4; contrato §8)
// O que o Liame lê para saber o que dá para enviar e o que já foi enviado: a situação da conta, os públicos (só a
// contagem), os modelos, o orçamento de disparos e as campanhas com os números e o custo. Nenhuma destas leituras traz
// telefone, nome de contato ou conteúdo de conversa, e o que vier a mais do que está aqui é descartado na conferência
// (critério A5-9). Os textos escritos pela loja (nome de campanha, texto de modelo) são dado, nunca instrução.

const Texto = (max: number) => z.string().max(max);
/** Um valor de lista que a origem pode ampliar (situação, sinal, período): texto com padrão, não `enum` (V23). */
const Codigo = z.string().regex(/^[a-zà-ú_]{1,40}$/);
const Contagem = z.number().int().min(0).max(1_000_000_000);
/** Dinheiro em centavos inteiros, como o RegemCast manda. */
const Centavos = z.number().int().min(0).max(1_000_000_000_000);

/** `conta_situacao` (`conta.ler`): se a conta pode enviar agora, o plano e o uso do ciclo. */
export const ContaRegemcast = z.object({
  conta: z.string().min(1).max(300),
  fuso: z.string().min(1).max(100),
  whatsapp: z.object({
    conectado: z.boolean(),
    /** `pode_enviar`, `com_restricao`, `bloqueado` ou `desconhecido`; nulo sem WhatsApp conectado. */
    sinal: Codigo.nullable(),
    titulo: Texto(300).nullable(),
    resumo: Texto(1000).nullable(),
    lidaEm: Instante.nullable(),
    problemas: z.array(z.object({ onde: Texto(200), titulo: Texto(300), explicacao: Texto(2000), acao: Texto(1000).nullable() })).max(50),
  }),
  plano: z.object({
    nome: Texto(200).nullable(),
    assinatura: Texto(60).nullable(),
    gratisPeloRegem: z.boolean(),
    disparosNoCiclo: Contagem,
    tetoDoCiclo: Contagem.nullable(),
    restantes: z.number().int().min(-1_000_000_000).max(1_000_000_000).nullable(),
    cicloFim: Texto(40).nullable(),
  }),
});
export type ContaRegemcast = z.infer<typeof ContaRegemcast>;

/** Uma campanha de mensagens: os números que decidem, sem a lista de quem recebeu. */
export const CampanhaRegemcast = z.object({
  id: Id,
  nome: Texto(300),
  /** `rascunho`, `agendada`, `enviando`, `pausada`, `concluida` ou `cancelada`. */
  situacao: Codigo,
  pausaMotivo: Texto(100).nullable(),
  modelo: Texto(600),
  categoria: Texto(60).nullable(),
  publico: Texto(300).nullable(),
  destinatarios: Contagem,
  naFila: Contagem,
  enviadas: Contagem,
  entregues: Contagem,
  lidas: Contagem,
  falhas: Contagem,
  responderam: Contagem,
  criadaEm: Instante.nullable(),
  iniciadaEm: Instante.nullable(),
  concluidaEm: Instante.nullable(),
});
export type CampanhaRegemcast = z.infer<typeof CampanhaRegemcast>;

/** `campanhas_listar` (`campanhas.ler`): até 50 por chamada, das mais novas para as mais antigas; `total` é o de todas. */
export const CampanhasRegemcast = z.object({ campanhas: z.array(CampanhaRegemcast).max(50), total: Contagem });
export type CampanhasRegemcast = z.infer<typeof CampanhasRegemcast>;

/** O custo na Meta: a estimativa antes de disparar, o gasto e o que ainda pode sair. Nulo quando a conta não tem preço. */
export const CustoRegemcast = z
  .object({
    moeda: Texto(10).nullable(),
    gastoCentavos: Centavos.nullable(),
    aSairCentavos: Centavos.nullable(),
    linhas: z.array(z.object({ rotulo: Texto(200), valor: Texto(200), detalhe: Texto(500).nullable() })).max(30),
    avisos: z.array(Texto(500)).max(30),
  })
  .nullable();
export type CustoRegemcast = z.infer<typeof CustoRegemcast>;

/** `campanha_detalhar` (`campanhas.ler`): por que está pausada ou esperando, as falhas por motivo e o custo. */
export const CampanhaDetalhadaRegemcast = z.object({
  campanha: CampanhaRegemcast,
  pausa: z.object({ motivo: Texto(100), explicacao: Texto(2000).nullable(), voltaEm: Instante.nullable() }).nullable(),
  espera: z.object({ motivo: Texto(100), ate: Instante.nullable() }).nullable(),
  falhasPorMotivo: z.array(z.object({ mensagens: Contagem, titulo: Texto(300), explicacao: Texto(2000), acao: Texto(1000).nullable() })).max(100),
  custo: CustoRegemcast,
  descansoDias: z.number().int().min(0).max(3650).nullable(),
});
export type CampanhaDetalhadaRegemcast = z.infer<typeof CampanhaDetalhadaRegemcast>;

const GrupoDeContatos = z.object({ id: Id, nome: Texto(300), regra: Texto(1000).nullable(), pessoas: Contagem });
/** `publicos_listar` (`publicos.ler`): as listas, os públicos prontos e os perfis da base. Só contagens. */
export const PublicosRegemcast = z.object({
  listas: z.array(GrupoDeContatos.extend({ usadaEm: Instante.nullable() })).max(1000),
  publicos: z.array(GrupoDeContatos).max(500),
  perfis: z.array(GrupoDeContatos).max(500),
});
export type PublicosRegemcast = z.infer<typeof PublicosRegemcast>;

/** `modelos_listar` (`modelos.ler`): os modelos como a Meta os tem agora. O texto é conteúdo escrito pela loja. */
export const ModelosRegemcast = z.object({
  modelos: z
    .array(
      z.object({
        id: Id,
        nome: Texto(600),
        idioma: Texto(20),
        categoria: Texto(60),
        /** Só "aprovado" pode ser disparado. */
        situacao: Texto(60),
        podeDisparar: z.boolean(),
        qualidade: Texto(60),
        variaveis: z.number().int().min(0).max(100),
        cabecalho: Texto(2000).nullable(),
        corpo: Texto(5000),
        rodape: Texto(500).nullable(),
        botoes: z.array(Texto(200)).max(20),
        alertas: z.array(Texto(1000)).max(30),
      }),
    )
    .max(1000),
});
export type ModelosRegemcast = z.infer<typeof ModelosRegemcast>;

/** `orcamento_ler` (`orcamento.ler`): os tetos de gasto na Meta que o dono da conta definiu e quanto já saiu. */
export const OrcamentoRegemcast = z.object({
  moeda: Texto(10).nullable(),
  tetos: z.object({ dia: Centavos.nullable(), semana: Centavos.nullable(), mes: Centavos.nullable() }),
  periodos: z
    .array(
      z.object({
        /** `dia`, `semana` ou `mes`. */
        periodo: Codigo,
        rotulo: Texto(100),
        tetoCentavos: Centavos,
        gastoCentavos: Centavos,
        percentual: z.number().min(0).max(1_000_000),
        texto: Texto(500),
        /** `ok`, `atencao` ou `cheio`. */
        sinal: Codigo,
      }),
    )
    .max(10),
  avisos: z.array(Texto(500)).max(30),
});
export type OrcamentoRegemcast = z.infer<typeof OrcamentoRegemcast>;

/** `integracao_revogar`: o próprio token desligado. */
export const RevogacaoRegemcast = z.object({ revogado: z.boolean(), revogadoEm: Instante });

/**
 * O envelope JSON-RPC de uma resposta do MCP (2026-07-28, sem estado). Só o que o conector usa: o resultado
 * da ferramenta (`structuredContent`, ou o texto quando `isError`) ou o erro do protocolo.
 */
export const RespostaMcp = z.object({
  result: z
    .object({
      structuredContent: z.unknown().optional(),
      content: z.array(z.object({ type: z.string().max(40), text: z.string().max(20_000).optional() })).max(50).optional(),
      isError: z.boolean().optional(),
    })
    .optional(),
  error: z.object({ code: z.number().int(), message: z.string().max(2000) }).optional(),
});
