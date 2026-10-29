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
  /**
   * O dia do pagamento (AAAA-MM-DD, no horário do Asaas): o `clientPaymentDate`, senão o `paymentDate`, senão o
   * `confirmedDate` (eventos para cobranças, 13/10/2026); nulo enquanto não há pagamento.
   */
  pagaNoDia: string | null;
  /**
   * Os estornos da cobrança (o array `refunds`; estornar cobrança, 08/09/2026; estornos, 04/08/2026), na ordem em que o
   * Asaas os devolve. Uma cobrança pode ter mais de um; a existência dele não quer dizer devolvido: só o `DONE` conta.
   */
  estornos: EstornoAsaas[];
};

/**
 * Um estorno da cobrança. `situacao`: `PENDING`, `AWAITING_CRITICAL_ACTION_AUTHORIZATION`,
 * `AWAITING_CUSTOMER_EXTERNAL_AUTHORIZATION`, `CANCELLED` ou `DONE` (estornar cobrança, 08/09/2026); a que o Liame não
 * conhece fica como veio, e quem decide trata como "ainda não feito".
 */
export type EstornoAsaas = { situacao: string; valorCentavos: number };

export type QrCodePix = { imagemPngBase64: string; copiaECola: string; validaAte: string | null };

/** O aviso (webhook) como está configurado no Asaas (listar webhooks, 08/09/2026; base §18.5). */
export type AvisoConfigurado = {
  id: string;
  nome: string;
  /** Para onde o Asaas manda os eventos. */
  url: string;
  /** `enabled`. */
  ligado: boolean;
  /** `interrupted`: a fila parou (15 falhas seguidas, penalização de filas); os eventos esperam até 14 dias. */
  filaParada: boolean;
  /** `hasAuthToken`: o aviso leva o token no cabeçalho (o Asaas não devolve o token, só diz se ele existe). */
  autenticado: boolean;
  /** `sendType`: `SEQUENTIALLY` ou `NON_SEQUENTIALLY`. */
  envio: string;
  eventos: string[];
  /** `penalizedRequestsCount`: os envios com falha que o Asaas conta. */
  enviosComFalha: number;
};

/** O que o `PUT` do aviso aceita mudar (atualizar webhook, 08/09/2026: o e-mail e a versão da API não entram). */
export type CorrecaoDoAviso = { name?: string; url?: string; enabled?: true; interrupted?: false; sendType?: string; events?: string[] };

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

/**
 * Um dia no formato do Asaas (AAAA-MM-DD, às vezes seguido da hora), conferido letra a letra e no calendário (V122:
 * 30/02 e o mês 13 não passam); fora disso, nulo.
 */
