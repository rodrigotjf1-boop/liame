import { createHash } from 'node:crypto';
import { z } from 'zod';
import { normalizar } from '../../policy/texto.js';
import { temDadoPessoal } from '../sanitizar.js';
import { ENFOQUES_DA_RECLAMACAO, sugestoesPedidasDoComentario, type TipoComSugestao } from './comentario-contexto.js';
import {
  type BaseDoTextoDeResposta,
  caracteres,
  conferirTextoDeResposta,
  type DescarteDaSugestao,
  type RespostaDoSocial,
  type SugestaoConferida,
  type SugestaoDeResposta,
  TAMANHO_MAXIMO,
} from './resposta.js';

// As sugestões de resposta aos comentários e as respostas prontas (A6, Z11, parte 2d-1; D-A6-88 e D-A6-94; P38). Na
// pergunta, o Social media escreve uma sugestão; na reclamação, três, uma para cada caminho (`ENFOQUES_DA_RECLAMACAO`).
// O formato é o mesmo das respostas às avaliações (`RespostaDoSocial`), e a conferência é a mesma
// (`conferirTextoDeResposta`): a compensação prometida, o nome de quem comentou, a resolução que não está confirmada, as
// regras da Liame, das plataformas e da marca, e o número fora do comentário, da legenda do post e dos fatos da marca (o
// preço fora de Minha marca barra). O elogio e a marcação de amigo têm resposta pronta, sem IA (D-A6-88), com variação,
// para não repetir a mesma frase em todos. Funções puras.

/**
 * O formato da resposta do Social media aos comentários (v3, A6, Z11, parte 2e-3; D-A6-92): as sugestões, como nas
 * avaliações, e `respondida`: na pergunta, "sim" quando a sugestão responde à pergunta só com o que o dossiê ou a legenda
 * dizem, e "nao" quando faltou a informação e ela só chama a equipe; na reclamação, sempre "nao". É o que deixa o
 * atendimento automático responder sozinho a pergunta que ele sabe responder com certeza.
 */
export const RespostaDoComentario = z.strictObject({
  sugestoes: z.array(z.strictObject({ enfoque: z.string(), texto: z.string() })),
  respondida: z.enum(['sim', 'nao']),
});
export type RespostaDoComentario = z.infer<typeof RespostaDoComentario>;

/**
 * A pergunta que o atendimento automático pode responder sozinha (D-A6-92: "a pergunta que ele sabe responder com
 * certeza"): o Social media disse que respondeu ("sim"), e a primeira sugestão passou na conferência sem aviso nenhum
 * (nada de número fora das fontes, nada que a conferência apontou) e leva o caminho para falar com a equipe.
 * Qualquer dúvida vai para uma pessoa.
 */
export function respondeComCerteza(
  tipo: TipoComSugestao,
  r: Pick<RespostaDoComentario, 'respondida'>,
  primeira: Pick<SugestaoConferida, 'conferencia' | 'texto'> | undefined,
  contato: string | null,
): boolean {
  return tipo === 'pergunta' && r.respondida === 'sim' && primeira?.conferencia.situacao === 'passou' && levaOCaminhoDaEquipe(primeira.texto, contato);
}

/**
 * A resposta a uma pergunta termina com o caminho para falar com a equipe (D-A6-92; Termos 5.5): o canal de contato
 * do contexto, como o contexto manda escrever (sem o artigo do começo: "o WhatsApp da loja" vale "no WhatsApp da
 * loja"); sem canal informado, os contatos do perfil da loja.
 */
export function levaOCaminhoDaEquipe(texto: string, contato: string | null): boolean {
  const canal = contato ? normalizar(contato).trim().replace(/^(o|a|os|as) /, '') : 'perfil';
  return canal.length >= 3 && normalizar(texto).includes(canal);
}

/** Por que uma sugestão do modelo nem chegou à conferência: os da resposta à avaliação e o enfoque fora dos três. */
export type DescarteDaSugestaoAoComentario = DescarteDaSugestao | 'fora_do_enfoque';

/** Uma linha só, sem espaço dobrado nem tabulação. */
const arrumar = (t: string): string => t.replace(/\s+/g, ' ').trim();

