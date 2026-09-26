import { randomBytes } from 'node:crypto';
import { PROBLEM_TYPE_BASE, type ProblemDetails } from '@liame/contracts';
import { HttpException, HttpStatus } from '@nestjs/common';
import { trace } from '@opentelemetry/api';

export interface FieldError {
  path: string;
  message: string;
}

/** Erro de validação do corpo, da query ou dos parâmetros: 400 com a lista de campos. */
export class ValidationProblem extends HttpException {
  constructor(readonly errors: FieldError[]) {
    super('Dados inválidos', HttpStatus.BAD_REQUEST);
  }
}

/**
 * Erro de domínio com texto próprio para o usuário. `detail` vai para a resposta, então nunca leva
 * dado interno, de outro tenant ou segredo.
 */
export class AppProblem extends HttpException {
  constructor(
    status: number,
    readonly code: string,
    readonly title: string,
    readonly detail: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(title, status);
  }
}

type Issue = { message: string; path?: ReadonlyArray<PropertyKey | { key: PropertyKey }> | undefined };

/** Converte as issues do Standard Schema em `{ path, message }`. */
export function issuesToErrors(issues: readonly Issue[]): FieldError[] {
  return issues.map((issue) => ({
    path:
      (issue.path ?? [])
        .map((p) => (typeof p === 'object' && p !== null && 'key' in p ? String(p.key) : String(p)))
        .join('.') || '(corpo)',
    message: issue.message,
  }));
}

const CATALOG: Record<number, { code: string; title: string; detail: string }> = {
  400: { code: 'requisicao-invalida', title: 'Requisição inválida', detail: 'Confira os dados enviados.' },
  401: { code: 'nao-autenticado', title: 'Entre de novo', detail: 'A sessão acabou ou não foi enviada.' },
  403: { code: 'sem-permissao', title: 'Sem permissão', detail: 'Você não tem permissão para esta ação.' },
  404: { code: 'nao-encontrado', title: 'Não encontramos', detail: 'O endereço ou o registro não existe.' },
  405: { code: 'metodo-nao-permitido', title: 'Método não permitido', detail: 'Este endereço não aceita esta operação.' },
  409: { code: 'conflito', title: 'Mudou enquanto você via', detail: 'Confira a versão mais nova e tente de novo.' },
  412: { code: 'versao-desatualizada', title: 'Mudou enquanto você via', detail: 'Confira a versão mais nova e tente de novo.' },
  413: { code: 'grande-demais', title: 'Envio grande demais', detail: 'Reduza o tamanho do que foi enviado.' },
  415: { code: 'formato-nao-suportado', title: 'Formato não suportado', detail: 'Envie os dados em JSON.' },
  422: { code: 'nao-processavel', title: 'Não foi possível processar', detail: 'Os dados estão corretos, mas a regra não permite a operação.' },
  429: { code: 'limite', title: 'Muitas requisições', detail: 'Aguarde um pouco e tente de novo.' },
  500: { code: 'interno', title: 'Algo deu errado do nosso lado', detail: 'Informe o código de rastreio ao suporte.' },
  502: { code: 'dependencia-indisponivel', title: 'Serviço externo indisponível', detail: 'Nada foi alterado. Tente de novo em instantes.' },
  503: { code: 'indisponivel', title: 'Serviço indisponível', detail: 'Nada foi alterado. Tente de novo em instantes.' },
  504: { code: 'dependencia-indisponivel', title: 'Serviço externo não respondeu', detail: 'Nada foi alterado. Tente de novo em instantes.' },
};

/** `trace_id` do span ativo (OpenTelemetry); sem telemetria, um id aleatório no mesmo formato. */
export function currentTraceId(): string {
  const id = trace.getActiveSpan()?.spanContext().traceId;
  return id && !/^0+$/.test(id) ? id : randomBytes(16).toString('hex');
}

/** Monta a resposta RFC 9457. Só `AppProblem` e validação levam texto específico; o resto usa o catálogo. */
export function toProblem(exception: unknown, traceId: string, instance: string): ProblemDetails {
  const status = exception instanceof HttpException ? exception.getStatus() : 500;
  const base = CATALOG[status] ?? CATALOG[status >= 500 ? 500 : 400]!;
  const problem: ProblemDetails = {
    type: `${PROBLEM_TYPE_BASE}${base.code}`,
    title: base.title,
    status,
    detail: base.detail,
    instance,
    code: base.code,
    trace_id: traceId,
  };
  if (exception instanceof ValidationProblem) {
    return {
      ...problem,
      type: `${PROBLEM_TYPE_BASE}validacao`,
      code: 'validacao',
      title: 'Dados inválidos',
      detail: 'Corrija os campos indicados e envie de novo.',
      errors: exception.errors,
    };
  }
  if (exception instanceof AppProblem) {
    return { ...problem, type: `${PROBLEM_TYPE_BASE}${exception.code}`, code: exception.code, title: exception.title, detail: exception.detail };
  }
  return problem;
}

/** O motivo que vai para o log de um erro esperado (sem corpo da requisição e sem dado pessoal). */
export function reasonOf(exception: unknown): string {
  if (exception instanceof ValidationProblem) return `campos: ${exception.errors.map((e) => e.path).join(', ')}`;
  if (exception instanceof Error) return exception.message;
  return String(exception);
}
