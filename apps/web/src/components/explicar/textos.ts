import type { ExplanationResponse } from '@liame/contracts';
import type { NomeIcone } from '@/components/ui/icone';
import { horaDe } from '@/lib/formato';

// Regras e frases do "Explicar" (mockups/prototipo-explicar.html, P4 aprovado em 02/10/2026). O texto da
// explicação vem pronto da API, em trechos; aqui fica o que a tela diz em volta dele: o selo do risco, por
// que a explicação é a do sistema e os motivos do "Discordo". Tudo o que chega como texto livre (risco,
// motivo) tem um caminho para o valor que a tela ainda não conhece (V23).

export type Risco = 'baixo' | 'medio' | 'alto';

const RISCOS: Record<Risco, { classe: string; rotulo: string }> = {
  baixo: { classe: 'st--concluido', rotulo: 'Risco baixo' },
  medio: { classe: 'st--aguardando', rotulo: 'Risco médio' },
  alto: { classe: 'st--perigo', rotulo: 'Risco alto' },
};

/** O selo do risco; valor que a tela não conhece vira "médio" (nunca "baixo"). */
export function seloDoRisco(risk: string): { classe: string; rotulo: string } {
  return RISCOS[risk === 'baixo' || risk === 'alto' ? risk : 'medio'];
}

/** De quem é a explicação: da LIA (`lia`) ou do sistema (qualquer outro valor). */
export function ehDaLia(r: Pick<ExplanationResponse, 'source'>): boolean {
  return r.source === 'lia';
}

export type AcaoDoAviso = 'de-novo' | 'ver-conexao';

export type AvisoSemIa = {
  /** `atencao`: tem algo para a pessoa resolver (dado velho). `neutro`: só informa. */
  tom: 'atencao' | 'neutro';
  icone: NomeIcone;
  titulo: string;
  texto: string;
  acao: AcaoDoAviso | null;
};

const SISTEMA_ATE_LA = 'Até lá, o resumo é montado pelo sistema com os mesmos números.';

/** "Regem · Loja Centro: última leitura em 02/10/2026 09:42" (ou "ainda não foi lida"). */
function fonteParada(f: ExplanationResponse['stale_sources'][number]): string {
  const nome = f.platform ? `${f.platform} · ${f.name}` : f.name;
  return f.last_read ? `${nome}: última leitura em ${f.last_read}` : `${nome}: ainda não foi lida`;
}

/**
 * Por que a explicação é a do sistema e o que dá para fazer, como no protótipo. Nulo quando ela é da LIA.
 * Motivo que a tela ainda não conhece é tratado como "a LIA não respondeu agora".
 */
