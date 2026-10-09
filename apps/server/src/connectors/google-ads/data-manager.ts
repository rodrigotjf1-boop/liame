import { GOOGLE_SALES_SCOPE } from '@liame/contracts';
import { type ClienteConector, ErroConector } from '../cliente-http.js';

// Data Manager API do Google (A5, Y1; base de conhecimento §3.2): informar ao Google a venda confirmada no caixa que
// veio de um clique num anúncio, e ler o resultado de cada pedido de envio. Um evento por pedido de envio: o resultado
// do Google vale então para aquele pedido da loja, sem "parte passou, parte não".
//
// O que sai do Liame é só o que a D-A5-5 permite: o id do clique, o instante, o valor e o id do pedido no Liame.
// Nenhum telefone, e-mail ou endereço (`userData` não é montado aqui), e nenhum campo de consentimento: o Liame não
// guarda essa prova, e mandar "concedido" seria afirmar o que não sabe.

/** A permissão que a autorização do Google precisa ter para o envio (a mesma que o contrato mostra à tela). */
export const ESCOPO_DATA_MANAGER = GOOGLE_SALES_SCOPE;
/** A capacidade no Capability Registry (a versão da API é dado). */
export const CAPACIDADE_CONVERSOES = 'conversion_ingest';

export type TipoDeClique = 'gclid' | 'gbraid' | 'wbraid';
export type CliqueGoogle = { tipo: TipoDeClique; valor: string };

export type DestinoGoogle = {
  /** O id da conta do Google Ads, só com os dígitos. */
  customerId: string;
  /** A conta gerente pela qual a credencial alcança a conta, quando há. */
  loginCustomerId: string | null;
  conversionActionId: string;
};

export type EventoDeVenda = {
  /** O id do pedido no Liame: impede a venda de contar duas vezes e é por ele que o valor é corrigido. */
  transactionId: string;
  /** O instante em que o pedido foi confirmado no caixa (ISO 8601, com o fuso). */
  eventTimestamp: string;
  clique: CliqueGoogle;
  /** Em micros da moeda. */
  valorMicros: bigint;
  moeda: string;
};

/** Micros para o valor da moeda com duas casas, que é como a Data Manager API quer (não em micros). */
export function valorDaMoeda(micros: bigint): number {
  const centavos = (micros + 5_000n) / 10_000n;
  return Number(centavos) / 100;
}

/** O corpo de `events:ingest` para uma venda. Tudo o que sai do Liame para o Google nesta fase está aqui. */
export function corpoDaIngestao(destino: DestinoGoogle, evento: EventoDeVenda, validateOnly: boolean): Record<string, unknown> {
  return {
    destinations: [
      {
        operatingAccount: { accountType: 'GOOGLE_ADS', accountId: destino.customerId },
        ...(destino.loginCustomerId ? { loginAccount: { accountType: 'GOOGLE_ADS', accountId: destino.loginCustomerId } } : {}),
        productDestinationId: destino.conversionActionId,
      },
    ],
    events: [
      {
        transactionId: evento.transactionId,
        eventTimestamp: evento.eventTimestamp,
        eventSource: 'WEB',
        adIdentifiers: { [evento.clique.tipo]: evento.clique.valor },
        conversionValue: valorDaMoeda(evento.valorMicros),
        currency: evento.moeda,
      },
    ],
    validateOnly,
  };
}

/**
 * O texto de um erro do Google como o Liame o guarda: curto e sem identificador. O Google pode repetir na mensagem o
 * valor que recusou (o id do clique é uma sequência longa, com minúsculas): toda sequência longa sem espaço sai, menos
 * o nome de um motivo do próprio Google, que é todo em maiúsculas (`PROCESSING_ERROR_REASON_…`).
 */
export function motivoSemIdentificador(texto: string): string {
  const limpo = texto
    .replace(/\S{24,}/g, (trecho) => (/^[A-Z0-9_.:;,()]+$/.test(trecho) ? trecho : '…'))
    .replace(/\s+/g, ' ')
    .trim();
  return (limpo || 'recusado pelo Google').slice(0, 300);
}

type Acesso = { baseUrl: string; versao: string; accessToken: string };

