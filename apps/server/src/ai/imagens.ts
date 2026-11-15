import { createHash } from 'node:crypto';

// As imagens que o gateway pode mandar ao modelo (A6, o vídeo com os cortes escolhidos pelo Social media; D-A6-82). A IA
// não gera imagem nem vídeo, mas enxerga: o Social media vê quadros dos vídeos da loja para escolher os cortes. Só as
// tarefas desta lista mandam imagem, cada uma com a sua política (o que vai, por que, e o texto da Política de
// Privacidade antes de ligar). A imagem nunca vai para o registro de uso, para o log nem para a auditoria: só a
// quantidade e os bytes. Funções puras.

/** As tarefas que podem mandar imagem ao modelo. Tarefa fora da lista com imagem é recusada antes de qualquer chamada. */
export const TAREFAS_COM_IMAGEM: ReadonlySet<string> = new Set(['social_cortes']);

/** Até 16 imagens por pedido: o bastante para os quadros de 4 vídeos curtos, com o custo previsível. */
export const IMAGENS_POR_PEDIDO_MAXIMAS = 16;

/** Até 400 KB por imagem: o quadro reduzido a 768 px no lado maior, em JPEG, fica bem abaixo disso. */
export const BYTES_POR_IMAGEM_MAXIMOS = 400_000;

/** O lado maior do quadro que vai ao modelo: menos tokens, e o bastante para ver o produto e a cena. */
export const LADO_MAIOR_DA_IMAGEM = 768;

/**
 * Os tokens de entrada de uma imagem, pela regra publicada pela Anthropic (documentação "Vision", "Calculate image
 * costs": tokens = largura × altura / 750, para a imagem que não precisa ser reduzida pelo fornecedor). É estimativa para
 * a tela e para o eval; o custo de verdade é o que o fornecedor devolve no uso da chamada.
 */
export const tokensDaImagem = (largura: number, altura: number): number => Math.ceil((largura * altura) / 750);

/** Os bytes começam como JPEG (o marcador SOI, FF D8 FF)? Só JPEG vai ao modelo. */
export const ehJpeg = (b: Uint8Array): boolean => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;

/** Os marcadores SOF do JPEG (C0 a CF, menos C4, C8 e CC): é neles que vêm a altura e a largura da imagem. */
const ehSof = (m: number): boolean => m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;

/**
 * As medidas lidas do próprio JPEG (o primeiro segmento SOF depois do SOI), para a medida não depender de quem chama;
 * nulo quando os bytes não trazem um SOF antes do começo da imagem (SOS) ou acabam no meio.
 */
export function medidasDoJpeg(b: Uint8Array): { largura: number; altura: number } | null {
  if (!ehJpeg(b)) return null;
  let i = 2;
  while (i + 3 < b.length) {
    if (b[i] !== 0xff) return null;
    const m = b[i + 1]!;
    if (m === 0xff) {
      i += 1;
      continue;
    }
    if (m === 0xd9 || m === 0xda) return null;
    const tamanho = (b[i + 2]! << 8) | b[i + 3]!;
    if (ehSof(m)) {
      if (i + 8 >= b.length) return null;
      return { altura: (b[i + 5]! << 8) | b[i + 6]!, largura: (b[i + 7]! << 8) | b[i + 8]! };
    }
    if (tamanho < 2) return null;
    i += 2 + tamanho;
  }
  return null;
}

/** O que impede mandar estas imagens nesta tarefa; nulo quando pode. */
export function problemaDasImagens(task: string, imagens: ReadonlyArray<{ jpeg: Uint8Array }>): string | null {
  if (!imagens.length) return null;
  if (!TAREFAS_COM_IMAGEM.has(task)) return `a tarefa ${task} não manda imagem ao modelo`;
  if (imagens.length > IMAGENS_POR_PEDIDO_MAXIMAS) return `${imagens.length} imagens, acima do máximo de ${IMAGENS_POR_PEDIDO_MAXIMAS}`;
  if (imagens.some((i) => !ehJpeg(i.jpeg))) return 'imagem que não é JPEG';
  if (imagens.some((i) => i.jpeg.byteLength > BYTES_POR_IMAGEM_MAXIMOS)) return `imagem acima de ${BYTES_POR_IMAGEM_MAXIMOS} bytes`;
  // As medidas vêm do próprio JPEG: o teto de custo vale mesmo se quem chama esquecer de reduzir o quadro.
  for (const i of imagens) {
    const m = medidasDoJpeg(i.jpeg);
    if (!m || !m.largura || !m.altura) return 'imagem sem as medidas no JPEG';
    if (Math.max(m.largura, m.altura) > LADO_MAIOR_DA_IMAGEM) return `imagem com ${Math.max(m.largura, m.altura)} px no lado maior, acima de ${LADO_MAIOR_DA_IMAGEM}`;
  }
  return null;
}

/**
 * O pedido como fica guardado em `ai_exchange` (30 dias, para investigar erro e abuso): cada imagem vira só os bytes e o
 * resumo (sha256), nunca o conteúdo. O resto do pedido fica como foi enviado (o texto já passou pela limpeza). A imagem
 * vai ao SDK como parte `file` com o `mediaType` de imagem (a parte `image` está obsoleta no AI SDK); as duas formas são
 * reconhecidas aqui, para nenhuma deixar a imagem inteira no registro.
 */
export function paraGuardar<T extends { messages: ReadonlyArray<{ role: string; content: unknown }> }>(enviado: T): T {
  const bytesDa = (p: { type?: string; image?: unknown; data?: unknown }): Uint8Array | null =>
    p.type === 'image' && p.image instanceof Uint8Array ? p.image : p.type === 'file' && p.data instanceof Uint8Array ? p.data : null;
  return {
    ...enviado,
    messages: enviado.messages.map((m) =>
      Array.isArray(m.content)
        ? {
            ...m,
            content: m.content.map((p: { type?: string; image?: unknown; data?: unknown }) => {
              const bytes = bytesDa(p);
              return bytes ? { type: 'image', bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') } : p;
            }),
          }
        : m,
    ),
  };
}
