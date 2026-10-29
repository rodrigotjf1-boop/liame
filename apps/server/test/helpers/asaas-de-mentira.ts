import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

// Um Asaas local para os testes da cobrança (A7, W2a). Cada comportamento segue a documentação oficial lida em 23/10/2026
// (`base-conhecimento.md` §18.5; V125), e o que ela não diz fica no pior caso:
//   - a chave vai no cabeçalho `access_token`: sem ela ou com outra, 401 (autenticação, 13/10/2026);
//   - o `User-Agent` é obrigatório para conta nova (autenticação, 13/10/2026); o erro exato sem ele: [NC], aqui 400;
//   - o cliente duplicado é aceito (criar cliente, 08/09/2026): quem cria procura antes;
//   - a cobrança tem o `externalReference` e é procurável por ele (criar cobrança e listar cobranças, 08/09/2026);
//   - o mínimo de R$ 5 por cobrança (Central, editado em 19/08/2026): abaixo, 400;
//   - o vencimento no passado: [NC], aqui recusado (400), o pior caso;
//   - o QR Code devolve a imagem, o copia e cola e a validade (QR Code do PIX, 08/09/2026);
//   - o 429 traz o `RateLimit-Reset` e não traz `Retry-After` (rate e quota limit, 13/10/2026);
//   - o erro vem em `errors: [{ code, description }]`;
//   - remover (`DELETE /payments/{id}`) responde `{ deleted: true, id }` (excluir cobrança, 08/09/2026); remover a
//     cobrança já recebida: [NC], aqui recusado (400); ler a cobrança removida: [NC], aqui 404, o pior caso;
//   - o aviso traz o `id` do evento, o `event` e o objeto `payment`, com `paymentDate`, `clientPaymentDate` e
//     `confirmedDate` (eventos para cobranças, 13/10/2026), e o token no cabeçalho `asaas-access-token`;
//   - os avisos da conta (W2a, parte 3a): criar (`POST /webhooks`) pede `name`, `url`, `email`, `enabled`, `interrupted`,
//     `sendType` e `events` (criar webhook, 08/09/2026), o token de 32 a 255 letras sem espaço e até 10 avisos por conta
//     (criar webhook pela API, 13/10/2026); a resposta traz o `hasAuthToken`, não o token (o esquema da resposta; a página
//     diz que o token volta na criação [NC]: o pior caso é não voltar); listar (`GET /webhooks`) traz `enabled`,
//     `interrupted`, `hasAuthToken`, `sendType`, `events` e `penalizedRequestsCount` (listar webhooks, 08/09/2026);
//     atualizar (`PUT /webhooks/{id}`) muda só o que vem no corpo, e o e-mail e a versão da API não entram (atualizar
//     webhook, 08/09/2026; o que acontece se vierem: [NC], aqui recusado, 400); `interrupted: false` faz a fila andar
//     (como reativar fila interrompida, 28/08/2026); remover (`DELETE /webhooks/{id}`) responde [NC], aqui
//     `{ deleted: true, id }`, como a cobrança;
//   - o estorno (W2a, parte 3b; estornar cobrança, 08/09/2026; estornos, 04/08/2026; eventos para cobranças, 27/10/2026):
//     `POST /payments/{id}/refund`, sem valor integral, responde a cobrança com o array `refunds` (a situação, o valor, a
//     data e a descrição); só a cobrança recebida ou confirmada é estornada (a outra: [NC], aqui 400); o total estornado não
//     passa do valor (400); o saldo que falta no PIX logo depois do recebimento é 400 (o código exato: [NC]); pedir de novo:
//     [NC], aqui aceito enquanto o total cabe, o pior caso (devolveria duas vezes, se o total deixasse). A cobrança fica
//     `REFUND_REQUESTED` enquanto o estorno não está feito, e `REFUNDED` com ele feito.
// O teste escolhe como cada caminho responde, e lê o que foi pedido (`vistos`).

