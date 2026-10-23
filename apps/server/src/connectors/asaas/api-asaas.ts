import { type ClienteConector, ErroConector } from '../cliente-http.js';

// A API do Asaas (A7, W2a; `base-conhecimento.md` §18.5): só o que o Liame usa, com os nomes e os formatos da
// documentação oficial. Toda chamada leva a chave no cabeçalho `access_token` e o `User-Agent` (obrigatório para conta
// nova). A API não tem chave de idempotência: quem cria procura antes pelo id do Liame (`externalReference`), e o
// cliente HTTP vem com uma tentativa só (repetir é de quem chama, depois de procurar). Os valores vão em reais com
// centavos (`value: 249.00`); aqui entram e saem em centavos.

export const PROVIDER_ASAAS = 'asaas';
/** A conta é uma só, a do Liame: a cota e o disjuntor do cliente HTTP são dela. */
const CONTA = 'liame';
const VERSAO = 'v3';
/**
 * Quem chama, para o Asaas: o valor do `User-Agent`, obrigatório para as contas criadas desde 13/06/2024. O nome não leva
 * "user": o Semgrep lê constante com "user" no nome e texto fixo como usuário escrito no código (ERR-172).
 */
export const IDENTIDADE_DO_LIAME = 'Liame (agencialiame.com)';

export type ConfigApiAsaas = { url: string; chave: string };

export type ClienteAsaas = { id: string };

export type CobrancaAsaas = {
  id: string;
  /** `PENDING`, `RECEIVED`, `CONFIRMED`, `OVERDUE`, `REFUNDED`… (base §18.5). */
  status: string;
  valorCentavos: number;
  /** AAAA-MM-DD. */
  vencimento: string;
  /** A fatura hospedada, onde se paga fora do Liame. */
  urlDaFatura: string | null;
  /** O id da fatura do Liame. */
  referencia: string | null;
  removida: boolean;
};

export type QrCodePix = { imagemPngBase64: string; copiaECola: string; validaAte: string | null };

/** Centavos para o `value` do Asaas (reais com duas casas). */
export const paraReais = (centavos: number): number => Math.round(centavos) / 100;
/** O `value` do Asaas em centavos. */
export const paraCentavos = (valor: number): number => Math.round(valor * 100);

const texto = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

// O que volta do Asaas e vai para o banco passa antes pelas regras da tabela (V43): o que não cabe faria a gravação cair
// DEPOIS de a cobrança existir lá, e a fatura voltaria à fila para sempre.

/** O id do Asaas (`cus_…`, `pay_…`) como as tabelas aceitam (de 1 a 100 letras). */
const idDoAsaas = (v: unknown): string | null => {
  const t = texto(v);
  return t && t.length <= 100 ? t : null;
};

/** A fatura hospedada como a tabela aceita (`https`, de 12 a 500 letras); fora disso, sem o endereço. */
const urlGravavel = (v: unknown): string | null => {
  const t = texto(v);
  return t && t.length >= 12 && t.length <= 500 && t.startsWith('https://') ? t : null;
};

/**
 * A situação da cobrança como a tabela aceita (de 2 a 60 letras maiúsculas e sublinhado, como `RECEIVED_IN_CASH`); fora
 * disso, desconhecida, e quem relê a cobrança decide. Confere letra a letra, sem expressão regular.
 */
export function situacaoParaGravar(s: string): string | null {
  if (s.length < 2 || s.length > 60) return null;
  for (const l of s) if (!((l >= 'A' && l <= 'Z') || l === '_')) return null;
  return s;
}

/** A cobrança como o Asaas a devolve, no formato do Liame; sem id, não é cobrança. */
export function cobrancaDoAsaas(c: Record<string, unknown> | null | undefined): CobrancaAsaas | null {
  if (!c) return null;
  const id = idDoAsaas(c.id);
  if (!id || typeof c.status !== 'string' || typeof c.value !== 'number' || typeof c.dueDate !== 'string') return null;
  return {
    id,
    status: c.status,
    valorCentavos: paraCentavos(c.value),
    vencimento: c.dueDate.slice(0, 10),
    urlDaFatura: urlGravavel(c.invoiceUrl),
    referencia: texto(c.externalReference),
    removida: c.deleted === true,
  };
}

export class ApiAsaas {
  constructor(
    private readonly cliente: ClienteConector,
    private readonly cfg: ConfigApiAsaas,
  ) {}

