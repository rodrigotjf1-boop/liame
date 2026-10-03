import type { TeamStat } from '@liame/contracts';
import { type DefinicaoDoMembro, GESTOR_DE_TRAFEGO, type Membro } from './membros.js';

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
  /** Há uma parada (da empresa ou da Liame) que trava a IA desta marca. */
  parada: boolean;
}

/**
 * A situação de um membro, do que mais pesa ao que menos: desligado pela empresa; fora do plano; quem usa IA para
 * sem a IA e trava com a parada; o Gestor de tráfego só trabalha com a sombra ligada. Quem trabalha por regra
 * (Relatórios, Compliance, a sombra) segue com a parada: ela trava a IA e as ações, e eles não fazem nenhuma das duas
 * (a revisão da semana sai com o resumo do sistema).
 */
export function situacaoDoMembro(def: DefinicaoDoMembro, f: FatosDoMembro): SituacaoDoMembro {
  if (f.pausado) return 'desligado';
  if (!f.peloPlano) return 'desligado_pela_liame';
  if (def.kind === 'ia') {
    if (!f.ia) return 'desligado_pela_liame';
    return f.parada ? 'parado' : 'ativo';
  }
  if (def.key === GESTOR_DE_TRAFEGO) return f.sombra ? 'sombra' : 'desligado_pela_liame';
  return 'ativo';
}

/** As contagens do mês que o serviço leu (zero quando não há). */
export interface ContagensDoMes {
  /** Respostas com `outcome = ok` em `ai_usage`, por fluxo. */
  respostasPorFluxo: Map<string, number>;
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
  switch (chave) {
    case 'lia':
      return [qtd('respostas', soma(c.respostasPorFluxo)), qtd('fez_sentido', retorno.fezSentido), qtd('discordo', retorno.discordo), qtd('demandas', c.demandasDaLia)];
    case 'analista':
      return [qtd('explicacoes', soma(c.respostasPorFluxo)), qtd('fez_sentido', retorno.fezSentido), qtd('discordo', retorno.discordo)];
    case 'relatorios':
      return [qtd('revisoes', c.revisoes), qtd('com_leitura_da_ia', c.revisoesComLeituraDaIa), qtd('so_do_sistema', c.revisoes - c.revisoesComLeituraDaIa)];
    case 'compliance':
      // As regras rodam no código e a recusa ainda não fica registrada por texto: sem números por enquanto.
      return [];
    case 'estrategista':
      return [qtd('planos_aprovados', c.planosAprovados), qtd('planos_recusados', c.planosRecusados), qtd('planos_esperando', c.planosEsperando), qtd('em_preparo', c.emPreparo)];
    case 'pesquisador':
      return [qtd('paginas_lidas', c.paginasLidas), qtd('recusadas', c.paginasRecusadas), qtd('sugestoes', c.sugestoesDoPesquisador)];
    case 'trafego':
      return [
        qtd('recomendacoes', c.recomendacoes),
        qtd('comparaveis', c.comparaveis),
        qtd('mesma_direcao', c.mesmaDirecao),
        { key: 'arrependimento', value: c.arrependimentoMicros.toString(), unit: 'brl_micros' },
      ];
  }
}
