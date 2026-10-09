import type { TeamStat } from '@liame/contracts';
import { CRIATIVO_DA_EQUIPE, type DefinicaoDoMembro, GESTOR_DE_TRAFEGO, type Membro } from './membros.js';

// Sua equipe (A3, I13b): a situação de cada membro e o que ele fez no mês, montados pelo código a partir das
// contagens que o serviço lê do banco. Funções puras.

export type SituacaoDoMembro = 'ativo' | 'sombra' | 'desligado' | 'desligado_pela_liame' | 'parado';

export interface FatosDoMembro {
  /** A empresa desligou este membro nesta marca. */
  pausado: boolean;
  /** A chave da distribuição (o plano) deixa este membro trabalhar (quem não está no registro, sempre). */
  peloPlano: boolean;
  /** A flag `ia` da empresa. */
  ia: boolean;
  /** A flag `sombra` da empresa. */
  sombra: boolean;
  /** A flag `criativo` da empresa (só o Criativo depende dela). */
  criativo: boolean;
  /** Há uma parada (da empresa ou da Liame) que trava a IA desta marca. */
  parada: boolean;
}

/**
 * A situação de um membro, do que mais pesa ao que menos: desligado pela empresa; fora do plano; quem usa IA para
 * sem a IA e trava com a parada (o Criativo, além da IA, precisa da flag dele); o Gestor de tráfego só trabalha com a
 * sombra ligada. Quem trabalha por regra
 * (Relatórios, Compliance, a sombra) segue com a parada: ela trava a IA e as ações, e eles não fazem nenhuma das duas
 * (a revisão da semana sai com o resumo do sistema).
 */
export function situacaoDoMembro(def: DefinicaoDoMembro, f: FatosDoMembro): SituacaoDoMembro {
  if (f.pausado) return 'desligado';
  if (!f.peloPlano) return 'desligado_pela_liame';
  if (def.kind === 'ia') {
    if (!f.ia) return 'desligado_pela_liame';
    if (def.key === CRIATIVO_DA_EQUIPE && !f.criativo) return 'desligado_pela_liame';
    return f.parada ? 'parado' : 'ativo';
  }
  if (def.key === GESTOR_DE_TRAFEGO) return f.sombra ? 'sombra' : 'desligado_pela_liame';
  return 'ativo';
}

/** As contagens do mês que o serviço leu (zero quando não há). */
export interface ContagensDoMes {
  /**
   * Respostas do modelo, por fluxo: as chamadas que entregaram a resposta de um pedido (`ai_usage.answered`). Uma
   * resposta com leituras faz várias chamadas; só a última conta. É o que chegou à conferência.
   */
  respostasPorFluxo: Map<string, number>;
  /** As respostas que chegaram à pessoa, por fluxo: as de cima, menos as que a conferência recusou. */
  entreguesPorFluxo: Map<string, number>;
  /** "Fez sentido" e "Discordo" das pessoas, por fluxo. */
  retornoPorFluxo: Map<string, { fezSentido: number; discordo: number }>;
  demandasDaLia: number;
  revisoes: number;
  revisoesComLeituraDaIa: number;
  planosAprovados: number;
  planosRecusados: number;
  planosEsperando: number;
  emPreparo: number;
  paginasLidas: number;
  paginasRecusadas: number;
  sugestoesDoPesquisador: number;
  recomendacoes: number;
  comparaveis: number;
  mesmaDirecao: number;
  /** Soma do arrependimento das comparáveis, em micros de real (negativo: as recomendações teriam feito melhor). */
  arrependimentoMicros: bigint;
  /**
   * O que a conferência recusou, por funcionário que escreveu (`ai_refusal`, D-A3-15): os textos barrados pelo
   * Compliance (regra de texto ou revisor de IA) e as outras recusas (número, formato, dado velho).
   */
  recusasPorMembro: Map<string, { doCompliance: number; outras: number }>;
  /** O trabalho do Criativo (A4, X6): os pedidos e as peças do mês, as de hoje e as que esperam a pessoa agora. */
  pecas: PecasDoCriativo;
}

export interface PecasDoCriativo {
  /** Pedidos de peças novas atendidos no mês. */
  pedidos: number;
  /** Peças que nasceram no mês e, delas, as que uma pessoa aprovou ou recusou. */
  escritas: number;
  aprovadas: number;
  recusadas: number;
  /** Outras versões de uma peça, pedidas e entregues no mês. */
  refeitas: number;
  /** Peças que nasceram hoje (no fuso da empresa). */
  hoje: number;
  /** Agora, na marca inteira: as que passaram na conferência e esperam a decisão, e as que a conferência barrou. */
  esperando: number;
  barradas: number;
}