/** Envia (ou só valida, com `validateOnly`) uma venda. Devolve o id do pedido de envio, que serve para ler o resultado. */
export async function ingerirVenda(
  cliente: ClienteConector,
  p: Acesso & { destino: DestinoGoogle; evento: EventoDeVenda; validateOnly: boolean },
): Promise<{ requestId: string | null }> {
  const r = await cliente.requisitar<{ requestId?: unknown } | null>({
    provider: 'google_ads',
    // A cota e o disjuntor da Data Manager são à parte dos da leitura do Google Ads da mesma conta.
    conta: `dm:${p.destino.customerId}`,
    url: `${p.baseUrl}/${p.versao}/events:ingest`,
    metodo: 'POST',
    cabecalhos: { authorization: `Bearer ${p.accessToken}` },
    corpo: corpoDaIngestao(p.destino, p.evento, p.validateOnly),
    endpoint: p.validateOnly ? 'events:ingest (validação)' : 'events:ingest',
    apiVersion: p.versao,
  });
  const id = r.corpo?.requestId;
  return { requestId: typeof id === 'string' && id.length > 0 && id.length <= 200 ? id : null };
}

export type ResultadoDoEnvio = { situacao: 'aceito' | 'processando' | 'recusado'; motivo: string | null };

/** Junta os textos de motivo que o Google manda no erro ou no aviso, sem depender do formato exato deles. */
function motivosDe(info: unknown, limite = 6): string[] {
  const achados: string[] = [];
  const andar = (v: unknown, profundidade: number): void => {
    if (achados.length >= limite || profundidade > 5 || v === null || typeof v !== 'object') return;
    for (const [chave, valor] of Object.entries(v as Record<string, unknown>)) {
      if (typeof valor === 'string' && /reason|description|message/i.test(chave) && valor.trim()) achados.push(valor.trim());
      else andar(valor, profundidade + 1);
    }
  };
  andar(info, 0);
  return [...new Set(achados)].slice(0, limite);
}

/** A situação de um destino como a página oficial lista: `SUCCESS`, `PROCESSING`, `FAILED` ou `PARTIAL_SUCCESS`. */
export function resultadoDoDestino(destino: { requestStatus?: unknown; errorInfo?: unknown; warningInfo?: unknown } | undefined): ResultadoDoEnvio {
  const status = typeof destino?.requestStatus === 'string' ? destino.requestStatus : '';
  const erro = motivosDe(destino?.errorInfo).join('; ');
  const aviso = motivosDe(destino?.warningInfo).join('; ');
  if (status === 'SUCCESS') return { situacao: 'aceito', motivo: aviso ? motivoSemIdentificador(aviso) : null };
  if (status === 'FAILED') return { situacao: 'recusado', motivo: motivoSemIdentificador(erro || 'o Google recusou o registro') };
  // Com um evento por pedido de envio, "parte passou" não deveria acontecer: vale como recusa, com o que o Google disse.
  if (status === 'PARTIAL_SUCCESS') return { situacao: 'recusado', motivo: motivoSemIdentificador(erro || 'o Google aceitou só parte do pedido de envio') };
  return { situacao: 'processando', motivo: null };
}

/** Lê o resultado de um pedido de envio já aceito pela API (`requestStatus:retrieve`). */
export async function lerResultado(cliente: ClienteConector, p: Acesso & { customerId: string; requestId: string }): Promise<ResultadoDoEnvio> {
  const r = await cliente.requisitar<{ requestStatusPerDestination?: unknown } | null>({
    provider: 'google_ads',
    conta: `dm:${p.customerId}`,
    url: `${p.baseUrl}/${p.versao}/requestStatus:retrieve?requestId=${encodeURIComponent(p.requestId)}`,
    cabecalhos: { authorization: `Bearer ${p.accessToken}` },
    endpoint: 'requestStatus:retrieve',
    apiVersion: p.versao,
  });
  const lista = Array.isArray(r.corpo?.requestStatusPerDestination) ? (r.corpo.requestStatusPerDestination as Array<Record<string, unknown>>) : [];
  if (!lista.length) return { situacao: 'processando', motivo: null };
  return resultadoDoDestino(lista[0]);
}

/** O erro do conector como motivo guardado: o código do Google e o texto sem identificador. */
export function motivoDoErro(e: ErroConector): string {
  return motivoSemIdentificador(`${e.codigoProvider ?? e.tipo}: ${e.message}`);
}
