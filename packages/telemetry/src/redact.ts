import type { Attributes, AttributeValue } from '@opentelemetry/api';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base';

type ExportResult = Parameters<Parameters<SpanExporter['export']>[1]>[0];

// Redação de dado pessoal nos spans ANTES de sair do processo (ADR-010, LGPD). O Collector repete a
// redação (defesa em camadas); aqui é o que garante que nem o exportador direto leva PII.

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// CPF e CNPJ com ou sem pontuação. Os limites (?<!\d) e (?!\d) não deixam pegar pedaço de um
// número maior (timestamp, contagem).
const CPF = /(?<!\d)\d{3}\.?\d{3}\.?\d{3}-?\d{2}(?!\d)/g;
const CNPJ = /(?<!\d)\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}(?!\d)/g;
// Telefone: +55 e DDD, com ou sem separadores (10 a 13 dígitos).
const PHONE = /(?<![\d+])(?:\+?55[\s.-]?)?\(?\d{2}\)?[\s.-]?9?\d{4}[\s.-]?\d{4}(?!\d)/g;
const IPV4 = /\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g;
/** Parâmetros de URL que carregam segredo ou dado pessoal. */
const SENSITIVE_PARAMS = /([?&](?:token|code|secret|senha|password|email|telefone|phone|cpf|key)=)[^&#\s]*/gi;
/** Atributos que são endereço de rede de pessoa. */
const IP_KEYS = new Set(['client.address', 'net.peer.ip', 'http.client_ip', 'net.sock.peer.addr', 'network.peer.address', 'source.address']);
/** Atributos que nunca saem, qualquer que seja o valor. */
const DROP_KEYS = new Set(['http.request.header.cookie', 'http.request.header.authorization', 'enduser.id', 'user.email']);

/** O mesmo texto sem dado pessoal, e quantos trechos saíram (o AI Gateway registra a contagem). */
export function redactCounting(value: string): { text: string; removed: number } {
  let removed = 0;
  const swap = (label: string) => () => {
    removed += 1;
    return label;
  };
  const text = value
    .replace(SENSITIVE_PARAMS, (_m, param: string) => swap(`${param}[removido]`)())
    .replace(EMAIL, swap('[email]'))
    .replace(CNPJ, swap('[cnpj]'))
    .replace(CPF, swap('[cpf]'))
    .replace(PHONE, (m) => (m.replace(/\D/g, '').length >= 10 ? swap('[telefone]')() : m));
  return { text, removed };
}

export function redactString(value: string): string {
  return redactCounting(value).text;
}

/** IP de pessoa: guarda só a rede (/24), suficiente para diagnóstico. */
export function maskIp(value: string): string {
  const v4 = value.replace(/^::ffff:/, '');
  return v4.replace(IPV4, '$1.$2.$3.0');
}

function redactValue(key: string, value: AttributeValue): AttributeValue {
  if (typeof value === 'string') return IP_KEYS.has(key) ? maskIp(value) : redactString(value);
  if (Array.isArray(value)) return value.map((v) => (typeof v === 'string' ? redactString(v) : v)) as AttributeValue;
  return value;
}

export function redactAttributes(attributes: Attributes): Attributes {
  const out: Attributes = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined || DROP_KEYS.has(key)) continue;
    out[key] = redactValue(key, value);
  }
  return out;
}

/** Cópia do span com atributos, eventos e nome já limpos. */
export function redactSpan(span: ReadableSpan): ReadableSpan {
  return Object.create(span, {
    name: { value: redactString(span.name) },
    attributes: { value: redactAttributes(span.attributes) },
    events: { value: span.events.map((e) => ({ ...e, name: redactString(e.name), attributes: e.attributes ? redactAttributes(e.attributes) : e.attributes })) },
    status: { value: span.status.message ? { ...span.status, message: redactString(span.status.message) } : span.status },
  }) as ReadableSpan;
}

/** Envolve qualquer exportador: o que sai já foi limpo. */
export class RedactingSpanExporter implements SpanExporter {
  constructor(private readonly inner: SpanExporter) {}

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    this.inner.export(spans.map(redactSpan), resultCallback);
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }

  forceFlush(): Promise<void> {
    return this.inner.forceFlush?.() ?? Promise.resolve();
  }
}
