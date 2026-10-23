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
//   - o erro vem em `errors: [{ code, description }]`.
// O teste escolhe como cada caminho responde, e lê o que foi pedido (`vistos`).

/** A chave da conta de teste, num nome neutro e longe do cabeçalho do pedido (o gitleaks lê a chave do lado do nome, ERR-131). */
export const CHAVE_DE_TESTE_DO_ASAAS = '$aact_hmlg_teste-do-liame-sem-valor-nenhum';

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
};

type Resposta = { status: number; corpo: unknown; cabecalhos?: Record<string, string> };

const erro = (status: number, code: string, description: string, cabecalhos?: Record<string, string>): Resposta => ({
  status,
  corpo: { errors: [{ code, description }] },
  ...(cabecalhos ? { cabecalhos } : {}),
});

/** O dia de hoje no Brasil (o Asaas é daqui). */
const hojeNoBrasil = (): string => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

export class AsaasDeMentira {
  base = '';
  readonly vistos: Visto[] = [];
  readonly clientes: ClienteNoAsaas[] = [];
  readonly cobrancas: CobrancaNoAsaas[] = [];
  /** Como respondem criar a cobrança e ler o QR Code. */
  criar: RespostaDoAsaas = 'ok';
  qrCode: RespostaDoAsaas = 'ok';
  /** O Asaas cria a cobrança e a conexão cai antes da resposta (503): a cobrança ficou lá. */
  caiDepoisDeCriar = false;
  /** O que o 429 manda esperar, em segundos (`RateLimit-Reset`). */
  resetEmSegundos = '120';
  /** Segura a resposta de criar a cobrança até o teste soltar (para dois caminhos ao mesmo tempo). */
  segurarCriacao: Promise<void> | null = null;
  /**
   * O endereço da fatura hospedada e a situação da cobrança nova. O padrão segue a documentação (`invoiceUrl` em https,
   * `status: PENDING`); o teste troca pelo pior caso para conferir o que o banco aceita (V43).
   */
  enderecoDaFatura: (id: string) => string = (id) => `https://sandbox.asaas.com/i/${id}`;
  situacaoNova = 'PENDING';
  private servidor: Server | null = null;
  private readonly anterior: Record<string, string | undefined> = {};
  private seq = 0;

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
    const ambiente: Record<string, string> = { ASAAS_API_URL: `${this.base}/v3`, ASAAS_API_KEY: CHAVE_DE_TESTE_DO_ASAAS };
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
        id: `cus_${String(++this.seq).padStart(6, '0')}`,
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
      const id = `pay_${String(++this.seq).padStart(6, '0')}`;
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
    const uma = /^\/payments\/([a-z0-9_]+)$/.exec(caminho);
    if (metodo === 'GET' && uma) {
      const c = this.cobrancas.find((x) => x.id === uma[1]);
      return c ? { status: 200, corpo: { object: 'payment', ...c } } : erro(404, 'not_found', 'Cobrança não encontrada');
    }
    return erro(404, 'not_found', 'Recurso não encontrado');
  }
}
