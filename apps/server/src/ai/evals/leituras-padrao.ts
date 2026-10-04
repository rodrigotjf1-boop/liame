import { visaoDosAvisos } from '../registro/leituras.visoes.js';

// A leitura que um caso de eval não gravou (A3, evals com modelo de verdade). O modelo de verdade lê mais do que a
// resposta gravada no caso: confere o frescor antes de comentar número (a descrição da ferramenta manda), olha os
// avisos, os cupons e os links. Em produção essas leituras existem sempre; no eval elas falhavam ("Não foi possível
// ler agora."), e a falha virava assunto da resposta. Aqui cada uma devolve uma visão NEUTRA e coerente com o caso:
// as fontes como a leitura dos resultados do caso as mostra, nenhum aviso, nenhum cupom, nenhum link para arrumar.
// O caso que quer outra coisa (um aviso, um cupom, uma fonte parada sem resultado) grava a própria leitura.
// A entrega dos anúncios (`midia_entrega`) e a equipe (`equipe_trabalho`) não têm visão neutra: só gravadas.

const FUSO = 'America/Sao_Paulo';
const EM_DIA = 'em dia';

export interface CasoComLeituras {
  /** O dia do caso (AAAA-MM-DD). */
  hoje: string;
  marca: string;
  leituras: Record<string, unknown>;
}

interface Fonte {
  plataforma: string;
  conta: string;
  dados: string;
  frescor: string;
  ultima_leitura: string | null;
}

const texto = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const lista = (v: unknown): Array<Record<string, unknown>> => (Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object') : []);
const objeto = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
/** "2026-10-02" → "02/10/2026". */
const dia = (iso: string): string => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

/** As fontes como a leitura dos resultados do caso as mostra; sem ela, a conta de anúncios e o caixa em dia, lidos hoje cedo. */
function fontesDoCaso(caso: CasoComLeituras): Fonte[] {
  const gravadas = lista(objeto(caso.leituras.resultados_ciclo_fechado).fontes)
    .map((f) => ({ plataforma: texto(f.plataforma), conta: texto(f.conta), dados: texto(f.dados) ?? 'metricas', frescor: texto(f.frescor) ?? EM_DIA, ultima_leitura: texto(f.ultima_leitura) }))
    .filter((f): f is Fonte => f.plataforma !== null && f.conta !== null);
  if (gravadas.length) return gravadas;
  return [
    { plataforma: 'Meta', conta: `CA ${caso.marca}`, dados: 'metricas', frescor: EM_DIA, ultima_leitura: `${dia(caso.hoje)} 06:12` },
    { plataforma: 'Regem', conta: 'Loja Centro', dados: 'pedidos', frescor: EM_DIA, ultima_leitura: `${dia(caso.hoje)} 06:20` },
  ];
}

/**
 * A visão neutra de uma leitura que o caso não gravou; `undefined` para a que não tem (ela falha, como antes).
 * Cada uma tem o formato da visão de produção (`leituras.visoes.ts`, `visoes/cupons.ts`, `visoes/links.ts`).
 */
export function leituraPadrao(caso: CasoComLeituras, nome: string): unknown {
  const fontes = fontesDoCaso(caso);
  switch (nome) {
    case 'fontes_frescor': {
      // Uma conta por fonte, com o conjunto de dados dela: o formato de `visaoDoFrescor`.
      const contas = new Map<string, { plataforma: string; conta: string; situacao: string; dados: Array<Record<string, unknown>> }>();
      for (const f of fontes) {
        const chave = `${f.plataforma}|${f.conta}`;
        const conta = contas.get(chave) ?? { plataforma: f.plataforma, conta: f.conta, situacao: 'ativa', dados: [] };
        conta.dados.push({ conjunto: f.dados, frescor: f.frescor, ultima_leitura: f.ultima_leitura, proxima_leitura: null });
        contas.set(chave, conta);
      }
      return { fuso: FUSO, contas: [...contas.values()] };
    }
    case 'atencao_avisos':
      // 06:25 em São Paulo, depois da leitura da manhã.
      return visaoDosAvisos([], `${caso.hoje}T09:25:00.000Z`, FUSO);
    case 'cupons_campanha': {
      // A leitura dos cupons segue a fonte do caixa (o Regem): parada lá, parada aqui.
      const caixa = fontes.find((f) => f.plataforma === 'Regem');
      return {
        lojas: [
          {
            loja: caixa?.conta ?? 'Loja Centro',
            plataforma_de_pedidos: 'regem',
            leitura_dos_cupons: caixa?.frescor ?? EM_DIA,
            ultima_leitura: caixa?.ultima_leitura ?? `${dia(caso.hoje)} 06:20`,
            liame_pode_criar_cupom_nesta_loja: true,
          },
        ],
        total_de_cupons: 0,
        cupons: [],
        pedidos_de_criacao: [],
        criar_cupom_pelo_liame: 'ligado',
      };
    }
    case 'links_rastreio': {
      // Um anúncio ativo por campanha dos resultados do caso, todos com rastreio: nada para arrumar.
      const anuncios = String(lista(objeto(caso.leituras.resultados_ciclo_fechado).campanhas).length);
      return {
        rastreio_dos_anuncios: { anuncios_ativos: anuncios, com_rastreio: anuncios, sem_rastreio: '0', nao_verificados: '0', fora_da_conferencia: '0' },
        anuncios_para_arrumar: [],
        total_de_links: 0,
        links: [],
      };
    }
    default:
      return undefined;
  }
}
