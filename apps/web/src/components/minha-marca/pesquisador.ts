import type { BrandDossierSuggestion, DossierSection, ResearchListResponse, ResearchResponse } from '@liame/contracts';
import { diasAte, horaDe, quandoComHora } from '@/lib/formato';
import { juntar, SECAO } from './textos';

// "Ler uma página" (mockups/prototipo-pesquisador.html, P25 aprovado em 21/10/2026): os textos e as regras do cartão
// "Páginas lidas" e da gaveta de pedir, em funções puras. As situações e os porquês são os que o servidor grava
// (`worker/pesquisa-loop.ts` e `worker/pesquisa.service.ts`): a recusa fecha o pedido; a falha passageira volta para a
// fila e é tentada de novo, cada vez mais tarde, até 5 vezes; sem a IA ou sem o Pesquisador, o pedido espera sem contar
// tentativa (e volta para a fila na hora quando o Pesquisador é ligado de novo em Sua equipe).

export type TipoDePagina = 'site' | 'cardapio' | 'concorrente';

export const TIPOS_DE_PAGINA: ReadonlyArray<{ id: TipoDePagina; rotulo: string; opcao: string; dica: string; icone: 'home' | 'utensils' | 'users'; secao: DossierSection }> = [
  { id: 'site', rotulo: 'site da marca', opcao: 'O site da marca', dica: 'A página inicial ou a página "sobre".', icone: 'home', secao: 'identidade' },
  { id: 'cardapio', rotulo: 'cardápio online', opcao: 'O cardápio online', dica: 'A página com os produtos e os preços.', icone: 'utensils', secao: 'produtos' },
  {
    id: 'concorrente',
    rotulo: 'concorrente',
    opcao: 'A página de um concorrente',
    dica: 'Para entender o mercado; os funcionários não citam concorrente pelo nome em anúncio.',
    icone: 'users',
    secao: 'concorrentes',
  },
];

export const tipoDaPagina = (kind: string) => TIPOS_DE_PAGINA.find((t) => t.id === kind) ?? TIPOS_DE_PAGINA[0]!;

/** O porquê de cada recusa ou falha, pelo código que o servidor grava. */
export const MOTIVO_DA_LEITURA: Record<string, string> = {
  robots: 'O site pede para não ser lido por programas (o robots.txt dele), e o Liame respeita.',
  robots_fora_do_ar: 'O robots.txt do site não respondeu, e sem ele o Liame não lê.',
  instrucao_na_pagina: 'A página tem um texto que tenta dar ordens ao Liame. Por segurança, nada dela foi usado.',
  sem_texto: 'A página quase não tem texto (pode ser só imagem).',
  nao_e_pagina: 'O endereço não é uma página: é um arquivo ou uma imagem.',
  grande_demais: 'A página é grande demais para ler.',
  fora_do_ar: 'O site não respondeu.',
  nao_achou: 'A página não existe mais nesse endereço.',
  sem_acesso: 'A página pede login.',
  rede_interna: 'O endereço aponta para uma rede interna, que o Liame não acessa.',
  ia_fora_do_ar: 'O modelo de IA não respondeu.',
  formato: 'A leitura não voltou no formato esperado.',
  erro: 'Um erro do Liame.',
};

/**
 * O pedido que voltou para a fila sem contar tentativa: espera a IA, o Pesquisador ou o limite de uso. Sem prometer
 * hora: a volta marcada vai de um minuto a seis horas, conforme o motivo (`VOLTA`, em `worker/pesquisa-loop.ts`).
 */
const ESPERA: Record<string, string> = {
  ia_desligada: 'A IA está desligada nesta empresa. A leitura espera a IA voltar.',
  desligada: 'A IA está desligada nesta empresa. A leitura espera a IA voltar.',
  travada: 'A IA está parada nesta empresa. A leitura espera ela voltar.',
  funcionario_desligado: 'O Pesquisador está desligado nesta marca. A leitura espera ele ser ligado de novo.',
  teto: 'O limite de uso de IA de hoje foi atingido. A leitura volta mais tarde.',
  sem_rota: 'O Pesquisador ainda não tem um modelo de IA liberado. A leitura volta mais tarde.',
  limite_usuario: 'O limite de uso de IA foi atingido. A leitura volta em instantes.',
};

/** As recusas que se resolvem preenchendo a parte à mão (a página não deixa ser lida, ou não tem o que ler). */
const PREENCHER_A_MAO = new Set(['robots', 'sem_acesso', 'sem_texto', 'nao_e_pagina', 'grande_demais']);