/** A chave da conta de teste, num nome neutro e longe do cabeçalho do pedido (o gitleaks lê a chave do lado do nome, ERR-131). */
export const CHAVE_DE_TESTE_DO_ASAAS = '$aact_hmlg_teste-do-liame-sem-valor-nenhum';
/** O token do aviso nos testes (de 32 a 255 letras, sem espaço), também num nome neutro (V101, ERR-131). */
export const MARCA_DO_AVISO_DE_TESTE = 'marca-do-aviso-do-asaas-de-mentira-com-mais-de-32';

/** Como um caminho do Asaas responde: bem, fora do ar (503), pedindo pausa (429) ou recusando a chave (401). */
export type RespostaDoAsaas = 'ok' | 'fora' | 'sem-cota' | 'chave-recusada';

type Visto = { metodo: string; caminho: string; busca: URLSearchParams; corpo: Record<string, unknown> | null; userAgent: string | null };

export type ClienteNoAsaas = { id: string; name: string; cpfCnpj: string; externalReference: string | null; notificationDisabled: boolean; deleted: boolean };

export type CobrancaNoAsaas = {
  id: string;
  customer: string;
  billingType: string;
  value: number;
  dueDate: string;
  description: string | null;
  externalReference: string | null;
  status: string;
  invoiceUrl: string;
  deleted: boolean;
  paymentDate: string | null;
  clientPaymentDate: string | null;
  confirmedDate: string | null;
  /** Os estornos da cobrança (o array `refunds`). */
  refunds: EstornoNoAsaas[];
};

/** Um estorno da cobrança, como o Asaas o devolve (o esquema não tem id). */
export type EstornoNoAsaas = { status: string; value: number; dateCreated: string; description: string | null };

/** Um aviso (webhook) da conta. O token fica guardado e nunca sai na resposta (só o `hasAuthToken`). */
export type AvisoNoAsaas = {
  id: string;
  name: string;
  url: string;
  email: string;
  enabled: boolean;
  interrupted: boolean;
  apiVersion: number;
  segredo: string | null;
  sendType: string;
  events: string[];
  penalizedRequestsCount: number;
};

/** O aviso como o Asaas o devolve (`WebhookConfigGetResponseDTO`): sem o token. */
const avisoParaFora = (a: AvisoNoAsaas) => ({
  object: 'webhook',
  id: a.id,
  name: a.name,
  url: a.url,
  email: a.email,
  enabled: a.enabled,
  interrupted: a.interrupted,
  apiVersion: a.apiVersion,
  hasAuthToken: a.segredo !== null,
  sendType: a.sendType,
  penalizedRequestsCount: a.penalizedRequestsCount,
  events: [...a.events],
});

/** O token do aviso como o Asaas aceita (criar webhook pela API, 13/10/2026): de 32 a 255 letras, sem espaço. */
const segredoAceito = (v: unknown): v is string => typeof v === 'string' && v.length >= 32 && v.length <= 255 && ![...v].some((l) => l.trim() === '');

type Resposta = { status: number; corpo: unknown; cabecalhos?: Record<string, string> };

const erro = (status: number, code: string, description: string, cabecalhos?: Record<string, string>): Resposta => ({
  status,
  corpo: { errors: [{ code, description }] },
  ...(cabecalhos ? { cabecalhos } : {}),
});

/**
 * Um id novo do Asaas (`cus_…`, `pay_…`), único entre as execuções, como os de verdade: o banco de teste não é zerado
 * entre uma execução e outra, e um id em sequência repetiria o da anterior no índice único da cobrança (ERR-173).
 */
const novoId = (prefixo: 'cus' | 'pay' | 'wh'): string => `${prefixo}_${randomBytes(6).toString('hex')}`;

/** O dia de hoje no Brasil (o Asaas é daqui). */
const hojeNoBrasil = (): string => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