export function avisoSemIa(r: Pick<ExplanationResponse, 'source' | 'reason' | 'retry_at' | 'budget_window' | 'stale_sources'>): AvisoSemIa | null {
  if (ehDaLia(r)) return null;
  switch (r.reason) {
    case 'dado_velho': {
      const fontes = r.stale_sources.map(fonteParada);
      const quais = fontes.length === 1 ? `${fontes[0]}.` : fontes.length ? `${fontes.join('; ')}.` : 'Alguma fonte desta tela não está em dia.';
      return {
        tom: 'atencao',
        icone: 'clock',
        titulo: 'A LIA não explica com dado velho',
        texto: `${quais} Este resumo foi montado pelo sistema com os números que já tinham chegado.`,
        acao: 'ver-conexao',
      };
    }
    case 'numero_fora':
      return {
        tom: 'neutro',
        icone: 'shield',
        titulo: 'A resposta da LIA não passou na conferência dos números',
        texto: 'Ela citou um número que não está nos dados desta tela, então o texto não foi mostrado. Este resumo foi montado pelo sistema.',
        acao: 'de-novo',
      };
    case 'trecho_proibido':
    case 'compliance':
    case 'risco':
    case 'vazia':
    case 'longa':
      return {
        tom: 'neutro',
        icone: 'shield',
        titulo: 'A resposta da LIA não passou na conferência',
        texto: 'O texto dela não seguiu as regras desta tela, então não foi mostrado. Este resumo foi montado pelo sistema.',
        acao: 'de-novo',
      };
    case 'limite_usuario':
      return {
        tom: 'neutro',
        icone: 'clock',
        titulo: 'Você chegou ao limite de explicações por hora',
        texto: `${r.retry_at ? `A LIA volta a responder às ${horaDe(r.retry_at)}.` : 'A LIA volta a responder em até uma hora.'} ${SISTEMA_ATE_LA}`,
        acao: null,
      };
    case 'teto':
      return r.budget_window === 'mes'
        ? { tom: 'neutro', icone: 'clock', titulo: 'O limite de uso de IA deste mês foi atingido', texto: `A LIA volta a responder no mês que vem. ${SISTEMA_ATE_LA}`, acao: null }
        : { tom: 'neutro', icone: 'clock', titulo: 'O limite de uso de IA de hoje foi atingido', texto: `A LIA volta a responder amanhã. ${SISTEMA_ATE_LA}`, acao: null };
    case 'desligada':
    case 'funcionario_desligado':
      return {
        tom: 'neutro',
        icone: 'info',
        titulo: 'A LIA está desligada nesta empresa',
        texto: 'As explicações são montadas pelo sistema, por regra, com os mesmos números.',
        acao: null,
      };
    case 'travada':
    case 'sem_rota':
      return {
        tom: 'neutro',
        icone: 'info',
        titulo: 'A LIA está pausada agora',
        texto: 'Enquanto isso, as explicações são montadas pelo sistema, por regra, com os mesmos números.',
        acao: null,
      };
    case 'conteudo_politico':
      return {
        tom: 'neutro',
        icone: 'shield',
        titulo: 'A LIA não explica campanha de assunto político ou eleitoral',
        texto: 'Uma campanha ou conta desta tela tem nome político ou eleitoral, e esse uso não é permitido no Liame. Este resumo foi montado pelo sistema, só com os números.',
        acao: null,
      };
    default:
      return {
        tom: 'neutro',
        icone: 'alert-circle',
        titulo: 'A LIA não respondeu agora',
        texto: 'Este resumo foi montado pelo sistema com os mesmos números. Nada se perdeu.',
        acao: 'de-novo',
      };
  }
}

/** Os motivos do "Discordo", na ordem do protótipo. O valor é o que a API guarda. */
export const MOTIVOS_DO_DISCORDO = [
  { valor: 'numero', rotulo: 'Um número está errado' },
  { valor: 'motivo', rotulo: 'O motivo não é esse' },
  { valor: 'faltou', rotulo: 'Faltou algo importante' },
  { valor: 'sugestao', rotulo: 'A sugestão não serve para a minha loja' },
] as const;
export type MotivoDoDiscordo = (typeof MOTIVOS_DO_DISCORDO)[number]['valor'];

export const COMENTARIO_MAXIMO = 500;

/** O "Discordo" pede pelo menos um motivo ou um comentário (a mesma regra do servidor). */
export function discordoValido(motivos: readonly string[], comentario: string): boolean {
  return motivos.length > 0 || comentario.trim().length > 0;
}

/** "De onde vêm os números (5)". */
export function tituloDasFontes(quantos: number): string {
  return `De onde vêm os números (${quantos})`;
}

/**
 * Os avisos que têm "Explicar": os de campanha, os de medição e os que saíram do normal. É a lista do
 * contrato (`EXPLAINABLE_ATTENTION_KINDS`), repetida aqui para o navegador não carregar os schemas só por
 * causa dela; o teste da tela confere que as duas são iguais.
 */
export const AVISOS_COM_EXPLICACAO: readonly string[] = [
  'campanha_parou',
  'gasto_fora_do_normal',
  'campanha_sem_pedido',
  'cupom_sem_uso',
  'anuncio_sem_rastreio',
  'campanha_sem_cupom',
  'margem_desconhecida',
  'plataforma_x_caixa',
  'vendas_fora_do_normal',
  'gasto_da_campanha_fora_do_normal',
  'custo_por_pedido_fora_do_normal',
];

/** Este aviso tem "Explicar"? Só com a marca dele: é com ela que a tela pede a explicação. */
export function avisoTemExplicacao(item: { kind: string; brand_id: string | null }): boolean {
  return !!item.brand_id && AVISOS_COM_EXPLICACAO.includes(item.kind);
}
