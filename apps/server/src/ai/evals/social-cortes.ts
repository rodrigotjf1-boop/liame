import { readFileSync } from 'node:fs';
import { BrandDossierContent, SystemProof } from '@liame/contracts';
import type SharpDoPacote from 'sharp';
import { z } from 'zod';
import { carregarSharp } from '../../fotos/processar.js';
import { concorrentesDoDossie, fatosDoDossie, proibidasDoDossie, textoDoDossie } from '../../marca/dossie.js';
import { normalizar } from '../../policy/texto.js';
import { IMAGENS_POR_PEDIDO_MAXIMAS, LADO_MAIOR_DA_IMAGEM } from '../imagens.js';
import { cortesDaResposta, DURACOES_DOS_CORTES, type PedidoDeCortes, RespostaDosCortes } from '../social/cortes.js';
import type { Avaliacao } from './avaliar.js';

// Casos de eval do Social media nos cortes do vídeo com os vídeos da loja (A6, o item 7 do dono de 07/11/2026; D-A6-82;
// P44): dados versionados em `evals/social_cortes/casos.jsonl`. Cada caso é um pedido como o funcionário o recebe (a marca
// com o dossiê, a duração do vídeo e de 1 a 4 vídeos, cada um com a duração, o produto e a descrição marcados) e os quadros
// de cada vídeo, descritos pela cena (um de poucos tipos fixos). Os quadros não são fotos: o eval os desenha (um SVG por
// cena, em JPEG de 768 × 432, pelo `sharp`), só para a rodada paga; nenhuma pessoa de verdade aparece (a cena `pessoa` é
// uma silhueta sem rosto). O contexto e a mensagem são montados pelo código de produção. O avaliador é o da produção
// (`cortesDaResposta`: os tempos dentro de cada vídeo, o tamanho de cada corte, nenhum pedaço repetido, o total perto da
// duração e a legenda pelo Compliance das peças), e depois o que o caso espera: os vídeos que precisam aparecer e o que as
// legendas trazem ou não podem trazer. O pedido ao modelo (a soma entre 90% e 100% da duração, a legenda até 32
// caracteres) é folga, não régua: reprova o que, em produção, não chegaria à pessoa.
//
// O grupo `injecao` não aceita falha nenhuma (`GRUPOS_SEM_FALHA`): a ordem escrita num cartaz de um quadro, ou na descrição
// do vídeo, obedecida.

export const GRUPOS_DOS_CORTES = ['basico', 'varios_videos', 'oferta', 'marca', 'injecao', 'curto'] as const;

/** As cenas que o eval sabe desenhar. Só o cartaz traz texto (é por ele que a ordem escondida chega ao modelo). */
export const CENAS_DOS_QUADROS = ['chapa', 'montagem', 'pronto', 'batata', 'massa', 'travessa', 'embalagem', 'pessoa', 'cartaz'] as const;
export type CenaDoQuadro = (typeof CENAS_DOS_QUADROS)[number];

/** O quadro desenhado: deitado, 16:9, com o lado maior no teto do gateway. */
export const LARGURA_DO_QUADRO = LADO_MAIOR_DA_IMAGEM;
export const ALTURA_DO_QUADRO = 432;

const Rotulo = z.string().min(1);
const Segundos = z.number().min(0).max(120);

const QuadroDoCaso = z.discriminatedUnion('cena', [
  z.strictObject({ tempo_s: Segundos, cena: z.enum(['chapa', 'montagem', 'pronto', 'batata', 'massa', 'travessa', 'embalagem', 'pessoa']) }),
  z.strictObject({ tempo_s: Segundos, cena: z.literal('cartaz'), texto: z.string().min(1).max(90) }),
]);
export type QuadroDoCaso = z.infer<typeof QuadroDoCaso>;

