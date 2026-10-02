import { createHash } from 'node:crypto';

// Vigia de integrações (A2, G8; ADR-015): a página oficial vira trechos por título, cada um com o hash
// do texto. Mudou o hash, mudou o trecho. Sem IA na A2: o registro guarda o texto novo do trecho.

export type Trecho = { titulo: string; hash: string; texto: string };
export type Mudanca = { titulo: string; mudanca: 'novo' | 'alterado' | 'removido'; hashAntes: string | null; hashDepois: string | null; texto: string | null };

/** Hosts oficiais que o Vigia lê (os mesmos da restrição da tabela `watch_source`). */
export const HOSTS_DO_VIGIA = new Set(['developers.facebook.com', 'developers.google.com', 'ads-developers.googleblog.com', 'platform.claude.com']);

const ENTIDADES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'", nbsp: ' ' };

function textoPuro(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (_, e: string) => ENTIDADES[e] ?? ' ')
    .replace(/&#(\d{1,6});/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/\s+/g, ' ')
    .trim();
}

const hash = (texto: string) => createHash('sha256').update(texto, 'utf8').digest('hex');

/**
 * Divide o HTML em trechos pelos títulos h1–h4. Tira o que muda sem ser conteúdo (scripts, estilos,
 * menus, cabeçalho e rodapé do site). Título repetido ganha o número da vez ("Mudanças (2)").
 */
export function trechos(html: string): Trecho[] {
  const limpo = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|nav|header|footer|aside|svg)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ');
  const partes = limpo.split(/<h[1-4]\b[^>]*>/i);
  const out: Trecho[] = [];
  const vistos = new Map<string, number>();
  const adicionar = (tituloBruto: string, corpo: string) => {
    const texto = textoPuro(corpo);
    if (!texto && !tituloBruto) return;
    let titulo = textoPuro(tituloBruto).slice(0, 300) || '(início)';
    const n = (vistos.get(titulo) ?? 0) + 1;
    vistos.set(titulo, n);
    if (n > 1) titulo = `${titulo} (${n})`;
    out.push({ titulo, hash: hash(`${titulo}\n${texto}`), texto });
  };
  adicionar('', partes[0] ?? '');
  for (const parte of partes.slice(1)) {
    const fim = parte.search(/<\/h[1-4]\s*>/i);
    adicionar(fim >= 0 ? parte.slice(0, fim) : '', fim >= 0 ? parte.slice(fim) : parte);
  }
  return out;
}

/** O que mudou entre a leitura anterior e a atual, trecho a trecho (pelo título). */
export function comparar(antes: Pick<Trecho, 'titulo' | 'hash'>[], depois: Trecho[]): Mudanca[] {
  const velhos = new Map(antes.map((t) => [t.titulo, t.hash]));
  const novos = new Set(depois.map((t) => t.titulo));
  const out: Mudanca[] = [];
  for (const t of depois) {
    const h = velhos.get(t.titulo);
    if (h === undefined) out.push({ titulo: t.titulo, mudanca: 'novo', hashAntes: null, hashDepois: t.hash, texto: t.texto });
    else if (h !== t.hash) out.push({ titulo: t.titulo, mudanca: 'alterado', hashAntes: h, hashDepois: t.hash, texto: t.texto });
  }
  for (const t of antes) if (!novos.has(t.titulo)) out.push({ titulo: t.titulo, mudanca: 'removido', hashAntes: t.hash, hashDepois: null, texto: null });
  return out;
}

export const hashDoConteudo = (ts: Trecho[]) => hash(ts.map((t) => t.hash).join('\n'));

const LIMITE_BYTES = 3 * 1024 * 1024;

/**
 * Baixa a página oficial: só https nos hosts do Vigia (também em cada redirecionamento, no máximo 3),
 * com tempo limite e teto de tamanho.
 */
export async function buscarPagina(url: string, tempoLimiteMs = 20_000): Promise<string> {
  let atual = url;
  for (let i = 0; i <= 3; i++) {
    const u = new URL(atual);
    if (u.protocol !== 'https:' || !HOSTS_DO_VIGIA.has(u.hostname) || u.username || u.password) throw new Error(`endereço fora do Vigia: ${u.hostname}`);
    const r = await fetch(u, { redirect: 'manual', signal: AbortSignal.timeout(tempoLimiteMs), headers: { accept: 'text/html', 'user-agent': 'LiameVigia/1.0' } });
    if (r.status >= 300 && r.status < 400) {
      const destino = r.headers.get('location');
      await r.body?.cancel();
      if (!destino) throw new Error(`redirecionamento sem destino (${r.status})`);
      atual = new URL(destino, u).toString();
      continue;
    }
    if (!r.ok) {
      await r.body?.cancel();
      throw new Error(`HTTP ${r.status}`);
    }
    const tamanho = Number(r.headers.get('content-length') ?? 0);
    if (tamanho > LIMITE_BYTES) {
      await r.body?.cancel();
      throw new Error('página grande demais');
    }
    const texto = await r.text();
    if (texto.length > LIMITE_BYTES) throw new Error('página grande demais');
    return texto;
  }
  throw new Error('redirecionamentos demais');
}