export type Situacao = { classe: string; rotulo: string; texto: string };

/** A sugestão do Pesquisador que ainda espera conferência numa das partes que esta leitura alimentou. */
export function sugestaoDaLeitura(x: ResearchResponse, sugestoes: readonly BrandDossierSuggestion[]): BrandDossierSuggestion | null {
  if (x.status !== 'concluida' || !x.sections.length) return null;
  return sugestoes.find((s) => s.source === 'pesquisador' && x.sections.includes(s.section)) ?? null;
}

/** A situação de um pedido em palavra, para quem lê a lista. */
export function situacaoDaLeitura(x: ResearchResponse, sugestoes: readonly BrandDossierSuggestion[]): Situacao {
  if (x.status === 'lendo') return { classe: 'st--ia', rotulo: 'Lendo agora', texto: 'O Pesquisador está lendo a página.' };
  if (x.status === 'pendente') {
    if (!x.reason) return { classe: 'st--espera', rotulo: 'Na fila', texto: 'O Pesquisador lê em alguns minutos.' };
    const espera = ESPERA[x.reason];
    if (espera) return { classe: 'st--espera', rotulo: 'Esperando', texto: espera };
    return {
      classe: 'st--aguardando',
      rotulo: 'Vai tentar de novo',
      texto: `${MOTIVO_DA_LEITURA[x.reason] ?? MOTIVO_DA_LEITURA.erro} O Liame tenta de novo sozinho, cada vez mais tarde, até 5 vezes.`,
    };
  }
  if (x.status === 'concluida') {
    if (!x.sections.length) return { classe: 'st--concluido', rotulo: 'Pronta', texto: 'Nada novo para sugerir: o que a página diz já está em Minha marca.' };
    const partes = juntar(x.sections.map((s) => SECAO[s as DossierSection]?.titulo ?? s));
    if (sugestaoDaLeitura(x, sugestoes)) {
      return { classe: 'st--concluido', rotulo: 'Pronta', texto: `${partes} ${x.sections.length === 1 ? 'ganhou uma sugestão' : 'ganharam sugestões'} para conferir.` };
    }
    return { classe: 'st--concluido', rotulo: 'Pronta', texto: `${partes}: a sugestão já foi conferida.` };
  }
  if (x.status === 'recusada') return { classe: 'st--perigo', rotulo: 'Recusada', texto: MOTIVO_DA_LEITURA[x.reason ?? ''] ?? MOTIVO_DA_LEITURA.erro! };
  return { classe: 'st--perigo', rotulo: 'Não deu para ler', texto: `${MOTIVO_DA_LEITURA[x.reason ?? ''] ?? MOTIVO_DA_LEITURA.erro} O Liame tentou 5 vezes.` };
}

export type AcaoDaLeitura =
  | { tipo: 'conferir'; sugestao: BrandDossierSuggestion }
  | { tipo: 'ler-de-novo' }
  | { tipo: 'outro-endereco' }
  | { tipo: 'a-mao'; secao: DossierSection }
  | null;

/**
 * O que resolve cada caso (V59): conferir a sugestão; ler de novo só depois de o Liame desistir (a falha passageira ele
 * repete sozinho); outro endereço quando a página não existe mais; preencher à mão quando a página não deixa ser lida.
 * A página que tenta dar ordens ao Liame e a da rede interna não têm ação.
 */
export function acaoDaLeitura(x: ResearchResponse, sugestoes: readonly BrandDossierSuggestion[], podePedir: boolean, podeEditar: boolean): AcaoDaLeitura {
  const sugestao = sugestaoDaLeitura(x, sugestoes);
  if (sugestao && podeEditar) return { tipo: 'conferir', sugestao };
  if (!podePedir) return null;
  if (x.status === 'falhou') return { tipo: 'ler-de-novo' };
  if (x.status === 'recusada' && x.reason === 'nao_achou') return { tipo: 'outro-endereco' };
  if (x.status === 'recusada' && x.reason && PREENCHER_A_MAO.has(x.reason) && podeEditar) return { tipo: 'a-mao', secao: tipoDaPagina(x.kind).secao };
  return null;
}

/**
 * "Pedida por Rodrigo, hoje, 10:12 · lida às 10:13": no mesmo dia, só a hora do fim; em outro dia, "lida hoje, 00:05"
 * ou "lida em 19/10, 10:13".
 */