export const CasoDosCortes = z.strictObject({
  id: z.string().regex(/^[a-z0-9-]{3,60}$/),
  grupo: z.enum(GRUPOS_DOS_CORTES),
  descricao: z.string().min(10).max(300),
  marca: z.string().min(2).max(80),
  dossie: BrandDossierContent,
  provas: z.array(SystemProof).default([]),
  /** A duração do vídeo de cortes, em segundos. */
  duracao: z.literal(DURACOES_DOS_CORTES),
  /** Os vídeos escolhidos, na ordem do pedido (o número de cada um, a partir de 1, é a posição). */
  videos: z
    .array(
      z.strictObject({
        duracao_s: z.number().min(1).max(120),
        produto: z.string().min(1).max(160).nullable(),
        descricao: z.string().min(1).max(300).nullable(),
        quadros: z.array(QuadroDoCaso).min(1).max(IMAGENS_POR_PEDIDO_MAXIMAS),
      }),
    )
    .min(1)
    .max(4),
  espera: z.strictObject({
    /** Os vídeos (o número, a partir de 1) que precisam aparecer em pelo menos um corte. */
    videos: z.array(z.number().int().min(1)).min(1).optional(),
    /** Em alguma legenda, pelo menos um termo de cada lista, sem olhar acento nem maiúscula. */
    cita: z.array(z.array(Rotulo).min(1)).optional(),
    /** Trechos que nenhuma legenda pode trazer, sem olhar acento nem maiúscula. */
    nao_cita: z.array(Rotulo).optional(),
  }),
  gravadas: z.strictObject({
    boa: z.unknown(),
    /** Cada ruim com o código da falha esperada (o começo de uma das falhas do avaliador, antes dos dois-pontos). */
    ruins: z.array(z.strictObject({ resposta: z.unknown(), falha: z.string().min(3) })).default([]),
  }),
});
export type CasoDosCortes = z.infer<typeof CasoDosCortes>;

/** Lê e valida o arquivo de casos; linha em branco e linha começando com `//` são ignoradas. */
export function carregarCasosDosCortes(caminho: string): CasoDosCortes[] {
  const casos: CasoDosCortes[] = [];
  readFileSync(caminho, 'utf8')
    .split('\n')
    .forEach((linha, i) => {
      const texto = linha.trim();
      if (!texto || texto.startsWith('//')) return;
      let bruto: unknown;
      try {
        bruto = JSON.parse(texto);
      } catch {
        throw new Error(`${caminho}, linha ${i + 1}: não é JSON`);
      }
      const r = CasoDosCortes.safeParse(bruto);
      if (!r.success) throw new Error(`${caminho}, linha ${i + 1}: ${r.error.issues.map((x) => `${x.path.join('.')}: ${x.message}`).join('; ')}`);
      casos.push(r.data);
    });
  const ids = casos.map((c) => c.id);
  const repetido = ids.find((id, i) => ids.indexOf(id) !== i);
  if (repetido) throw new Error(`${caminho}: caso repetido "${repetido}"`);
  for (const c of casos) {
    const fora = c.espera.videos?.find((v) => v > c.videos.length);
    if (fora) throw new Error(`${caminho}: o caso "${c.id}" espera o vídeo ${fora}, que não está no pedido`);
    // Todo quadro vai ao modelo: nenhum passa do teto de imagens do gateway (a mensagem corta o que passa).
    const quadros = c.videos.reduce((t, v) => t + v.quadros.length, 0);
    if (quadros > IMAGENS_POR_PEDIDO_MAXIMAS) throw new Error(`${caminho}: o caso "${c.id}" tem ${quadros} quadros, acima de ${IMAGENS_POR_PEDIDO_MAXIMAS}`);
    c.videos.forEach((v, i) => {
      const quadro = v.quadros.findIndex((q, j) => q.tempo_s > v.duracao_s || (j > 0 && q.tempo_s <= v.quadros[j - 1]!.tempo_s));
      if (quadro >= 0) throw new Error(`${caminho}: o caso "${c.id}", vídeo ${i + 1}: o quadro ${quadro + 1} fora da duração ou fora da ordem do tempo`);
    });
  }
  return casos;
}

/** Os quadros de cada vídeo do caso, na ordem dos vídeos, como a produção os entrega ao pedido. */
export type QuadrosDoCaso = ReadonlyArray<ReadonlyArray<{ tempoMs: number; jpeg: Uint8Array }>>;

/**
 * O pedido do caso como a produção o monta: o texto do dossiê, a duração, as ofertas e os vídeos. Sem quadros (o avaliador
 * só olha a duração de cada vídeo) ou com os de `quadrosDoCaso` (a rodada paga).
 */
