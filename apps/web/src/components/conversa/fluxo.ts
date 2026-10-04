import type { ConversationStreamEvent, SendConversationMessageRequest } from '@liame/contracts';
import { API_URL, type Problema, SEM_CONEXAO } from '@/lib/api';

// A resposta da LIA chega por um fluxo de eventos (`text/event-stream`) na resposta do próprio POST: a tela lê o
// corpo aos pedaços. Cada evento tem uma linha `event:` e uma linha `data:` com o JSON; linha que começa por `:`
// só mantém a conexão aberta. "Parar" é fechar a leitura (o servidor vê a conexão fechar e não começa leitura nova).

/**
 * Tira do texto acumulado os eventos completos (separados por linha em branco) e devolve o que sobrou, à espera do
 * resto. Evento sem `data:` (o comentário que mantém a conexão) ou com JSON torto é ignorado.
 */
export function eventosDoTexto(acumulado: string): { eventos: ConversationStreamEvent[]; resto: string } {
  const partes = acumulado.replaceAll('\r\n', '\n').split('\n\n');
  const resto = partes.pop() ?? '';
  const eventos: ConversationStreamEvent[] = [];
  for (const parte of partes) {
    const dados = parte
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trimStart())
      .join('\n');
    if (!dados) continue;
    try {
      const e = JSON.parse(dados) as ConversationStreamEvent;
      if (e && typeof e.type === 'string') eventos.push(e);
    } catch {
      // Evento cortado ou fora do formato: a tela segue com os outros (o fim sem `mensagem` vira aviso).
    }
  }
  return { eventos, resto };
}

export type FimDoEnvio =
  /** O fluxo terminou (com ou sem o evento `fim`: quem chama confere se a resposta chegou). */
  | { tipo: 'ok' }
  /** A pessoa parou, ou a tela saiu, antes do fim. */
  | { tipo: 'parada' }
  /** Antes do fluxo (404, 409, 422, 429…) ou a conexão caiu no meio. */
  | { tipo: 'erro'; problema: Problema };

async function problemaDa(resposta: Response): Promise<Problema> {
  try {
    const p = (await resposta.json()) as Partial<Problema>;
    if (p && typeof p.code === 'string' && typeof p.title === 'string') return { ...(p as Problema), status: resposta.status };
  } catch {
    // Corpo que não é o problema da API: cai no genérico.
  }
  return { status: resposta.status, code: 'erro-inesperado', title: 'Algo deu errado', detail: 'Tente de novo em instantes. Se continuar, fale com o suporte.' };
}

/** Manda a mensagem e entrega cada evento do fluxo, na ordem. O `sinal` é o "Parar". */
export async function mandarMensagem(corpo: SendConversationMessageRequest, aoEvento: (e: ConversationStreamEvent) => void, sinal: AbortSignal): Promise<FimDoEnvio> {
  let resposta: Response;
  try {
    resposta = await fetch(`${API_URL}/v1/conversations/messages`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify(corpo),
      signal: sinal,
    });
  } catch {
    return sinal.aborted ? { tipo: 'parada' } : { tipo: 'erro', problema: SEM_CONEXAO };
  }
  if (!resposta.ok) return { tipo: 'erro', problema: await problemaDa(resposta) };
  if (!resposta.body) return { tipo: 'erro', problema: SEM_CONEXAO };
  const leitor = resposta.body.getReader();
  const decodificador = new TextDecoder();
  let acumulado = '';
  try {
    for (;;) {
      const { done, value } = await leitor.read();
      if (done) break;
      acumulado += decodificador.decode(value, { stream: true });
      const { eventos, resto } = eventosDoTexto(acumulado);
      acumulado = resto;
      for (const e of eventos) aoEvento(e);
    }
    // O último evento pode vir sem a linha em branco do fim.
    for (const e of eventosDoTexto(`${acumulado}${decodificador.decode()}\n\n`).eventos) aoEvento(e);
    return { tipo: 'ok' };
  } catch {
    return sinal.aborted ? { tipo: 'parada' } : { tipo: 'erro', problema: SEM_CONEXAO };
  }
}
