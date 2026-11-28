import { z } from 'zod';
import type { AppConfig } from '../../config.js';
import type { AssuntoDoPulso, EventoDoPulso } from '../../conteudo/datas.js';
import { clienteDoDmsIdDoProcesso } from './dms-id.js';
import { ClienteIntegracao, ErroPorta } from './integracao-dms.js';

// O Pulso, do lado do Liame (plano de conteúdo, PC4, parte 2; seção 6.3; D-PC-10). O Pulso é o produto da DMS que lê as
// fontes públicas brasileiras: os feriados e os pontos facultativos do estado e da cidade, os dias de comida, os jogos, as
// estreias, o "Em alta" (só assunto com manchete de portal brasileiro) e o boletim do ramo. O Liame chama a porta REST do
// Pulso (`https://pulso.dmstecnologias.com/v1`) com o token do aplicativo do Liame no DMS ID (a permissão `eventos.ler`)
// e a ligação do Liame no cabeçalho `DMS-Ligacao` (o segredo `dms_lg_pulso_…`, criado no console do Pulso).
// NASCE DESLIGADO: sem `PULSO_LIGACAO`, nada chama o Pulso. O Pulso não recebe NADA de cliente, de loja ou de empresa: só a
// lista somada dos municípios (código IBGE) das lojas no mapa e o ramo. As respostas são lidas sem confiar: o item torto fica
// de fora e nunca derruba a resposta.

export const PERMISSOES_DO_PULSO: readonly string[] = ['eventos.ler'];
export const RAMO_DO_LIAME = 'bares_restaurantes';
/** O Pulso aceita até 500 municípios por aplicativo. */
export const MUNICIPIOS_NOS_INTERESSES = 500;
/** O Pulso devolve até 400 dias de eventos por pedido. */
export const DIAS_POR_PEDIDO = 400;

const Evento = z.object({
  id: z.string().min(1).max(100),
  tipo: z.string().regex(/^[a-z_]{2,40}$/),
  nome: z.string().min(1).max(300),
  dia_inteiro: z.boolean(),
  inicio: z.string().min(10).max(40),
  fim: z.string().min(10).max(40).nullable(),
  fuso: z.string().min(3).max(60),
  abrangencia: z.array(z.object({ nivel: z.string().max(20), valor: z.string().max(80) })).max(100),
  situacao: z.string().max(30).optional(),
  detalhes: z.record(z.string(), z.unknown()).nullable().optional(),
  fonte: z.object({ nome: z.string().min(1).max(200), endereco: z.string().max(2000).nullable().optional() }),
});

const Assunto = z.object({
  titulo: z.string().min(1).max(500),
  nota: z.number().min(0).max(100),
  faixa: z.string().regex(/^[a-z_]{1,40}$/),
  monte: z.string().regex(/^[a-z_]{1,40}$/),
  onde: z.object({ nivel: z.string().max(20), valor: z.string().max(80).nullable() }),
  manchetes: z
    .array(z.object({ titulo: z.string().min(1).max(500), link: z.string().max(2000).regex(/^https:\/\//), fonte: z.string().max(200).nullable() }))
    .max(10),
});

/** Os itens que passam pela régua; o resto fica de fora, calado (o Pulso é fonte, não autoridade sobre o formato). */
function lerLista<T>(corpo: unknown, campo: string, regua: z.ZodType<T>): T[] {
  const lista = corpo && typeof corpo === 'object' ? (corpo as Record<string, unknown>)[campo] : null;
  if (!Array.isArray(lista)) throw new ErroPorta(200, 'resposta-inesperada');
  return lista.flatMap((item) => {
    const r = regua.safeParse(item);
    return r.success ? [r.data] : [];
  });
}

export interface LeitorDoPulso {
  /** Os eventos do período no município (o nacional, o do estado do município e o do município), sem os retirados. */
  eventos(municipio: string, de: string, ate: string): Promise<EventoDoPulso[]>;
  /** Os assuntos em alta no Brasil e no estado do município. */
  emAlta(municipio: string): Promise<AssuntoDoPulso[]>;
  /** A lista dos municípios que o Liame vigia (substitui a anterior) e o ramo. */
  mandarInteresses(municipios: readonly string[]): Promise<void>;
}

/** O leitor do Pulso pela configuração; nulo sem a ligação ou sem o aplicativo do Liame no DMS ID (desligado). */
export function leitorDoPulso(config: AppConfig, buscar?: typeof fetch): LeitorDoPulso | null {
  if (!config.pulso || !config.dmsId) return null;
  const porta = new ClienteIntegracao({
    base: config.pulso.base,
    recurso: config.pulso.base,
    permissoes: PERMISSOES_DO_PULSO,
    dmsId: clienteDoDmsIdDoProcesso(config.dmsId),
    ligacao: config.pulso.ligacao,
    tentativas: 2,
    tempoLimiteMs: 8_000,
    ...(buscar ? { buscar, esperar: async () => undefined } : {}),
  });
  const ler = async (caminho: string, consulta: Record<string, string>): Promise<unknown> => {
    const r = await porta.pedir('GET', caminho, { consulta });
    if (r.status !== 200) throw new ErroPorta(r.status, r.problema || 'resposta-inesperada');
    return r.corpo;
  };
  return {
    async eventos(municipio, de, ate) {
      const corpo = await ler('/eventos', { municipio, de, ate });
      return lerLista(corpo, 'eventos', Evento)
        .filter((e) => e.situacao !== 'retirado')
        .map((e) => ({ ...e, detalhes: e.detalhes ?? null, fonte: { nome: e.fonte.nome, endereco: e.fonte.endereco ?? null } }));
    },
    async emAlta(municipio) {
      return lerLista(await ler('/em-alta', { municipio }), 'assuntos', Assunto);
    },
    async mandarInteresses(municipios) {
      const lista = [...new Set(municipios)].sort().slice(0, MUNICIPIOS_NOS_INTERESSES);
      const r = await porta.pedir('PUT', '/interesses', { corpo: { municipios: lista, ramos: [RAMO_DO_LIAME] } });
      if (r.status !== 200) throw new ErroPorta(r.status, r.problema || 'resposta-inesperada');
    },
  };
}