export function pedidoDoCasoDosCortes(c: CasoDosCortes, quadros?: QuadrosDoCaso): PedidoDeCortes {
  if (quadros && quadros.length !== c.videos.length) throw new Error(`eval: o caso "${c.id}" tem ${c.videos.length} vídeos e ${quadros.length} listas de quadros`);
  return {
    marca: c.marca,
    dossie: textoDoDossie(c.marca, c.dossie, c.provas),
    duracaoS: c.duracao,
    ofertas: c.dossie.offers.items,
    videos: c.videos.map((v, i) => ({ duracaoMs: Math.round(v.duracao_s * 1000), produto: v.produto, descricao: v.descricao, quadros: quadros?.[i] ?? [] })),
  };
}

/** O texto vai dentro do SVG: sem os sinais que abririam uma marca ou fechariam um atributo. */
const paraXml = (t: string): string => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** O texto do cartaz em linhas de até 24 caracteres (a palavra maior que isso fica inteira numa linha), no máximo 5. */
function linhasDoCartaz(texto: string): string[] {
  const linhas: string[] = [];
  for (const palavra of texto.split(/\s+/).filter(Boolean)) {
    const ultima = linhas[linhas.length - 1];
    if (ultima !== undefined && ultima.length + 1 + palavra.length <= 24) linhas[linhas.length - 1] = `${ultima} ${palavra}`;
    else linhas.push(palavra);
  }
  return linhas.slice(0, 5);
}

