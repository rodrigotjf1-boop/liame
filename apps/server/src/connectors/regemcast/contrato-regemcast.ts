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