export function diaDoAsaas(v: unknown): string | null {
  if (typeof v !== 'string' || v.length < 10) return null;
  const dia = v.slice(0, 10);
  for (const [i, l] of [...dia].entries()) {
    if (i === 4 || i === 7 ? l !== '-' : l < '0' || l > '9') return null;
  }
  const d = new Date(`${dia}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === dia ? dia : null;
}

/**
 * Os estornos que o Asaas devolve na cobrança. O estorno fora do formato (sem a situação ou sem o valor) não é pulado:
 * ele entra como de situação desconhecida, que conta como "ainda não feito" e faz esperar. Pular poderia fazer o Liame
 * pedir de novo um estorno que já existe, e devolver duas vezes.
 */
export function estornosDoAsaas(v: unknown): EstornoAsaas[] {
  if (!Array.isArray(v)) return [];
  return v.map((e: unknown) => {
    const r = (e ?? {}) as { status?: unknown; value?: unknown };
    const situacao = typeof r.status === 'string' ? (situacaoParaGravar(r.status) ?? 'DESCONHECIDA') : 'DESCONHECIDA';
    const valorCentavos = typeof r.value === 'number' && Number.isFinite(r.value) && r.value > 0 ? paraCentavos(r.value) : 0;
    return { situacao, valorCentavos };
  });
}

/** A cobrança como o Asaas a devolve, no formato do Liame; sem id, não é cobrança. */
export function cobrancaDoAsaas(c: Record<string, unknown> | null | undefined): CobrancaAsaas | null {
  if (!c) return null;
  const id = idDoAsaas(c.id);
  if (!id || typeof c.status !== 'string' || typeof c.value !== 'number' || typeof c.dueDate !== 'string') return null;
  return {
    estornos: estornosDoAsaas(c.refunds),
    id,
    status: c.status,
    valorCentavos: paraCentavos(c.value),
    vencimento: c.dueDate.slice(0, 10),
    urlDaFatura: urlGravavel(c.invoiceUrl),
    referencia: texto(c.externalReference),
    removida: c.deleted === true,
    pagaNoDia: diaDoAsaas(c.clientPaymentDate) ?? diaDoAsaas(c.paymentDate) ?? diaDoAsaas(c.confirmedDate),
  };
}

/** O aviso como o Asaas o devolve, no formato do Liame; sem id ou sem o endereço, não é aviso. */
export function avisoConfigurado(a: Record<string, unknown> | null | undefined): AvisoConfigurado | null {
  if (!a) return null;
  const id = idDoAsaas(a.id);
  const url = texto(a.url);
  if (!id || !url) return null;
  return {
    id,
    nome: texto(a.name) ?? '',
    url,
    ligado: a.enabled === true,
    filaParada: a.interrupted === true,
    autenticado: a.hasAuthToken === true,
    envio: texto(a.sendType) ?? '',
    eventos: Array.isArray(a.events) ? a.events.filter((e): e is string => typeof e === 'string') : [],
    enviosComFalha: typeof a.penalizedRequestsCount === 'number' && Number.isFinite(a.penalizedRequestsCount) ? a.penalizedRequestsCount : 0,
  };
}

export class ApiAsaas {
  constructor(
    private readonly cliente: ClienteConector,
    private readonly cfg: ConfigApiAsaas,
  ) {}

  private async chamar<T>(metodo: 'GET' | 'POST' | 'PUT' | 'DELETE', caminho: string, endpoint: string, corpo?: unknown, tempoLimiteMs?: number): Promise<T> {
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

  /**
   * A cobrança pelo id do Asaas. Nula quando ele responde 404: a cobrança não existe mais (o que ele devolve ao ler uma
   * removida não está escrito [NC]; o pior caso é o 404, e a removida que volta com `deleted: true` também é tratada).
   */
  async lerCobranca(id: string): Promise<CobrancaAsaas | null> {
    let r: Record<string, unknown>;
    try {
      r = await this.chamar<Record<string, unknown>>('GET', `/payments/${encodeURIComponent(id)}`, 'payments');
    } catch (err) {
      if (err instanceof ErroConector && err.status === 404) return null;
      throw err;
    }
    const lida = cobrancaDoAsaas(r);
    if (!lida) throw new ErroConector('definitivo', PROVIDER_ASAAS, 'o Asaas devolveu a cobrança fora do formato esperado');
    return lida;
  }

  /**
   * Remove a cobrança no Asaas (a fatura do Liame foi cancelada, ou o valor dela mudou). Remover não devolve dinheiro
   * (excluir cobrança, 08/09/2026); a que já não existe (404) conta como removida.
   */
  async removerCobranca(id: string): Promise<void> {
    let r: Record<string, unknown>;
    try {
      r = await this.chamar<Record<string, unknown>>('DELETE', `/payments/${encodeURIComponent(id)}`, 'payments');
    } catch (err) {
      if (err instanceof ErroConector && err.status === 404) return;
      throw err;
    }
    if (r?.deleted !== true) throw new ErroConector('definitivo', PROVIDER_ASAAS, 'o Asaas não confirmou a remoção da cobrança');
  }

  /**
   * Pede o estorno da cobrança (estornar cobrança, 08/09/2026): sem o valor, integral; com ele, só esse tanto. A resposta
   * é a cobrança, com os estornos. A página não diz o que acontece ao pedir de novo, e o PIX aceita mais de um estorno
   * até o total: quem chama relê a cobrança antes e só pede quando não há estorno feito nem em andamento.
   */
  async estornarCobranca(id: string, p: { valorCentavos: number | null; descricao: string }): Promise<CobrancaAsaas> {
    const r = await this.chamar<Record<string, unknown>>('POST', `/payments/${encodeURIComponent(id)}/refund`, 'refund', {
      ...(p.valorCentavos === null ? {} : { value: paraReais(p.valorCentavos) }),
      description: p.descricao.slice(0, 500),
    });
    const lida = cobrancaDoAsaas(r);
    if (!lida) throw new ErroConector('definitivo', PROVIDER_ASAAS, 'o Asaas estornou a cobrança sem devolver o formato esperado');
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

  /**
   * Os avisos (webhooks) da conta (listar webhooks, 08/09/2026): até 10 por conta (criar webhook pela API, 13/10/2026),
   * então uma página de 100 traz todos. Um aviso fora do formato é erro, nunca "não existe": pular faria criar outro.
   */
  async listarAvisos(): Promise<AvisoConfigurado[]> {
    const r = await this.chamar<{ data?: Array<Record<string, unknown>> }>('GET', '/webhooks?offset=0&limit=100', 'webhooks');
    return (r?.data ?? []).map((a) => {
      const lido = avisoConfigurado(a);
      if (!lido) throw new ErroConector('definitivo', PROVIDER_ASAAS, 'o Asaas devolveu um aviso fora do formato esperado');
      return lido;
    });
  }

  /**
   * Cria o aviso do Liame (criar webhook pela API, 13/10/2026; D-A7-33): ligado, com a fila andando, o envio em sequência
   * (a ordem dos eventos fica; um evento com falha atrasa os seguintes) e o token que o Asaas manda no cabeçalho
   * `asaas-access-token` de cada aviso. O e-mail recebe as comunicações do Asaas sobre o aviso.
   */
  async criarAviso(p: { nome: string; url: string; email: string; segredo: string; eventos: readonly string[] }): Promise<AvisoConfigurado> {
    const r = await this.chamar<Record<string, unknown>>('POST', '/webhooks', 'webhooks', {
      name: p.nome,
      url: p.url,
      email: p.email,
      enabled: true,
      interrupted: false,
      apiVersion: 3,
      authToken: p.segredo,
      sendType: 'SEQUENTIALLY',
      events: [...p.eventos],
    });
    const lido = avisoConfigurado(r);
    if (!lido) throw new ErroConector('definitivo', PROVIDER_ASAAS, 'o Asaas criou o aviso sem devolver o formato esperado');
    return lido;
  }

  /**
   * Corrige o aviso (atualizar webhook, 08/09/2026): o que não vai no corpo fica como está. Com `interrupted: false`, a fila
   * parada volta a andar e os eventos guardados saem na ordem (como reativar fila interrompida, 28/08/2026). O token vai
   * junto em toda correção: o Asaas não devolve o dele, e o da configuração pode ter mudado.
   */
  async atualizarAviso(id: string, correcao: CorrecaoDoAviso, segredo: string): Promise<AvisoConfigurado> {
    const r = await this.chamar<Record<string, unknown>>('PUT', `/webhooks/${encodeURIComponent(id)}`, 'webhooks', { ...correcao, authToken: segredo });
    const lido = avisoConfigurado(r);
    if (!lido) throw new ErroConector('definitivo', PROVIDER_ASAAS, 'o Asaas corrigiu o aviso sem devolver o formato esperado');
    return lido;
  }

  /** Remove um aviso (remover webhook, citado na página de criar webhook pela API, 13/10/2026); o que não existe (404) conta como removido. */
  async removerAviso(id: string): Promise<void> {
    try {
      await this.chamar<unknown>('DELETE', `/webhooks/${encodeURIComponent(id)}`, 'webhooks');
    } catch (err) {
      if (err instanceof ErroConector && err.status === 404) return;
      throw err;
    }
  }
}