  private async chamar<T>(metodo: 'GET' | 'POST', caminho: string, endpoint: string, corpo?: unknown, tempoLimiteMs?: number): Promise<T> {
    const r = await this.cliente.requisitar<T>({
      provider: PROVIDER_ASAAS,
      conta: CONTA,
      url: `${this.cfg.url}${caminho}`,
      metodo,
      endpoint,
      apiVersion: VERSAO,
      cabecalhos: { access_token: this.cfg.chave, 'user-agent': IDENTIDADE_DO_LIAME },
      ...(corpo === undefined ? {} : { corpo }),
      ...(tempoLimiteMs ? { tempoLimiteMs } : {}),
    });
    return r.corpo;
  }

  /** O cliente com o id do Liame (`externalReference`), se já existe e não foi removido. */
  async clientePelaReferencia(referencia: string): Promise<ClienteAsaas | null> {
    const r = await this.chamar<{ data?: Array<Record<string, unknown>> }>('GET', `/customers?externalReference=${encodeURIComponent(referencia)}&limit=10`, 'customers');
    for (const c of r?.data ?? []) {
      const id = idDoAsaas(c.id);
      if (id && c.deleted !== true) return { id };
    }
    return null;
  }

  /** Cria o cliente com as notificações do Asaas desligadas: os avisos de cobrança são do Liame (D-A7-31). */
  async criarCliente(p: { nome: string; cnpj: string; referencia: string }): Promise<ClienteAsaas> {
    const r = await this.chamar<Record<string, unknown>>('POST', '/customers', 'customers', {
      name: p.nome,
      cpfCnpj: p.cnpj,
      externalReference: p.referencia,
      notificationDisabled: true,
    });
    const id = idDoAsaas(r?.id);
    if (!id) throw new ErroConector('definitivo', PROVIDER_ASAAS, 'o Asaas criou o cliente sem devolver o id');
    return { id };
  }

  /**
   * A cobrança com o id da fatura do Liame (`externalReference`), se já existe e não foi removida. Uma cobrança viva fora
   * do formato esperado é erro, nunca "não existe": pular faria criar outra, e a fatura seria cobrada duas vezes.
   */
  async cobrancaPelaReferencia(referencia: string): Promise<CobrancaAsaas | null> {
    const r = await this.chamar<{ data?: Array<Record<string, unknown>> }>('GET', `/payments?externalReference=${encodeURIComponent(referencia)}&limit=10`, 'payments');
    for (const c of r?.data ?? []) {
      if (c.deleted === true) continue;
      const lida = cobrancaDoAsaas(c);
      if (!lida) throw new ErroConector('definitivo', PROVIDER_ASAAS, 'o Asaas devolveu uma cobrança fora do formato esperado');
      return lida;
    }
    return null;
  }

  /** Cria a cobrança PIX de uma fatura (D-A7-30). */
  async criarCobrancaPix(p: { cliente: string; valorCentavos: number; vencimento: string; descricao: string; referencia: string }): Promise<CobrancaAsaas> {
    const r = await this.chamar<Record<string, unknown>>('POST', '/payments', 'payments', {
      customer: p.cliente,
      billingType: 'PIX',
      value: paraReais(p.valorCentavos),
      dueDate: p.vencimento,
      description: p.descricao.slice(0, 500),
      externalReference: p.referencia,
    });
    const lida = cobrancaDoAsaas(r);
    if (!lida) throw new ErroConector('definitivo', PROVIDER_ASAAS, 'o Asaas criou a cobrança sem devolver o formato esperado');
    return lida;
  }

  async lerCobranca(id: string): Promise<CobrancaAsaas> {
    const r = await this.chamar<Record<string, unknown>>('GET', `/payments/${encodeURIComponent(id)}`, 'payments');
    const lida = cobrancaDoAsaas(r);
    if (!lida) throw new ErroConector('definitivo', PROVIDER_ASAAS, 'o Asaas devolveu a cobrança fora do formato esperado');
    return lida;
  }

  /** O QR Code do PIX de uma cobrança: a imagem (PNG em base64), o copia e cola e a validade. */
  async qrCodePix(id: string, tempoLimiteMs?: number): Promise<QrCodePix> {
    const r = await this.chamar<Record<string, unknown>>('GET', `/payments/${encodeURIComponent(id)}/pixQrCode`, 'pixQrCode', undefined, tempoLimiteMs);
    const imagem = texto(r?.encodedImage);
    const copiaECola = texto(r?.payload);
    if (!imagem || !copiaECola) throw new ErroConector('definitivo', PROVIDER_ASAAS, 'o Asaas devolveu o QR Code sem a imagem ou o código');
    return { imagemPngBase64: imagem, copiaECola, validaAte: texto(r?.expirationDate) };
  }
}
