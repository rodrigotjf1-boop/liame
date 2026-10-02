import { type AttentionItem, EXPLAINABLE_ATTENTION_KINDS } from '@liame/contracts';
import { plataforma } from '../registro/leituras.visoes.js';
import type { AvisoNoContexto, ContextoDoAviso } from './contexto.js';
import type { Explicacao } from './resposta.js';

// "Explicar" de um aviso da Atenção (A3, I4; protótipo P4). A mesma tarefa e o mesmo prompt do Explicar dos
// resultados: o contexto leva o aviso na frente e os resultados dos últimos 7 dias completos da marca.

/**
 * Os avisos que têm explicação: os de campanha, os de medição e os que saíram do normal. Os de conexão, de
 * leitura atrasada e de configuração já dizem o que fazer e não têm número para explicar (e, com a fonte
 * parada, a IA não explica: dado velho).
 */
export const AVISOS_EXPLICAVEIS: ReadonlySet<string> = new Set(EXPLAINABLE_ATTENTION_KINDS);

/** Quantos dias completos de resultado acompanham o aviso (a mesma janela dos avisos de venda). */
export const DIAS_DO_AVISO = 7;
/** Como o contexto diz à IA (e à lista de fontes) de quando são os números que acompanham o aviso. */
export const RESULTADOS_DO_AVISO = `últimos ${DIAS_DO_AVISO} dias completos`;

export function avisoNoContexto(item: Pick<AttentionItem, 'kind' | 'severity' | 'title' | 'detail' | 'action' | 'provider'>, campanha: string | null): AvisoNoContexto {
  const nome = plataforma(item.provider);
  return {
    gravidade: item.severity,
    tipo: item.kind,
    ...(nome ? { plataforma: nome } : {}),
    ...(campanha ? { campanha } : {}),
    titulo: item.title,
    detalhe: item.detail,
    o_que_fazer: item.action,
    resultados_de: RESULTADOS_DO_AVISO,
  };
}

const comPonto = (s: string) => {
  const t = s.trim();
  return /[.!?]$/.test(t) ? t : `${t}.`;
};

/**
 * A explicação de um aviso sem IA (A3-6): o que o aviso diz, o número do período que dá o contexto e o que
 * fazer, tudo por regra. É o que vale com a IA desligada, fora do ar, no teto ou com a resposta recusada.
 */
export function explicacaoDoAvisoSemIa(c: ContextoDoAviso): Explicacao {
  const a = c.aviso;
  const p = c.resultado.periodo;
  const periodo = `De ${p.de} a ${p.ate}`;
  const campanha = a.campanha ? c.resultado.campanhas.find((k) => k.campanha === a.campanha) : undefined;
  const t = c.resultado.totais;
  const motivos: string[] = [];
  if (a.campanha && campanha?.plataforma_informa.investimento) {
    const receita = campanha.caixa_confirma.receita;
    motivos.push(
      `${periodo}, a campanha "${a.campanha}" teve investimento de ${campanha.plataforma_informa.investimento} e ${campanha.caixa_confirma.pedidos ?? '0'} pedido(s) confirmado(s) no caixa${receita && receita !== 'R$ 0,00' ? `, com receita de ${receita}` : ''}.`,
    );
  } else if (a.campanha) {
    motivos.push(`${periodo}, a campanha "${a.campanha}" não teve investimento lido pelo Liame nem pedido confirmado no caixa.`);
  } else {
    motivos.push(`${periodo}, o investimento em anúncios foi de ${t.investimento} e o caixa confirmou ${t.com_origem_provada.pedidos ?? '0'} pedido(s) com origem provada em campanha.`);
  }
  // O risco acompanha a gravidade que as regras da Atenção já deram ao aviso.
  const [risco, porque]: [Explicacao['risco'], string] =
    a.gravidade === 'critica'
      ? ['alto', 'este aviso é crítico: precisa de alguém agora.']
      : a.gravidade === 'atencao'
        ? ['medio', 'este aviso pede atenção: vale conferir antes que custe mais.']
        : ['baixo', 'este aviso é só informativo.'];
  return {
    o_que_aconteceu: `${comPonto(a.titulo)} ${comPonto(a.detalhe)}`,
    motivos,
    risco,
    risco_motivo: `pela regra do sistema, ${porque}`,
    o_que_fazer: [comPonto(a.o_que_fazer)],
  };
}