const qtd = (key: string, n: number): TeamStat => ({ key, value: String(n), unit: 'qtd' });

/** O que o membro fez no mês, como a tela mostra (as chaves estão no contrato `TeamStat`). */
export function numerosDoMembro(def: DefinicaoDoMembro, c: ContagensDoMes): TeamStat[] {
  const soma = (mapa: Map<string, number>) => def.fluxos.reduce((n, f) => n + (mapa.get(f) ?? 0), 0);
  const retorno = def.fluxos.reduce(
    (r, f) => ({ fezSentido: r.fezSentido + (c.retornoPorFluxo.get(f)?.fezSentido ?? 0), discordo: r.discordo + (c.retornoPorFluxo.get(f)?.discordo ?? 0) }),
    { fezSentido: 0, discordo: 0 },
  );
  const chave: Membro = def.key;
  // O que a conferência não deixou aparecer, do que este funcionário escreveu (por qualquer motivo).
  const recusas = c.recusasPorMembro.get(chave);
  const retiradas = qtd('retiradas_na_conferencia', (recusas?.doCompliance ?? 0) + (recusas?.outras ?? 0));
  switch (chave) {
    // Respostas e explicações são as que chegaram à pessoa; as que a conferência retirou vêm ao lado, em `retiradas`.
    case 'lia':
      return [qtd('respostas', soma(c.entreguesPorFluxo)), qtd('fez_sentido', retorno.fezSentido), qtd('discordo', retorno.discordo), qtd('demandas', c.demandasDaLia), retiradas];
    case 'analista':
      return [qtd('explicacoes', soma(c.entreguesPorFluxo)), qtd('fez_sentido', retorno.fezSentido), qtd('discordo', retorno.discordo), retiradas];
    case 'relatorios':
      return [qtd('revisoes', c.revisoes), qtd('com_leitura_da_ia', c.revisoesComLeituraDaIa), qtd('so_do_sistema', c.revisoes - c.revisoesComLeituraDaIa)];
    case 'compliance': {
      // Conferidos: todo texto de IA que chegou à conferência (cada resposta atendida de quem escreve; as chamadas do
      // próprio revisor de IA, que são os fluxos do Compliance, não são texto para conferir). Barrados: os que uma regra
      // de texto (ou o revisor de IA) não deixou aparecer, de qualquer funcionário.
      const conferidos = [...c.respostasPorFluxo.entries()].filter(([fluxo]) => !def.fluxos.includes(fluxo)).reduce((n, [, x]) => n + x, 0);
      const barrados = [...c.recusasPorMembro.values()].reduce((n, x) => n + x.doCompliance, 0);
      return [qtd('textos_conferidos', conferidos), qtd('textos_barrados', barrados)];
    }
    case 'estrategista':
      return [qtd('planos_aprovados', c.planosAprovados), qtd('planos_recusados', c.planosRecusados), qtd('planos_esperando', c.planosEsperando), qtd('em_preparo', c.emPreparo), retiradas];
    case 'pesquisador':
      return [qtd('paginas_lidas', c.paginasLidas), qtd('recusadas', c.paginasRecusadas), qtd('sugestoes', c.sugestoesDoPesquisador), retiradas];
    case 'criativo':
      return [
        qtd('pedidos', c.pecas.pedidos),
        qtd('pecas_escritas', c.pecas.escritas),
        qtd('pecas_aprovadas', c.pecas.aprovadas),
        qtd('pecas_recusadas', c.pecas.recusadas),
        qtd('versoes_refeitas', c.pecas.refeitas),
        qtd('pecas_hoje', c.pecas.hoje),
        qtd('pecas_esperando', c.pecas.esperando),
        qtd('pecas_barradas', c.pecas.barradas),
        retiradas,
      ];
    case 'trafego':
      return [
        qtd('recomendacoes', c.recomendacoes),
        qtd('comparaveis', c.comparaveis),
        qtd('mesma_direcao', c.mesmaDirecao),
        { key: 'arrependimento', value: c.arrependimentoMicros.toString(), unit: 'brl_micros' },
      ];
  }
}