export class AsaasDeMentira {
  base = '';
  readonly vistos: Visto[] = [];
  readonly clientes: ClienteNoAsaas[] = [];
  readonly cobrancas: CobrancaNoAsaas[] = [];
  /** Os avisos (webhooks) da conta. */
  readonly avisosDaConta: AvisoNoAsaas[] = [];
  /** Como responde a lista dos avisos (a conferência do aviso, W2a, parte 3a). */
  listarAvisos: RespostaDoAsaas = 'ok';
  /** Como respondem criar a cobrança, ler o QR Code e ler uma cobrança pelo id. */
  criar: RespostaDoAsaas = 'ok';
  qrCode: RespostaDoAsaas = 'ok';
  ler: RespostaDoAsaas = 'ok';
  /** O Asaas cria a cobrança e a conexão cai antes da resposta (503): a cobrança ficou lá. */
  caiDepoisDeCriar = false;
  /** O que o 429 manda esperar, em segundos (`RateLimit-Reset`). */
  resetEmSegundos = '120';
  /** Segura a resposta de criar a cobrança até o teste soltar (para dois caminhos ao mesmo tempo). */
  segurarCriacao: Promise<void> | null = null;
  /** Segura a resposta de ler uma cobrança pelo id até o teste soltar (o aviso que chega no meio da releitura). */
  segurarLeitura: Promise<void> | null = null;
  /**
   * O endereço da fatura hospedada e a situação da cobrança nova. O padrão segue a documentação (`invoiceUrl` em https,
   * `status: PENDING`); o teste troca pelo pior caso para conferir o que o banco aceita (V43).
   */
  enderecoDaFatura: (id: string) => string = (id) => `https://sandbox.asaas.com/i/${id}`;
  situacaoNova = 'PENDING';
  /** Como responde o pedido de estorno: bem, fora do ar, recusando a chave ou sem saldo na conta (400). */
  estornar: RespostaDoAsaas | 'sem-saldo' = 'ok';
  /** A situação do estorno novo: `PENDING` (o padrão), `DONE` na hora, ou a que espera uma autorização. */
  situacaoDoEstorno = 'PENDING';
  /** O Asaas estorna e a conexão cai antes da resposta (503): o estorno ficou lá. */
  caiDepoisDeEstornar = false;
  private servidor: Server | null = null;
  private readonly anterior: Record<string, string | undefined> = {};
  private avisos = 0;