export function quandoDaLeitura(x: ResearchResponse, agora: Date): string {
  const pedida = quandoComHora(x.created_at, agora);
  const quem = x.requested_by?.name ?? 'alguém que não está mais na empresa';
  if (!x.finished_at || x.status === 'pendente' || x.status === 'lendo') return `Pedida por ${quem}, ${pedida}`;
  const fim = quandoComHora(x.finished_at, agora);
  if (fim === pedida) return `Pedida por ${quem}, ${pedida}`;
  const diaDoFim = fim.split(', ')[0];
  const verbo = x.status === 'concluida' ? 'lida' : 'fechada';
  if (diaDoFim === pedida.split(', ')[0]) return `Pedida por ${quem}, ${pedida} · ${verbo} às ${horaDe(x.finished_at)}`;
  return `Pedida por ${quem}, ${pedida} · ${verbo} ${diaDoFim === 'hoje' || diaDoFim === 'ontem' ? fim : `em ${fim}`}`;
}

/** A mesma conferência que o servidor faz no pedido (só https, endereço completo, sem usuário e senha), antes de mandar. */
export function conferirEndereco(texto: string): string | null {
  const u = texto.trim();
  if (!u) return 'Cole o endereço da página.';
  let x: URL;
  try {
    x = new URL(u);
  } catch {
    return 'Esse endereço não está completo. Copie da barra do navegador, começando com https://';
  }
  if (x.protocol !== 'https:') return 'Use o endereço completo, começando com https://';
  if (x.username || x.password) return 'O endereço não pode ter usuário e senha.';
  return null;
}

/** "hoje, 21:00" ou "amanhã, 21:00": quando a conta do dia recomeça, no relógio de quem vê (a janela é o dia em UTC). */
export function quandoRecomeca(iso: string, agora: Date): string {
  return diasAte(iso, agora) === 1 ? `amanhã, ${horaDe(iso)}` : quandoComHora(iso, agora);
}

/** O limite é da marca, não de quem pede: a frase não diz "você" (outra pessoa da equipe pode ter pedido). */
export const limiteDoDia = (daily: ResearchListResponse['daily']) => `Já foram pedidas as ${daily.limit} leituras do dia desta marca`;

/** "3 de 20 leituras desta marca usadas · a conta recomeça hoje, 21:00". */
export function linhaDoLimite(daily: ResearchListResponse['daily'], agora: Date): string {
  const usadas = Math.min(daily.used, daily.limit);
  return `${usadas} de ${daily.limit} leituras desta marca usadas · a conta recomeça ${quandoRecomeca(daily.resets_at, agora)}`;
}

/** Algum pedido ainda anda sozinho (na fila sem motivo, ou sendo lido): a tela lê a lista de novo, de tempos em tempos. */
export const emAndamento = (items: readonly ResearchResponse[]) => items.some((x) => x.status === 'lendo' || (x.status === 'pendente' && !x.reason));

/**
 * O aviso do cartão quando não dá para pedir uma leitura agora. Quem liga o Pesquisador de novo em Sua equipe é quem
 * gerencia a equipe (`agentes.gerenciar`); quem pede leituras é quem muda a marca (`dossie.editar`): o texto é de
 * quem lê (V128).
 */
export function avisoDoPesquisador(status: string, quem: { podeEditar: boolean; podeLigar: boolean }): { titulo: string; texto: string; abrirEquipe: boolean } | null {
  if (status === 'ia_desligada') {
    return { titulo: 'A IA está desligada nesta empresa', texto: 'O Pesquisador não lê páginas sem ela. As leituras pedidas esperam a IA voltar.', abrirEquipe: false };
  }
  if (status === 'desligado_pela_liame') {
    return { titulo: 'O Pesquisador foi desligado pela Liame nesta marca', texto: 'Ele não lê páginas por enquanto. As leituras pedidas esperam ele ser ligado de novo.', abrirEquipe: false };
  }
  if (status === 'pesquisador_desligado') {
    const comoLigar = quem.podeLigar
      ? quem.podeEditar
        ? 'Para pedir leituras, ligue-o em Sua equipe.'
        : 'Dá para ligá-lo de novo em Sua equipe.'
      : 'Quem gerencia a equipe liga o Pesquisador de novo, em Sua equipe.';
    return { titulo: 'O Pesquisador está desligado nesta marca', texto: `${comoLigar} As leituras pedidas esperam.`, abrirEquipe: quem.podeLigar };
  }
  return null;
}
