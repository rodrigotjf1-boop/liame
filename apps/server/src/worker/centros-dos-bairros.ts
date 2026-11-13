import { type Db, withSystem } from '@liame/database';
import { sql } from 'drizzle-orm';
import { type ProcuraDeCoordenada, procuraDeCoordenada } from '../regiao/coordenada.js';

// O cache dos bairros da campanha nova (plano da região, R6, parte 3; D-RG-54): o centro de cada bairro do IBGE pelo
// OpenStreetMap (a fila do Nominatim da R1: uma consulta por segundo, com cache, como as regras de uso dele pedem) e o
// que a busca de lugares da Meta achou. A tabela é do produto, sem empresa (`region_district_point`): só o sistema grava,
// por isso este arquivo mora no worker (V53). A parte pura fica em `campanhas/bairros-da-campanha.ts`.

/** Uma consulta ao Nominatim leva até ~1,1 s na fila: sem esse tempo antes do prazo, não começa outra. */
const TEMPO_DE_UMA_PROCURA_MS = 1_500;

export class CentrosDosBairros {
  private db: Db | null = null;
  private procura: ProcuraDeCoordenada = procuraDeCoordenada;

  /** Ligado quando o app sobe (`escrita-meta.provider.ts`); os testes trocam o Nominatim. */
  ligar(deps: { db: Db; procura?: ProcuraDeCoordenada }): void {
    this.db = deps.db;
    if (deps.procura) this.procura = deps.procura;
  }

  /**
   * Procura o centro de cada bairro, um por vez, até o prazo (`prazo`, em ms desde 1970), e grava o que o mapa
   * respondeu: achado ou não achado. O mapa fora do ar para tudo (os outros iriam ao mesmo lugar) e nada é gravado: a
   * gaveta pergunta de novo.
   */
  async procurarCentros(bairros: ReadonlyArray<{ codigo: string; nome: string }>, cidade: string, uf: string, prazo: number): Promise<void> {
    const db = this.db;
    if (!db) return;
    for (const b of bairros) {
      if (Date.now() + TEMPO_DE_UMA_PROCURA_MS > prazo) return;
      const r = await this.procura.procurarBairro(b.nome, cidade, uf);
      if (r.status === 'falhou') return;
      const achado = r.status === 'achado' ? r.coordenada : null;
      await withSystem(db, (tx) =>
        tx.execute(sql`
          insert into liame.region_district_point (district_code, located, latitude, longitude, located_at)
          values (${b.codigo}, ${achado ? 'achado' : 'nao_achado'}, ${achado?.latitude ?? null}, ${achado?.longitude ?? null}, now())
          on conflict (district_code) do update
             set located = excluded.located, latitude = excluded.latitude, longitude = excluded.longitude, located_at = excluded.located_at`),
      );
    }
  }

  /** Guarda o que a busca da Meta achou para o bairro (a chave, ou nada: vai o círculo), com a hora da pergunta. */
  async guardarMeta(codigo: string, chave: string | null): Promise<void> {
    const db = this.db;
    if (!db) return;
    await withSystem(db, (tx) =>
      tx.execute(sql`update liame.region_district_point set meta_location = ${chave}, meta_checked_at = now() where district_code = ${codigo}`),
    );
  }
}

export const centrosDosBairros = new CentrosDosBairros();
