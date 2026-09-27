import { randomInt } from 'node:crypto';
import { setTimeout as esperar } from 'node:timers/promises';
import type { Db } from '@liame/database';
import { Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { lerDepreciacao, lerRetryAfter, lerUsoMeta, type UsoDeCota } from './cabecalhos.js';
import { type Balde, chaveDe, consumirFichas, disjuntorAberto, registrarFalha, registrarSucesso } from './cota.js';

// Cliente HTTP comum dos conectores de leitura (A2, G2; arquitetura §6 e integrations §1.5): só os
// endereços oficiais de cada plataforma, disjuntor e balde de cota compartilhados, tempo limite, leitura
// dos cabeçalhos de uso, avisos de depreciação guardados para o Vigia (ADR-015) e nova tentativa com
// espera nas falhas passageiras. Erro sempre classificado: quem chama decide pelo tipo, não pelo texto.

export type TipoErroConector =
  | 'limite' //           cota da plataforma: esperar e tentar depois
  | 'autenticacao' //     token vencido ou revogado: a conta precisa reconectar
  | 'permissao' //        falta permissão no app ou na conta
  | 'transitorio' //      fora do ar, tempo esgotado, 5xx
  | 'definitivo' //       pedido errado: tentar de novo não resolve
  | 'circuito_aberto'; // muitas falhas seguidas: paramos de insistir por um tempo

export class ErroConector extends Error {
  constructor(
    readonly tipo: TipoErroConector,
    readonly provider: string,
    mensagem: string,
    readonly status: number | null = null,
    readonly esperarMs: number | null = null,
    readonly codigoProvider: string | null = null,
  ) {
    super(mensagem);
    this.name = 'ErroConector';
  }
}

export type PedidoConector = {
  provider: string;
  /** Chave da conta na plataforma (ex.: act_123): separa cota e disjuntor por conta. */
  conta: string;
  /** Endereço completo; precisa começar por um dos endereços liberados do provider. */
  url: string;
  metodo?: 'GET' | 'POST';
  cabecalhos?: Record<string, string>;
  corpo?: unknown;
  /** Rótulo curto do endpoint para os avisos de depreciação (ex.: insights). */
  endpoint: string;
  apiVersion: string;
  /** Custo em fichas (leitura = 1, como na Meta). */
  custo?: number;
};

export type RespostaConector<T> = { status: number; corpo: T; cabecalhos: Headers; uso: UsoDeCota | null };

export type ConfigCliente = {
  /** Endereços liberados por provider (produção: só os oficiais). */
  enderecos: Record<string, string[]>;
  tempoLimiteMs?: number;
  tentativas?: number;
  /** Balde por app × conta. */
  balde?: Balde;
  /** Espera máxima por ficha antes de devolver "limite" para o job tentar depois. */
  esperaMaximaMs?: number;
};

const PADRAO = { tempoLimiteMs: 30_000, tentativas: 3, balde: { capacidade: 60, porSegundo: 1 }, esperaMaximaMs: 10_000 };

export class ClienteConector {
  private readonly logger = new Logger('conectores');
  private readonly cfg: Required<ConfigCliente>;

  constructor(
    private readonly db: Db,
    cfg: ConfigCliente,
  ) {
    this.cfg = { ...PADRAO, ...cfg } as Required<ConfigCliente>;
  }

  async requisitar<T = unknown>(p: PedidoConector): Promise<RespostaConector<T>> {
    if (!enderecoLiberado(p.url, this.cfg.enderecos[p.provider] ?? [])) {
      throw new ErroConector('definitivo', p.provider, `endereço fora da lista do provider ${p.provider}`);
    }
    const chave = chaveDe(p.provider, p.conta);
    let ultimoErro: ErroConector | null = null;

    for (let tentativa = 1; tentativa <= this.cfg.tentativas; tentativa++) {
      const disjuntor = await disjuntorAberto(this.db, chave);
      if (disjuntor.aberto) {
        throw new ErroConector('circuito_aberto', p.provider, 'muitas falhas seguidas; nova tentativa mais tarde', null, disjuntor.ateMs - Date.now());
      }
      await this.aguardarFicha(chave, p);

      let resposta: Response;
      try {
        resposta = await fetch(p.url, {
          method: p.metodo ?? 'GET',
          headers: { accept: 'application/json', ...(p.corpo === undefined ? {} : { 'content-type': 'application/json' }), ...p.cabecalhos },
          body: p.corpo === undefined ? undefined : JSON.stringify(p.corpo),
          redirect: 'error',
          signal: AbortSignal.timeout(this.cfg.tempoLimiteMs),
        });
      } catch (err) {
        ultimoErro = new ErroConector('transitorio', p.provider, `sem resposta: ${err instanceof Error ? err.name : 'erro'}`);
        await registrarFalha(this.db, chave, ultimoErro.message);
        await this.pausa(tentativa, null);
        continue;
      }

      this.guardarDepreciacao(p, resposta.headers);
      const uso = p.provider === 'meta_ads' ? lerUsoMeta(resposta.headers) : null;
      const texto = await resposta.text();
      const corpo = texto ? tentarJson(texto) : null;

      if (resposta.ok) {
        await registrarSucesso(this.db, chave);
        return { status: resposta.status, corpo: corpo as T, cabecalhos: resposta.headers, uso };
      }

      ultimoErro = classificar(p.provider, resposta.status, corpo, resposta.headers, uso);
      if (ultimoErro.tipo === 'transitorio') await registrarFalha(this.db, chave, `${resposta.status}`);
      if (ultimoErro.tipo !== 'transitorio' && ultimoErro.tipo !== 'limite') throw ultimoErro;
      // Limite longo (a Meta pede minutos): devolve para o job agendar, sem prender o worker.
      if (ultimoErro.tipo === 'limite' && (ultimoErro.esperarMs ?? 0) > this.cfg.esperaMaximaMs) throw ultimoErro;
      await this.pausa(tentativa, ultimoErro.esperarMs);
    }
    throw ultimoErro ?? new ErroConector('transitorio', p.provider, 'falhou sem resposta');
  }

  private async aguardarFicha(chave: string, p: PedidoConector): Promise<void> {
    const limite = Date.now() + this.cfg.esperaMaximaMs;
    for (;;) {
      const r = await consumirFichas(this.db, chave, this.cfg.balde, p.custo ?? 1);
      if (r.ok) return;
      if (Date.now() + r.esperarMs > limite) {
        throw new ErroConector('limite', p.provider, 'cota local da conta esgotada; nova tentativa mais tarde', 429, r.esperarMs);
      }
      await esperar(r.esperarMs);
    }
  }

  /** Espera exponencial com variação (evita todos tentando ao mesmo tempo), ou o que a plataforma pediu. */
  private async pausa(tentativa: number, pedidoMs: number | null): Promise<void> {
    if (tentativa >= this.cfg.tentativas) return;
    const base = Math.min(8_000, 500 * 2 ** (tentativa - 1));
    await esperar(pedidoMs ?? base + randomInt(0, base));
  }

  /** Aviso de depreciação visto numa resposta: guardado para o Vigia. Nunca derruba a chamada (V5). */
  private guardarDepreciacao(p: PedidoConector, h: Headers): void {
    const aviso = lerDepreciacao(h);
    if (!aviso) return;
    this.db
      .execute(sql`
        insert into liame.api_deprecation_notice (provider, endpoint, api_version, deprecation, sunset, link)
        values (${p.provider}, ${p.endpoint}, ${p.apiVersion}, ${aviso.deprecation}, ${aviso.sunset}, ${aviso.link})
        on conflict (provider, endpoint, api_version) do update
           set deprecation = excluded.deprecation, sunset = excluded.sunset, link = excluded.link, last_seen_at = now()`)
      .catch((err: unknown) => this.logger.warn(`aviso de depreciação não gravado (${p.provider}/${p.endpoint}): ${err instanceof Error ? err.message : String(err)}`));
  }
}

/**
 * Mesma origem (esquema, host e porta) de um endereço liberado e dentro do caminho dele. Comparar só o
 * começo do texto deixaria passar `https://graph.facebook.com.outro.site`, e o token iria junto.
 */
export function enderecoLiberado(url: string, liberados: string[]): boolean {
  let alvo: URL;
  try {
    alvo = new URL(url);
  } catch {
    return false;
  }
  if (alvo.username || alvo.password) return false;
  return liberados.some((base) => {
    const b = new URL(base);
    const caminho = b.pathname.endsWith('/') ? b.pathname : `${b.pathname}/`;
    return alvo.origin === b.origin && (b.pathname === '/' || alvo.pathname === b.pathname || alvo.pathname.startsWith(caminho));
  });
}

function tentarJson(texto: string): unknown {
  try {
    return JSON.parse(texto);
  } catch {
    return texto.slice(0, 500);
  }
}

/**
 * Classifica o erro pelo status e pelo corpo de cada plataforma. Meta: `error.code` 4, 17, 32, 613 e
 * 80000–80014 são limite; 190 é token inválido; 10 e 200–299 são permissão (base §2.1). Google:
 * RESOURCE_EXHAUSTED (429) é limite; UNAUTHENTICATED (401); PERMISSION_DENIED (403).
 */
export function classificar(provider: string, status: number, corpo: unknown, h: Headers, uso: UsoDeCota | null): ErroConector {
  const erro = (corpo as { error?: Record<string, unknown> } | null)?.error ?? {};
  const codigo = erro.code !== undefined ? String(erro.code) : null;
  const statusGoogle = typeof erro.status === 'string' ? erro.status : null;
  const mensagem = typeof erro.message === 'string' ? erro.message.slice(0, 300) : `HTTP ${status}`;
  const esperaPedida = lerRetryAfter(h) ?? (uso?.esperarMs ? uso.esperarMs : null);
  const cod = codigo === null ? NaN : Number(codigo);

  const ehLimiteMeta = [4, 17, 32, 613].includes(cod) || (cod >= 80000 && cod <= 80014);
  if (status === 429 || ehLimiteMeta || statusGoogle === 'RESOURCE_EXHAUSTED') {
    return new ErroConector('limite', provider, mensagem, status, esperaPedida ?? 60_000, codigo ?? statusGoogle);
  }
  if (status === 401 || cod === 190 || statusGoogle === 'UNAUTHENTICATED') {
    return new ErroConector('autenticacao', provider, mensagem, status, null, codigo ?? statusGoogle);
  }
  if (status === 403 || cod === 10 || (cod >= 200 && cod <= 299) || statusGoogle === 'PERMISSION_DENIED') {
    return new ErroConector('permissao', provider, mensagem, status, null, codigo ?? statusGoogle);
  }
  if (status >= 500 || status === 408 || cod === 1 || cod === 2) {
    return new ErroConector('transitorio', provider, mensagem, status, esperaPedida, codigo ?? statusGoogle);
  }
  return new ErroConector('definitivo', provider, mensagem, status, null, codigo ?? statusGoogle);
}