/** O desenho de cada cena, num quadro de 768 × 432: a cor do fundo e o motivo. */
function desenhoDaCena(q: QuadroDoCaso): { fundo: string; motivo: string } {
  switch (q.cena) {
    case 'chapa': {
      const carnes = [250, 384, 518].map(
        (x, i) =>
          `<ellipse cx="${x}" cy="${240 + (i % 2) * 10}" rx="78" ry="50" fill="#6b3a1e"/><ellipse cx="${x - 10}" cy="${232 + (i % 2) * 10}" rx="44" ry="24" fill="#4a2612" opacity="0.6"/>` +
          `<path d="M${x} 176 q -16 -28 0 -56 q 16 -28 0 -56" stroke="#ffffff" stroke-opacity="0.35" stroke-width="8" fill="none" stroke-linecap="round"/>`,
      );
      return { fundo: '#2b2d31', motivo: `<rect x="64" y="96" width="640" height="288" rx="18" fill="#3c3f45" stroke="#55595f" stroke-width="6"/>${carnes.join('')}` };
    }
    case 'montagem':
      return {
        fundo: '#e8e1d5',
        motivo:
          '<rect x="134" y="300" width="500" height="60" rx="14" fill="#a8743f"/>' +
          '<rect x="254" y="270" width="260" height="34" rx="14" fill="#d89a4a"/>' +
          '<rect x="246" y="234" width="276" height="40" rx="18" fill="#5b3219"/>' +
          '<polygon points="250,234 518,234 500,256 470,238 430,262 390,238 350,262 310,238 270,258" fill="#f2c230"/>' +
          '<path d="M250 226 q 17 -16 34 0 t 34 0 t 34 0 t 34 0 t 34 0 t 34 0 t 34 0 t 34 0" stroke="#4caf50" stroke-width="12" fill="none" stroke-linecap="round"/>' +
          '<path d="M560 290 a 70 60 0 0 1 140 0 z" fill="#d9953a"/>',
      };
    case 'pronto': {
      const gergelim = [
        [330, 190],
        [384, 170],
        [440, 188],
        [360, 214],
        [414, 210],
      ]
        .map(([x, y]) => `<ellipse cx="${x}" cy="${y}" rx="7" ry="4" fill="#fff5dc"/>`)
        .join('');
      return {
        fundo: '#7a4b2f',
        motivo:
          '<ellipse cx="384" cy="330" rx="260" ry="64" fill="#f4f4f2"/><ellipse cx="384" cy="330" rx="200" ry="44" fill="#e3e3e0"/>' +
          '<rect x="264" y="290" width="240" height="40" rx="16" fill="#d89a4a"/>' +
          '<rect x="254" y="254" width="260" height="42" rx="20" fill="#5b3219"/>' +
          '<polygon points="258,252 510,252 494,274 466,256 430,280 392,256 352,280 316,256 276,272" fill="#f2c230"/>' +
          '<path d="M258 246 q 16 -14 32 0 t 32 0 t 32 0 t 32 0 t 32 0 t 32 0 t 32 0 t 32 0" stroke="#4caf50" stroke-width="10" fill="none" stroke-linecap="round"/>' +
          `<path d="M254 244 C 254 128 514 128 514 244 Z" fill="#d9953a"/>${gergelim}`,
      };
    }
    case 'batata': {
      const palitos = [300, 330, 360, 390, 420, 450]
        .map((x, i) => `<rect x="${x}" y="${120 + (i % 3) * 18}" width="22" height="130" rx="4" fill="#f2c14e" stroke="#d9a43a" stroke-width="3" transform="rotate(${(i - 2.5) * 5} ${x + 11} 250)"/>`)
        .join('');
      return { fundo: '#f3e6c8', motivo: `${palitos}<path d="M284 210 L484 210 L456 380 L312 380 Z" fill="#c62828"/><rect x="300" y="250" width="168" height="18" fill="#e57373"/>` };
    }
    case 'massa': {
      const nhoques = [
        [330, 180],
        [372, 160],
        [420, 172],
        [450, 210],
        [318, 226],
        [362, 206],
        [408, 214],
        [440, 252],
        [340, 262],
        [386, 250],
        [396, 290],
        [350, 300],
      ]
        .map(([x, y]) => `<ellipse cx="${x}" cy="${y}" rx="17" ry="11" fill="#f0d48a" stroke="#d9b866" stroke-width="3"/>`)
        .join('');
      return {
        fundo: '#e9e4da',
        motivo:
          '<circle cx="384" cy="216" r="170" fill="#fafafa" stroke="#dcdcdc" stroke-width="6"/><circle cx="384" cy="216" r="130" fill="#f1f1f1"/>' +
          `<path d="M300 200 C 310 140 460 130 470 200 C 480 270 420 320 360 310 C 300 300 290 250 300 200 Z" fill="#c0392b"/>${nhoques}` +
          '<ellipse cx="430" cy="150" rx="18" ry="9" fill="#2e7d32" transform="rotate(-30 430 150)"/><ellipse cx="452" cy="162" rx="16" ry="8" fill="#388e3c" transform="rotate(20 452 162)"/>',
      };
    }
    case 'travessa': {
      const camadas = ['#f6e7b0', '#b5361f', '#f3d27a', '#b5361f', '#f3d27a', '#b5361f']
        .map((cor, i) => `<rect x="158" y="${196 + i * 26}" width="452" height="26" fill="${cor}"/>`)
        .join('');
      return {
        fundo: '#5d4037',
        motivo:
          '<rect x="100" y="230" width="44" height="40" rx="10" fill="#cfc6b8"/><rect x="624" y="230" width="44" height="40" rx="10" fill="#cfc6b8"/>' +
          `<rect x="134" y="176" width="500" height="200" rx="22" fill="#e9e2d6" stroke="#cfc6b8" stroke-width="8"/>${camadas}` +
          '<ellipse cx="250" cy="204" rx="26" ry="7" fill="#c98a3a"/><ellipse cx="420" cy="202" rx="34" ry="8" fill="#c98a3a"/><ellipse cx="540" cy="206" rx="20" ry="6" fill="#c98a3a"/>',
      };
    }
    case 'embalagem':
      return {
        fundo: '#dfe6ea',
        motivo:
          '<path d="M300 130 l 20 -30 h 150 l 20 30 z" fill="#b0855a"/><rect x="300" y="130" width="190" height="240" rx="8" fill="#c49a6c"/>' +
          '<rect x="300" y="230" width="190" height="26" fill="#8d6e63"/><rect x="500" y="250" width="170" height="120" rx="6" fill="#f5f5f5" stroke="#bdbdbd" stroke-width="4"/>',
      };
    case 'pessoa':
      // Uma silhueta lisa, sem rosto: nada de traço que pareça olho, boca ou cabelo.
      return {
        fundo: '#cfd8dc',
        motivo:
          '<rect x="-40" y="360" width="848" height="72" fill="#90a4ae"/><circle cx="384" cy="150" r="62" fill="#37474f"/>' +
          '<path d="M244 432 C 244 300 300 236 384 236 C 468 236 524 300 524 432 Z" fill="#37474f"/>',
      };
    case 'cartaz': {
      const linhas = linhasDoCartaz(q.texto);
      const topo = 216 - (linhas.length - 1) * 21 + 10;
      const texto = linhas
        .map((l, i) => `<text x="384" y="${topo + i * 42}" text-anchor="middle" font-family="Arial, Helvetica, DejaVu Sans, sans-serif" font-size="30" font-weight="700" fill="#ffffff">${paraXml(l)}</text>`)
        .join('');
      return { fundo: '#f5efe3', motivo: `<rect x="104" y="56" width="560" height="320" rx="12" fill="#1f2a30" stroke="#6d4c41" stroke-width="14"/>${texto}` };
    }
  }
}

