import { ACCOUNT_RECOVERY_DOCUMENT_LIMITS, AGENCY_LOGO_LIMITS, BRAND_PHOTO_LIMITS } from '@liame/contracts';
import { AppProblem } from '../errors/problems.js';
import { API_PREFIX } from '../setup-constants.js';

// O leitor do corpo da rota que recebe a foto (`POST /v1/brand-photos`): o arquivo vem cru, e o leitor do Nest só lê
// JSON (até 100 kb). Este junta os bytes até 10 MB e entrega o Buffer à rota; acima disso, 413 pelo filtro de erros,
// como o leitor do Express (V133). O pedido em JSON segue para o leitor do Nest (a rota recusa: "falta a foto").
// O mesmo leitor serve ao logo da agência (`PUT /v1/agency/brand/logo`, A7 · W7, parte 3), até 1 MB.

/** A rota que recebe o arquivo cru e as frases dela (o caminho exato, ou o padrão para a rota com parâmetros). */
export type RotaDoArquivo = {
  metodo: 'POST' | 'PUT';
  caminho: string | RegExp;
  limite: number;
  grande: string;
  passa: string;
  semCompressao: string;
  interrompido: string;
};

export const ROTA_DA_FOTO: RotaDoArquivo = {
  metodo: 'POST',
  caminho: `/${API_PREFIX}/brand-photos`,
  limite: BRAND_PHOTO_LIMITS.maxBytes,
  grande: 'Foto grande demais',
  passa: 'Passa de 10 MB.',
  semCompressao: 'Envie a foto sem compressão.',
  interrompido: 'A foto não chegou inteira. Tente de novo.',
};

export const ROTA_DO_LOGO_DA_AGENCIA: RotaDoArquivo = {
  metodo: 'PUT',
  caminho: `/${API_PREFIX}/agency/brand/logo`,
  limite: AGENCY_LOGO_LIMITS.maxBytes,
  grande: 'Logo grande demais',
  passa: 'Passa de 1 MB.',
  semCompressao: 'Envie o logo sem compressão.',
  interrompido: 'O logo não chegou inteiro. Tente de novo.',
};

/** O documento com foto do pedido de recuperação da conta (A7, W8, parte 4a), até 10 MB. */
export const ROTA_DO_DOCUMENTO_DA_RECUPERACAO: RotaDoArquivo = {
  metodo: 'POST',
  caminho: `/${API_PREFIX}/me/account-recovery`,
  limite: ACCOUNT_RECOVERY_DOCUMENT_LIMITS.maxBytes,
  grande: 'Documento grande demais',
  passa: 'Passa de 10 MB.',
  semCompressao: 'Envie o documento sem compressão.',
  interrompido: 'O documento não chegou inteiro. Tente de novo.',
};

/** Os documentos do pedido da propriedade à DMS (A7, W8, parte 6a), um por vez, até 10 MB cada. */
export const ROTA_DOS_DOCUMENTOS_DA_PROPRIEDADE: RotaDoArquivo = {
  metodo: 'PUT',
  // Expressão fixa (V116): o prefixo `v1` escrito, como o `API_PREFIX`.
  caminho: /^\/v1\/ownership\/claims\/[0-9a-f-]{36}\/documents\/(documento_com_foto|documento_da_empresa)$/,
  limite: ACCOUNT_RECOVERY_DOCUMENT_LIMITS.maxBytes,
  grande: 'Documento grande demais',
  passa: 'Passa de 10 MB.',
  semCompressao: 'Envie o documento sem compressão.',
  interrompido: 'O documento não chegou inteiro. Tente de novo.',
};

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

/** O middleware: só toca no método e no caminho da rota de envio, no pedido que não vem em JSON. */
export function leitorDaFoto(limite: number = BRAND_PHOTO_LIMITS.maxBytes, rota: RotaDoArquivo = ROTA_DA_FOTO) {
  const grandeDemais = () => new AppProblem(413, 'grande-demais', rota.grande, rota.passa);
  return (req: PedidoCru, _res: unknown, next: (err?: unknown) => void): void => {
    const caminho = (req.originalUrl ?? req.url).split('?')[0] ?? '';
    if (req.method !== rota.metodo || (typeof rota.caminho === 'string' ? caminho !== rota.caminho : !rota.caminho.test(caminho))) return next();
    const tipo = cabecalho(req.headers['content-type']);
    if (tipo.startsWith('application/json')) return next();
    const compressao = cabecalho(req.headers['content-encoding']);
    if (compressao && compressao !== 'identity') {
      req.resume();
      return next(new AppProblem(415, 'formato-nao-suportado', 'Formato não suportado', rota.semCompressao));
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
    req.on('aborted', () => terminar(new AppProblem(400, 'envio-interrompido', 'Envio interrompido', rota.interrompido)));
    req.on('error', () => terminar(new AppProblem(400, 'envio-interrompido', 'Envio interrompido', rota.interrompido)));
  };
}