/**
 * O que o código faz com a resposta do modelo. Cada sugestão tem os espaços arrumados e só segue se tem enfoque e
 * texto, cabe no teto do Liame, não traz dado pessoal e não repete o texto de outra nem o da que a pessoa já viu (o
 * "Pedir outra"). Na pergunta, segue a primeira; na reclamação, uma para cada caminho, na ordem dos caminhos, pelo
 * enfoque (o enfoque de outro nome é descartado; o caminho sem sugestão fica sem). As que seguem saem conferidas.
 * `caminhos`: os da reclamação; os do comentário por padrão, e os da conversa particular no Direct (`direct.ts`, Z12 4b).
 */
export function sugestoesDoComentario(
  r: RespostaDoSocial,
  base: BaseDoTextoDeResposta,
  tipo: TipoComSugestao,
  conhecido = '',
  anteriores: readonly string[] = [],
  caminhos: readonly string[] = ENFOQUES_DA_RECLAMACAO,
): { sugestoes: SugestaoConferida[]; descartes: DescarteDaSugestaoAoComentario[] } {
  const descartes: DescarteDaSugestaoAoComentario[] = [];
  const vistas = new Set<string>(anteriores.map((t) => normalizar(arrumar(t))));
  const validas: SugestaoDeResposta[] = [];
  for (const bruta of r.sugestoes) {
    const s: SugestaoDeResposta = { enfoque: arrumar(bruta.enfoque), texto: arrumar(bruta.texto) };
    if (!s.enfoque || !s.texto) descartes.push('vazia');
    else if (caracteres(s.enfoque) > TAMANHO_MAXIMO.enfoque || caracteres(s.texto) > TAMANHO_MAXIMO.texto) descartes.push('longa');
    else if (temDadoPessoal(`${s.enfoque}\n${s.texto}`)) descartes.push('dado_pessoal');
    else if (vistas.has(normalizar(s.texto))) descartes.push('repetida');
    else {
      vistas.add(normalizar(s.texto));
      validas.push(s);
    }
  }
  const conferida = (s: SugestaoDeResposta): SugestaoConferida => ({ ...s, conferencia: conferirTextoDeResposta(s, base, conhecido) });
  if (tipo === 'pergunta') {
    const pedidas = sugestoesPedidasDoComentario(tipo);
    for (let i = pedidas; i < validas.length; i += 1) descartes.push('sobra');
    return { sugestoes: validas.slice(0, pedidas).map(conferida), descartes };
  }
  const sugestoes: SugestaoConferida[] = [];
  const usadas = new Set<number>();
  for (const caminho of caminhos) {
    const i = validas.findIndex((s, j) => !usadas.has(j) && normalizar(s.enfoque) === normalizar(caminho));
    if (i < 0) continue;
    usadas.add(i);
    sugestoes.push(conferida({ enfoque: caminho, texto: validas[i]!.texto }));
  }
  validas.forEach((s, j) => {
    if (usadas.has(j)) return;
    descartes.push(caminhos.some((c) => normalizar(c) === normalizar(s.enfoque)) ? 'sobra' : 'fora_do_enfoque');
  });
  return { sugestoes, descartes };
}

/**
 * As respostas prontas (D-A6-88): o elogio ganha um agradecimento curto; a marcação de amigo, um convite curto. Sem
 * nome, número, link, preço ou promessa; a variação vem do comentário (o mesmo comentário recebe sempre a mesma).
 */
export const RESPOSTAS_PRONTAS = {
  elogio: [
    'Obrigado pelo carinho! Esperamos você de novo.',
    'Que bom que você gostou! Volte sempre.',
    'Valeu demais pelo elogio! Até a próxima.',
    'Ficamos felizes em ler isso. Obrigado e até breve!',
    'Obrigado! A gente se vê na próxima.',
  ],
  marcacao: [
    'Bora! Esperamos vocês por aqui.',
    'Que convite bom! Esperamos vocês.',
    'Chama a turma! A gente espera vocês.',
    'Fica a dica para vocês! Esperamos a visita.',
    'Combinado! Esperamos vocês por aqui.',
  ],
} as const satisfies Record<'elogio' | 'marcacao', readonly string[]>;

/** A resposta pronta do elogio ou da marcação, escolhida pelo id do comentário (`semente`): varia entre os comentários. */
export function respostaPronta(tipo: keyof typeof RESPOSTAS_PRONTAS, semente: string): string {
  const lista = RESPOSTAS_PRONTAS[tipo];
  const n = createHash('sha256').update(`${tipo}:${semente}`).digest().readUInt32BE(0);
  return lista[n % lista.length]!;
}