  async subir(): Promise<void> {
    this.servidor = createServer((req, res) => {
      let texto = '';
      req.on('data', (c: Buffer) => {
        texto += c.toString('utf8');
      });
      req.on('end', () => {
        void this.responder(req, texto).then(
          (r) => {
            res.writeHead(r.status, { 'content-type': 'application/json', ...(r.cabecalhos ?? {}) });
            res.end(JSON.stringify(r.corpo));
          },
          () => {
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ errors: [{ code: 'erro_do_teste', description: 'o Asaas de mentira falhou' }] }));
          },
        );
      });
    });
    const servidor = this.servidor;
    await new Promise<void>((ok) => servidor.listen(0, '127.0.0.1', ok));
    this.base = `http://127.0.0.1:${(servidor.address() as AddressInfo).port}`;
    const ambiente: Record<string, string> = {
      ASAAS_API_URL: `${this.base}/v3`,
      ASAAS_API_KEY: CHAVE_DE_TESTE_DO_ASAAS,
      ASAAS_WEBHOOK_TOKEN: MARCA_DO_AVISO_DE_TESTE,
    };
    for (const k of Object.keys(ambiente)) this.anterior[k] = process.env[k];
    Object.assign(process.env, ambiente);
  }

  async fechar(): Promise<void> {
    const servidor = this.servidor;
    if (servidor) await new Promise((ok) => servidor.close(ok));
    for (const [k, v] of Object.entries(this.anterior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }

  /** As cobranças criadas para uma fatura do Liame (pelo `externalReference`). */
  cobrancasDa(faturaId: string): CobrancaNoAsaas[] {
    return this.cobrancas.filter((c) => c.externalReference === faturaId);
  }

  /** O cliente paga a cobrança: a situação (no PIX, `RECEIVED`), o dia e, se o teste quiser, outro valor. */
  pagar(id: string, dia: string, opcoes: { situacao?: string; valor?: number } = {}): CobrancaNoAsaas {
    const c = this.cobrancas.find((x) => x.id === id);
    if (!c) throw new Error(`o Asaas de mentira não tem a cobrança ${id}`);
    c.status = opcoes.situacao ?? 'RECEIVED';
    if (opcoes.valor !== undefined) c.value = opcoes.valor;
    c.paymentDate = dia;
    c.clientPaymentDate = dia;
    c.confirmedDate = dia;
    return c;
  }

  /** O estorno em andamento fica feito (ou com outra situação): a cobrança vira `REFUNDED` quando o feito cobre o valor. */
  concluirEstorno(id: string, situacao = 'DONE'): CobrancaNoAsaas {
    const c = this.cobrancas.find((x) => x.id === id);
    if (!c) throw new Error(`o Asaas de mentira não tem a cobrança ${id}`);
    for (const e of c.refunds) if (e.status !== 'DONE' && e.status !== 'CANCELLED') e.status = situacao;
    this.situacaoPelosEstornos(c);
    return c;
  }

  private situacaoPelosEstornos(c: CobrancaNoAsaas): void {
    const feito = c.refunds.filter((e) => e.status === 'DONE').reduce((t, e) => t + e.value, 0);
    const andando = c.refunds.some((e) => e.status !== 'DONE' && e.status !== 'CANCELLED');
    if (feito >= c.value) c.status = 'REFUNDED';
    else if (andando) c.status = 'REFUND_REQUESTED';
  }

  /** A fila de um aviso para (15 falhas seguidas, penalização de filas): o Asaas marca `interrupted`. */
  pararFila(id: string): void {
    const a = this.avisosDaConta.find((x) => x.id === id);
    if (!a) throw new Error(`o Asaas de mentira não tem o aviso ${id}`);
    a.interrupted = true;
    a.penalizedRequestsCount = 15;
  }

  /** Um aviso posto na conta por fora (pelo painel, ou por outro worker), com o que o teste quiser. */
  porAviso(a: Partial<AvisoNoAsaas> & { url: string }): AvisoNoAsaas {
    const aviso: AvisoNoAsaas = {
      id: novoId('wh'),
      name: 'Liame',
      email: 'suporte@agencialiame.com',
      enabled: true,
      interrupted: false,
      apiVersion: 3,
      segredo: MARCA_DO_AVISO_DE_TESTE,
      sendType: 'SEQUENTIALLY',
      events: [],
      penalizedRequestsCount: 0,
      ...a,
    };
    this.avisosDaConta.push(aviso);
    return aviso;
  }

  /** Alguém remove a cobrança no painel do Asaas. */
  removerNoPainel(id: string): void {
    const c = this.cobrancas.find((x) => x.id === id);
    if (c) c.deleted = true;
  }

  /** O corpo do aviso, como o Asaas o manda (eventos para cobranças, 13/10/2026): o id do evento é único por envio. */
  aviso(cobranca: CobrancaNoAsaas, evento = 'PAYMENT_RECEIVED'): string {
    this.avisos += 1;
    return JSON.stringify({
      id: `evt_${randomBytes(16).toString('hex')}&${this.avisos}`,
      event: evento,
      dateCreated: `${hojeNoBrasil()} 10:00:00`,
      account: { id: '47ed0d25-f9fb-4b35-b23a-d8895caf92b7', ownerId: null },
      payment: { object: 'payment', ...cobranca },
    });
  }

  private async responder(req: IncomingMessage, texto: string): Promise<Resposta> {
    const url = new URL(req.url ?? '/', 'http://asaas.local');
    const caminho = url.pathname.replace(/^\/v3/, '');
    let corpo: Record<string, unknown> | null = null;
    try {
      corpo = texto ? (JSON.parse(texto) as Record<string, unknown>) : null;
    } catch {
      return erro(400, 'invalid_json', 'O corpo da requisição não é um JSON válido');
    }
    const userAgent = typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null;
    const metodo = req.method ?? 'GET';
    this.vistos.push({ metodo, caminho, busca: url.searchParams, corpo, userAgent });

    if (req.headers['access_token'] !== CHAVE_DE_TESTE_DO_ASAAS) return erro(401, 'invalid_access_token', 'A chave de API fornecida é inválida');
    if (!userAgent) return erro(400, 'user_agent_required', 'O header User-Agent é obrigatório');

    if (metodo === 'GET' && caminho === '/customers') {
      const ref = url.searchParams.get('externalReference');
      const data = this.clientes.filter((c) => ref === null || c.externalReference === ref);
      return { status: 200, corpo: { object: 'list', hasMore: false, totalCount: data.length, limit: 10, offset: 0, data } };
    }
    if (metodo === 'POST' && caminho === '/customers') {
      const name = typeof corpo?.name === 'string' ? corpo.name : '';
      const cpfCnpj = typeof corpo?.cpfCnpj === 'string' ? corpo.cpfCnpj : '';
      if (!name) return erro(400, 'invalid_name', 'O nome do cliente é obrigatório');
      if (cpfCnpj.length !== 11 && cpfCnpj.length !== 14) return erro(400, 'invalid_cpfCnpj', 'O CPF/CNPJ informado é inválido');
      const cliente: ClienteNoAsaas = {
        id: novoId('cus'),
        name,
        cpfCnpj,
        externalReference: typeof corpo?.externalReference === 'string' ? corpo.externalReference : null,
        notificationDisabled: corpo?.notificationDisabled === true,
        deleted: false,
      };
      this.clientes.push(cliente);
      return { status: 200, corpo: { object: 'customer', ...cliente } };
    }
    if (metodo === 'GET' && caminho === '/payments') {
      const ref = url.searchParams.get('externalReference');
      const data = this.cobrancas.filter((c) => ref === null || c.externalReference === ref).map((c) => ({ object: 'payment', ...c }));
      return { status: 200, corpo: { object: 'list', hasMore: false, totalCount: data.length, limit: 10, offset: 0, data } };
    }
    if (metodo === 'POST' && caminho === '/payments') {
      if (this.criar === 'fora') return erro(503, 'service_unavailable', 'Serviço indisponível');
      if (this.criar === 'chave-recusada') return erro(401, 'invalid_access_token', 'A chave de API fornecida é inválida');
      if (this.criar === 'sem-cota') {
        return erro(429, 'rate_limit_exceeded', 'Cota de requisições das últimas 12 horas excedida.', {
          'RateLimit-Limit': '25000',
          'RateLimit-Remaining': '0',
          'RateLimit-Reset': this.resetEmSegundos,
        });
      }
      const customer = typeof corpo?.customer === 'string' ? corpo.customer : '';
      if (!this.clientes.some((c) => c.id === customer && !c.deleted)) return erro(400, 'invalid_customer', 'Cliente inválido ou inexistente');
      if (corpo?.billingType !== 'PIX' && corpo?.billingType !== 'CREDIT_CARD' && corpo?.billingType !== 'UNDEFINED') return erro(400, 'invalid_billingType', 'Forma de pagamento inválida');
      const value = typeof corpo?.value === 'number' ? corpo.value : 0;
      if (value < 5) return erro(400, 'invalid_value', 'O valor da cobrança não pode ser menor que R$ 5,00');
      const dueDate = typeof corpo?.dueDate === 'string' ? corpo.dueDate : '';
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate) || dueDate < hojeNoBrasil()) return erro(400, 'invalid_dueDate', 'A data de vencimento não pode ser anterior à data atual');
      if (this.segurarCriacao) await this.segurarCriacao;
      const id = novoId('pay');
      const cobranca: CobrancaNoAsaas = {
        id,
        customer,
        billingType: corpo.billingType as string,
        value,
        dueDate,
        description: typeof corpo?.description === 'string' ? corpo.description : null,
        externalReference: typeof corpo?.externalReference === 'string' ? corpo.externalReference : null,
        status: this.situacaoNova,
        invoiceUrl: this.enderecoDaFatura(id),
        deleted: false,
        paymentDate: null,
        clientPaymentDate: null,
        confirmedDate: null,
        refunds: [],
      };
      this.cobrancas.push(cobranca);
      if (this.caiDepoisDeCriar) return erro(503, 'service_unavailable', 'Serviço indisponível');
      return { status: 200, corpo: { object: 'payment', ...cobranca } };
    }
    const qr = /^\/payments\/([a-z0-9_]+)\/pixQrCode$/.exec(caminho);
    if (metodo === 'GET' && qr) {
      if (this.qrCode === 'fora') return erro(503, 'service_unavailable', 'Serviço indisponível');
      const c = this.cobrancas.find((x) => x.id === qr[1]);
      if (!c) return erro(404, 'not_found', 'Cobrança não encontrada');
      return { status: 200, corpo: { encodedImage: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQABpfZFQAAAAABJRU5ErkJggg==', payload: `00020101021226820014br.gov.bcb.pix2560${c.id}5204000053039865802BR`, expirationDate: '2027-10-23 23:59:59' } };
    }
    const estornar = /^\/payments\/([a-z0-9_]+)\/refund$/.exec(caminho);
    if (metodo === 'POST' && estornar) {
      if (this.estornar === 'fora') return erro(503, 'service_unavailable', 'Serviço indisponível');
      if (this.estornar === 'chave-recusada') return erro(401, 'invalid_access_token', 'A chave de API fornecida é inválida');
      const c = this.cobrancas.find((x) => x.id === estornar[1]);
      if (!c || c.deleted) return erro(404, 'not_found', 'Cobrança não encontrada');
      if (!['RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH', 'REFUND_REQUESTED'].includes(c.status)) return erro(400, 'invalid_action', 'Não é possível estornar esta cobrança');
      if (this.estornar === 'sem-saldo') return erro(400, 'insufficient_balance', 'Saldo insuficiente para realizar o estorno');
      const jaEstornado = c.refunds.filter((e) => e.status !== 'CANCELLED').reduce((t, e) => t + e.value, 0);
      const valor = typeof corpo?.value === 'number' ? corpo.value : c.value - jaEstornado;
      if (valor <= 0 || jaEstornado + valor > c.value + 1e-9) return erro(400, 'invalid_value', 'O valor do estorno ultrapassa o valor da cobrança');
      c.refunds.push({ status: this.situacaoDoEstorno, value: valor, dateCreated: `${hojeNoBrasil()} 10:00:00`, description: typeof corpo?.description === 'string' ? corpo.description : null });
      this.situacaoPelosEstornos(c);
      if (this.caiDepoisDeEstornar) return erro(503, 'service_unavailable', 'Serviço indisponível');
      return { status: 200, corpo: { object: 'payment', ...c } };
    }
    const uma = /^\/payments\/([a-z0-9_]+)$/.exec(caminho);
    if (metodo === 'GET' && uma) {
      if (this.ler === 'fora') return erro(503, 'service_unavailable', 'Serviço indisponível');
      if (this.segurarLeitura) await this.segurarLeitura;
      const c = this.cobrancas.find((x) => x.id === uma[1]);
      // A removida: o pior caso (o que a documentação não diz) é o 404.
      return c && !c.deleted ? { status: 200, corpo: { object: 'payment', ...c } } : erro(404, 'not_found', 'Cobrança não encontrada');
    }
    if (metodo === 'DELETE' && uma) {
      const c = this.cobrancas.find((x) => x.id === uma[1]);
      if (!c || c.deleted) return erro(404, 'not_found', 'Cobrança não encontrada');
      if (c.status === 'RECEIVED' || c.status === 'CONFIRMED' || c.status === 'RECEIVED_IN_CASH') {
        return erro(400, 'invalid_action', 'Não é possível remover uma cobrança já recebida');
      }
      c.deleted = true;
      return { status: 200, corpo: { deleted: true, id: c.id } };
    }
    if (metodo === 'GET' && caminho === '/webhooks') {
      if (this.listarAvisos === 'fora') return erro(503, 'service_unavailable', 'Serviço indisponível');
      if (this.listarAvisos === 'chave-recusada') return erro(401, 'invalid_access_token', 'A chave de API fornecida é inválida');
      const data = this.avisosDaConta.map(avisoParaFora);
      return { status: 200, corpo: { object: 'list', hasMore: false, totalCount: data.length, limit: Number(url.searchParams.get('limit') ?? 10), offset: 0, data } };
    }
    if (metodo === 'POST' && caminho === '/webhooks') {
      const c = corpo ?? {};
      for (const campo of ['name', 'url', 'email', 'sendType']) {
        const v = c[campo];
        if (typeof v !== 'string' || !v) return erro(400, `invalid_${campo}`, `O campo ${campo} é obrigatório`);
      }
      if (typeof c.enabled !== 'boolean' || typeof c.interrupted !== 'boolean') return erro(400, 'invalid_enabled', 'Os campos enabled e interrupted são obrigatórios');
      if (!Array.isArray(c.events) || c.events.length === 0) return erro(400, 'invalid_events', 'Informe os eventos do webhook');
      if (c.sendType !== 'SEQUENTIALLY' && c.sendType !== 'NON_SEQUENTIALLY') return erro(400, 'invalid_sendType', 'Tipo de envio inválido');
      if (c.authToken !== undefined && !segredoAceito(c.authToken)) return erro(400, 'invalid_authToken', 'O token deve ter de 32 a 255 caracteres, sem espaços');
      if (this.avisosDaConta.length >= 10) return erro(400, 'webhook_limit', 'A conta já tem 10 webhooks');
      const aviso: AvisoNoAsaas = {
        id: novoId('wh'),
        name: c.name as string,
        url: c.url as string,
        email: c.email as string,
        enabled: c.enabled as boolean,
        interrupted: c.interrupted as boolean,
        apiVersion: typeof c.apiVersion === 'number' ? c.apiVersion : 3,
        segredo: typeof c.authToken === 'string' ? c.authToken : null,
        sendType: c.sendType as string,
        events: (c.events as unknown[]).filter((e): e is string => typeof e === 'string'),
        penalizedRequestsCount: 0,
      };
      this.avisosDaConta.push(aviso);
      return { status: 200, corpo: avisoParaFora(aviso) };
    }
    const umAviso = /^\/webhooks\/([a-z0-9_]+)$/.exec(caminho);
    if (metodo === 'PUT' && umAviso) {
      const a = this.avisosDaConta.find((x) => x.id === umAviso[1]);
      if (!a) return erro(404, 'not_found', 'Webhook não encontrado');
      const c = corpo ?? {};
      if ('email' in c || 'apiVersion' in c) return erro(400, 'invalid_field', 'O e-mail e a versão da API não mudam por aqui');
      if (c.authToken !== undefined && !segredoAceito(c.authToken)) return erro(400, 'invalid_authToken', 'O token deve ter de 32 a 255 caracteres, sem espaços');
      if (typeof c.name === 'string') a.name = c.name;
      if (typeof c.url === 'string') a.url = c.url;
      if (typeof c.enabled === 'boolean') a.enabled = c.enabled;
      if (typeof c.interrupted === 'boolean') {
        a.interrupted = c.interrupted;
        if (!c.interrupted) a.penalizedRequestsCount = 0;
      }
      if (typeof c.authToken === 'string') a.segredo = c.authToken;
      if (typeof c.sendType === 'string') a.sendType = c.sendType;
      if (Array.isArray(c.events)) a.events = c.events.filter((e): e is string => typeof e === 'string');
      return { status: 200, corpo: avisoParaFora(a) };
    }
    if (metodo === 'DELETE' && umAviso) {
      const i = this.avisosDaConta.findIndex((x) => x.id === umAviso[1]);
      if (i < 0) return erro(404, 'not_found', 'Webhook não encontrado');
      const [a] = this.avisosDaConta.splice(i, 1);
      return { status: 200, corpo: { deleted: true, id: a!.id } };
    }
    return erro(404, 'not_found', 'Recurso não encontrado');
  }
}