/** O SVG do quadro (XML bem formado; o texto do cartaz escapado). Exportado para o teste. */
export function svgDoQuadro(q: QuadroDoCaso): string {
  // O motivo anda até 20 px para o lado conforme o segundo: os quadros da mesma cena não saem iguais.
  const d = Math.round((q.tempo_s * 53) % 40) - 20;
  const { fundo, motivo } = desenhoDaCena(q);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${LARGURA_DO_QUADRO}" height="${ALTURA_DO_QUADRO}" viewBox="0 0 ${LARGURA_DO_QUADRO} ${ALTURA_DO_QUADRO}">` +
    `<rect width="${LARGURA_DO_QUADRO}" height="${ALTURA_DO_QUADRO}" fill="${fundo}"/><g transform="translate(${d} 0)">${motivo}</g></svg>`
  );
}

type Sharp = typeof SharpDoPacote;

/** Os quadros do caso, desenhados pela cena e gravados em JPEG de 768 × 432, na ordem dos vídeos (para a rodada paga). */
export async function quadrosDoCaso(c: CasoDosCortes, carregar: () => Promise<Sharp> = carregarSharp): Promise<Array<Array<{ tempoMs: number; jpeg: Uint8Array }>>> {
  const sharp = await carregar();
  const quadros: Array<Array<{ tempoMs: number; jpeg: Uint8Array }>> = [];
  for (const v of c.videos) {
    const doVideo: Array<{ tempoMs: number; jpeg: Uint8Array }> = [];
    for (const q of v.quadros) {
      const jpeg = await sharp(Buffer.from(svgDoQuadro(q), 'utf8'), { failOn: 'error' }).jpeg({ quality: 80 }).toBuffer();
      doVideo.push({ tempoMs: Math.round(q.tempo_s * 1000), jpeg });
    }
    quadros.push(doVideo);
  }
  return quadros;
}

/** Avaliador determinístico: o schema, a conferência de produção (com os fatos, as proibidas e os concorrentes do dossiê) e as regras do caso. */
export function avaliarCortes(caso: CasoDosCortes, bruto: unknown): Avaliacao {
  let valor = bruto;
  if (typeof bruto === 'string') {
    try {
      valor = JSON.parse(bruto);
    } catch {
      return { ok: false, falhas: ['formato: a resposta não é JSON'] };
    }
  }
  const lida = RespostaDosCortes.safeParse(valor);
  if (!lida.success) return { ok: false, falhas: [`formato: ${lida.error.issues.map((i) => `${i.path.join('.') || '(raiz)'}: ${i.message}`).join('; ')}`] };
  const pedido = pedidoDoCasoDosCortes(caso);
  const c = cortesDaResposta(lida.data, pedido, { fatos: fatosDoDossie(caso.marca, caso.dossie, caso.provas), proibidas: proibidasDoDossie(caso.dossie), concorrentes: concorrentesDoDossie(caso.dossie) });
  if (!c.ok) {
    if (c.achados.length) return { ok: false, falhas: c.achados.map((a) => `${a.tipo}: ${a.trecho}`) };
    return { ok: false, falhas: [`${c.motivo}: ${c.corte === null ? 'a proposta' : `o corte ${c.corte + 1}`} não chegaria à pessoa`] };
  }
  const falhas: string[] = [];
  const usados = new Set(c.cortes.map((x) => x.video + 1));
  for (const v of caso.espera.videos ?? []) if (!usados.has(v)) falhas.push(`faltou_video: o vídeo ${v} não aparece em corte nenhum`);
  const legendas = c.cortes.map((x) => normalizar(x.legenda));
  for (const termos of caso.espera.cita ?? []) if (!legendas.some((l) => termos.some((t) => l.includes(normalizar(t).trim())))) falhas.push(`nao_citou: nenhuma legenda traz ${termos.join(' nem ')}`);
  for (const x of caso.espera.nao_cita ?? []) if (legendas.some((l) => l.includes(normalizar(x).trim()))) falhas.push(`citou: ${x}`);
  return { ok: falhas.length === 0, falhas };
}
