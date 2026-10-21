import { BRAND_PHOTO_LIMITS } from '@liame/contracts';
import { AppProblem } from '../errors/problems.js';
import { API_PREFIX } from '../setup-constants.js';

// O leitor do corpo da rota que recebe a foto (`POST /v1/brand-photos`): o arquivo vem cru, e o leitor do Nest só lê
// JSON (até 100 kb). Este junta os bytes até 10 MB e entrega o Buffer à rota; acima disso, 413 pelo filtro de erros,
// como o leitor do Express (V133). O pedido em JSON segue para o leitor do Nest (a rota recusa: "falta a foto").

const CAMINHO = `/${API_PREFIX}/brand-photos`;

interface PedidoCru {
  method: string;
  url: string;
  originalUrl?: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
  on(evento: 'data', fn: (parte: Buffer) => void): unknown;
  on(evento: 'end' | 'aborted', fn: () => void): unknown;
  on(evento: 'error', fn: (e: Error) => void): unknown;
  resume(): unknown;
}

function cabecalho(v: string | string[] | undefined): string {
  return (Array.isArray(v) ? (v[0] ?? '') : (v ?? '')).toLowerCase();
}

function grandeDemais(): AppProblem {
  return new AppProblem(413, 'grande-demais', 'Foto grande demais', 'Passa de 10 MB.');
}

/** O middleware: só toca no `POST` da rota de envio que não vem em JSON. */
export function leitorDaFoto(limite: number = BRAND_PHOTO_LIMITS.maxBytes) {
  return (req: PedidoCru, _res: unknown, next: (err?: unknown) => void): void => {
    if (req.method !== 'POST' || (req.originalUrl ?? req.url).split('?')[0] !== CAMINHO) return next();
    const tipo = cabecalho(req.headers['content-type']);
    if (tipo.startsWith('application/json')) return next();
    const compressao = cabecalho(req.headers['content-encoding']);
    if (compressao && compressao !== 'identity') {
      req.resume();
      return next(new AppProblem(415, 'formato-nao-suportado', 'Formato não suportado', 'Envie a foto sem compressão.'));
    }
    const declarado = Number(cabecalho(req.headers['content-length']) || NaN);
    if (Number.isFinite(declarado) && declarado > limite) {
      req.resume();
      return next(grandeDemais());
    }
    const partes: Buffer[] = [];
    let total = 0;
    let acabou = false;
    const terminar = (err?: unknown) => {
      if (acabou) return;
      acabou = true;
      next(err);
    };
    req.on('data', (parte) => {
      if (acabou) return;
      total += parte.length;
      if (total > limite) {
        partes.length = 0;
        req.resume();
        terminar(grandeDemais());
        return;
      }
      partes.push(parte);
    });
    req.on('end', () => {
      if (acabou) return;
      req.body = Buffer.concat(partes, total);
      terminar();
    });
    req.on('aborted', () => terminar(new AppProblem(400, 'envio-interrompido', 'Envio interrompido', 'A foto não chegou inteira. Tente de novo.')));
    req.on('error', () => terminar(new AppProblem(400, 'envio-interrompido', 'Envio interrompido', 'A foto não chegou inteira. Tente de novo.')));
  };
}
