import type { InstagramMedia, InstagramMediaResponse } from '@liame/contracts';
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { contaConectada } from '../connections/conectada.js';
import { PROVEDOR_INSTAGRAM } from '../connectors/meta/publicacao.js';
import { type AuthContext, currentTx } from '../context/request-context.js';
import { FlagService } from '../flags/flag.service.js';
import { DATASET_DO_INSTAGRAM } from './do-seu-instagram.js';
import { FLAG_FOTOS, FLAG_VIDEOS, marcaDaEmpresa, quemPede } from './fotos.service.js';

// "Do seu Instagram" (A6 · Z10, parte 5; D-A6-71 e D-A6-83): o que a tela lê, na transação da rota. Só lê o que a
// rotina `do-seu-instagram` do worker gravou; nenhuma chamada à Meta acontece aqui.

type LinhaDaConta = {
  id: string;
  name: string;
  last_success_at: Date | string | null;
  last_error: string | null;
  cursor: { falha?: string } | null;
};

type LinhaDaPublicacao = {
  media_id: string;
  kind: string;
  caption: string;
  permalink: string | null;
  thumbnail_url: string | null;
  has_file: boolean;
  published_at: Date | string;
  views: string | number | null;
  reach: string | number | null;
  likes: string | number | null;
  comments: string | number | null;
  saved: string | number | null;
  shares: string | number | null;
  metrics_read_at: Date | string | null;
};

const iso = (v: Date | string): string => (v instanceof Date ? v : new Date(v)).toISOString();
/** O `bigint` do Postgres chega como texto: número, ou nulo. */
const numero = (v: string | number | null): number | null => (v === null ? null : Number(v));

/**
 * A situação da leitura, pelo estado em `sync_state`: a última tentativa que falhou por permissão é `sem_permissao`
 * (com o que já havia sido lido); a que falhou sem nunca ter dado certo é `falhou`; com uma leitura que deu certo,
 * `lido`; sem nenhuma, `primeira_leitura`.
 */
export function situacaoDaLeitura(c: Pick<LinhaDaConta, 'last_success_at' | 'last_error' | 'cursor'>): string {
  if (c.last_error && c.cursor?.falha === 'permissao') return 'sem_permissao';
  if (c.last_success_at) return 'lido';
  return c.last_error ? 'falhou' : 'primeira_leitura';
}

@Injectable()
export class DoSeuInstagramService {
  constructor(private readonly flags: FlagService) {}

  async ler(auth: AuthContext, brandId: string): Promise<InstagramMediaResponse> {
    const quem = quemPede(auth);
    await marcaDaEmpresa(brandId);
    const base: InstagramMediaResponse = { brand_id: brandId, enabled: false, account: null, situation: 'desligada', read_at: null, items: [] };
    const contexto = this.flags.context({ tenantId: quem.tenantId, userId: quem.userId, brandId });
    if (!(await this.flags.isEnabled(FLAG_FOTOS, contexto)) || !(await this.flags.isEnabled(FLAG_VIDEOS, contexto))) return base;

    const tx = currentTx();
    const contas = (
      await tx.execute<LinhaDaConta>(sql`
        select a.id, a.name, s.last_success_at, s.last_error, s.cursor
          from liame.connected_account a
          left join liame.sync_state s on s.connected_account_id = a.id and s.dataset = ${DATASET_DO_INSTAGRAM}
         where a.brand_id = ${brandId} and a.provider = ${PROVEDOR_INSTAGRAM} and ${contaConectada('a')}
         order by a.connected_at, a.id`)
    ).rows;
    if (contas.length === 0) return { ...base, enabled: true, situation: 'sem_conta' };
    // Com duas contas do Instagram na mesma marca, o post também recusa (`canal-com-duas-contas`): a tela pede uma só.
    if (contas.length > 1) return { ...base, enabled: true, situation: 'duas_contas' };
    const conta = contas[0]!;

    const publicacoes = (
      await tx.execute<LinhaDaPublicacao>(sql`
        select media_id, kind, caption, permalink, thumbnail_url, has_file, published_at, views, reach, likes, comments, saved, shares, metrics_read_at
          from liame.instagram_media
         where connected_account_id = ${conta.id}
         order by views desc nulls last, published_at desc, media_id`)
    ).rows;
    const items: InstagramMedia[] = publicacoes.map((p) => ({
      id: p.media_id,
      kind: p.kind,
      caption: p.caption,
      permalink: p.permalink,
      thumbnail_url: p.thumbnail_url,
      has_file: p.has_file,
      published_at: iso(p.published_at),
      metrics: {
        views: numero(p.views),
        reach: numero(p.reach),
        likes: numero(p.likes),
        comments: numero(p.comments),
        saved: numero(p.saved),
        shares: numero(p.shares),
      },
      metrics_read_at: p.metrics_read_at ? iso(p.metrics_read_at) : null,
    }));
    return {
      brand_id: brandId,
      enabled: true,
      account: { name: conta.name },
      situation: situacaoDaLeitura(conta),
      read_at: conta.last_success_at ? iso(conta.last_success_at) : null,
      items,
    };
  }
}
