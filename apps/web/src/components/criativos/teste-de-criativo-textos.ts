import { CREATIVE_TEST_DAYS, CREATIVE_TEST_MIN_DAILY_BUDGET_MICROS, type CreateCreativeTestRequest, type CreativeTestDiscount, type CreativeTestOptionsResponse, creativeTestCouponLine } from '@liame/contracts';
import { reaisDeMicros } from '@/lib/formato';

/** Reais com os centavos ("R$ 40,00"), sem ponto flutuante. */
export const reaisComCentavos = (micros: number): string => reaisDeMicros(BigInt(Math.round(micros)));
const moeda = reaisComCentavos;

// A gaveta "Testar contra outra peça" (R8; D-RG-96, protótipo `prototipo-campanha-nova.html`, "Telas do teste"): as regras
// puras. O que impede o pedido é o mesmo que a rota recusa (o contrato e `oQueImpedeOTeste`), e a rota confere de novo.

export type CamposDoTeste = {
  pecaB: string | null;
  midiaA: string | null;
  midiaB: string | null;
  cupomA: string;
  cupomB: string;
  tipo: 'percentual' | 'valor';
  /** O desconto como a pessoa digita: "10" (%) ou "5,00" (R$). */
  valor: string;
  /** O pedido mínimo em reais, opcional. */
  minimo: string;
  nome: string;
  loja: string | null;
  quem: 'raio' | 'bairros';
  raio: number;
  bairros: string[];
  /** A verba diária do teste inteiro, em reais. */
  verba: string;
};

export type CampoDoTeste = 'nome' | 'midiaA' | 'pecaB' | 'midiaB' | 'cupomA' | 'cupomB' | 'valor' | 'minimo' | 'loja' | 'bairros' | 'verba';

/** O código do cupom: de 4 a 20 letras maiúsculas ou números (o contrato). */
const CUPOM = /^[A-Z0-9]{4,20}$/;

/** Os dias que os cupons valem a partir do pedido (o servidor conta do dia do pedido, no fuso da loja). */
export const VALIDADE_DOS_CUPONS_DIAS = 45;

/** Reais digitados ("1.234,56", "40" ou "40,5") em centavos; `NaN` quando não é um valor. */
export function centavosDe(txt: string): number {
  const t = txt.trim().replace(/\./g, '').replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return Number.NaN;
  return Math.round(Number(t) * 100);
}

/** O código como vai ao Regem: sem espaço e em maiúsculas. */
export const codigoDoCupom = (txt: string): string => txt.replace(/\s+/g, '').toUpperCase();

/** O desconto dos dois cupons, como o pedido manda; nulo enquanto o que foi digitado não é um desconto. */
export function descontoDoTeste(c: CamposDoTeste): CreativeTestDiscount | null {
  const minimo = c.minimo.trim() ? centavosDe(c.minimo) : 0;
  if (!Number.isFinite(minimo) || minimo < 0) return null;
  if (c.tipo === 'percentual') {
    const p = Number(c.valor.trim());
    return Number.isInteger(p) && p >= 1 && p <= 100 ? { kind: 'percentual', percent: p, min_order_cents: minimo } : null;
  }
  const v = centavosDe(c.valor);
  return Number.isFinite(v) && v >= 1 ? { kind: 'valor', value_cents: v, min_order_cents: minimo } : null;
}

/** A linha do cupom como sai no fim do texto do anúncio (a fórmula do servidor); "…" no que ainda falta. */
export function linhaDoCupomNaPrevia(codigo: string, c: CamposDoTeste): string {
  const d = descontoDoTeste(c);
  const cod = codigoDoCupom(codigo) || '…';
  return d ? creativeTestCouponLine(cod, d) : `Cupom ${cod}: ….`;
}

/** O que impede o pedido, no primeiro campo que não passa; nulo quando pode pedir. */
export function conferirTeste(c: CamposDoTeste, o: { pecaA: string; tetoMicros: number | null; variasLojas: boolean }): { campo: CampoDoTeste; erro: string } | null {
  if (!c.nome.trim()) return { campo: 'nome', erro: 'Dê um nome ao teste.' };
  if (!c.midiaA) return { campo: 'midiaA', erro: 'Escolha a foto ou o vídeo do criativo A.' };
  if (!c.pecaB) return { campo: 'pecaB', erro: 'Escolha a outra peça aprovada.' };
  if (!c.midiaB) return { campo: 'midiaB', erro: 'Escolha a foto ou o vídeo do criativo B.' };
  for (const [letra, campo, valor] of [
    ['A', 'cupomA', c.cupomA],
    ['B', 'cupomB', c.cupomB],
  ] as const) {
    if (!CUPOM.test(codigoDoCupom(valor))) return { campo, erro: `O cupom do criativo ${letra} tem de 4 a 20 letras maiúsculas ou números, sem espaço.` };
  }
  if (codigoDoCupom(c.cupomA) === codigoDoCupom(c.cupomB)) return { campo: 'cupomB', erro: 'Cada criativo tem o seu cupom: os dois códigos não podem ser iguais.' };
  if (c.pecaB === o.pecaA && c.midiaB === c.midiaA) return { campo: 'pecaB', erro: 'Os dois criativos são iguais: escolha outra peça ou outra foto para o segundo.' };
  if (c.minimo.trim() && !Number.isFinite(centavosDe(c.minimo))) return { campo: 'minimo', erro: 'Digite o pedido mínimo em reais, como 30,00, ou deixe vazio.' };
  if (!descontoDoTeste(c)) {
    return { campo: 'valor', erro: c.tipo === 'percentual' ? 'Digite o desconto dos dois cupons: um número inteiro de 1 a 100.' : 'Digite o desconto dos dois cupons em reais, como 5,00.' };
  }
  if (!c.loja && o.variasLojas) return { campo: 'loja', erro: 'Escolha a loja.' };
  if (c.quem === 'bairros' && !c.bairros.length) return { campo: 'bairros', erro: 'Marque pelo menos um bairro, ou volte ao raio.' };
  const verba = centavosDe(c.verba);
  const minimoDoTeste = CREATIVE_TEST_MIN_DAILY_BUDGET_MICROS / 10_000;
  if (!Number.isFinite(verba) || verba < minimoDoTeste) return { campo: 'verba', erro: `A verba do teste é de no mínimo ${moeda(CREATIVE_TEST_MIN_DAILY_BUDGET_MICROS)} por dia: ${moeda(CREATIVE_TEST_MIN_DAILY_BUDGET_MICROS / 2)} para cada criativo.` };
  if (verba % 2 !== 0) return { campo: 'verba', erro: 'A metade da verba precisa fechar em centavos: use um valor par de centavos.' };
  if (o.tetoMicros !== null && verba * 10_000 > o.tetoMicros) {
    return { campo: 'verba', erro: `A verba do teste passa do teto por campanha, que é de ${moeda(o.tetoMicros)} por dia. Quem muda o teto é o Dono ou o Administrador, em Verba do mês.` };
  }
  return null;
}

/** O corpo do pedido, depois de `conferirTeste` sem problema. */
export function corpoDoTeste(c: CamposDoTeste, o: { brandId: string; pecaA: string; loja: string }): CreateCreativeTestRequest {
  return {
    brand_id: o.brandId,
    unit_id: o.loja,
    name: c.nome.trim(),
    arms: [
      { piece_id: o.pecaA, media_id: c.midiaA!, coupon_code: codigoDoCupom(c.cupomA) },
      { piece_id: c.pecaB!, media_id: c.midiaB!, coupon_code: codigoDoCupom(c.cupomB) },
    ],
    discount: descontoDoTeste(c)!,
    ...(c.quem === 'bairros' ? { districts: c.bairros } : { radius_km: c.raio }),
    daily_budget_micros: centavosDe(c.verba) * 10_000,
  };
}

/** Quanto o teste custa, para a linha embaixo da verba. */
export function efeitoDoTeste(verbaTxt: string): string {
  const v = centavosDe(verbaTxt);
  if (!Number.isFinite(v) || v * 10_000 < CREATIVE_TEST_MIN_DAILY_BUDGET_MICROS) return 'Digite a verba do teste inteiro para ver quanto ele custa.';
  const micros = v * 10_000;
  return `O teste custa ${moeda(micros)} por dia (${moeda(micros / 2)} para cada criativo), até ${moeda(micros * CREATIVE_TEST_DAYS.max)} se for até o fim (${CREATIVE_TEST_DAYS.max} dias). Enquanto estiver pausado, não gasta.`;
}

/** "29/12": até quando os cupons valem, contando do pedido de hoje (`AAAA-MM-DD`). */
export function validadeDosCupons(hoje: string): string {
  const d = new Date(`${hoje}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + VALIDADE_DOS_CUPONS_DIAS);
  return `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** A recusa da rota no campo certo: pelo caminho do erro (`arms.1.coupon_code`) ou pelo código; sem campo, vai no topo. */
export function erroDoPedidoDoTeste(p: { code: string; title: string; detail?: string; errors?: { path: string; message: string }[] }): { campo: CampoDoTeste | null; texto: string } {
  const primeiro = p.errors?.[0];
  const texto = p.detail ?? primeiro?.message ?? p.title ?? 'Não foi possível pedir o teste agora.';
  const caminho = primeiro?.path ?? '';
  const braco = /^arms\.(\d)\.(coupon_code|media_id|piece_id)$/.exec(caminho);
  if (braco) {
    const letra = braco[1] === '0' ? 'A' : 'B';
    const campo: CampoDoTeste = braco[2] === 'coupon_code' ? `cupom${letra}` : braco[2] === 'media_id' ? `midia${letra}` : 'pecaB';
    return { campo, texto };
  }
  const porCaminho: Record<string, CampoDoTeste> = { daily_budget_micros: 'verba', districts: 'bairros', unit_id: 'loja', name: 'nome' };
  if (porCaminho[caminho]) return { campo: porCaminho[caminho], texto };
  if (caminho.startsWith('discount')) return { campo: caminho.includes('min_order') ? 'minimo' : 'valor', texto };
  const porCodigo: Record<string, CampoDoTeste> = {
    'verba-invalida': 'verba',
    'acima-do-teto': 'verba',
    'peca-nao-aprovada': 'pecaB',
    'midia-fora-das-fotos': 'midiaA',
    'loja-nao-encontrada': 'loja',
    'loja-sem-endereco': 'loja',
    'bairro-sem-centro': 'bairros',
    'bairro-fora-da-cidade': 'bairros',
  };
  return { campo: porCodigo[p.code] ?? null, texto };
}

/** Por que não dá para pedir agora (antes de a pessoa preencher), na ordem da rota; nulo quando dá. */
export function oQueImpedeAGaveta(opcoes: CreativeTestOptionsResponse, loja: { id: string; name: string } | null): { titulo: string; texto: string; contas: boolean } | null {
  if (opcoes.live) {
    return {
      titulo: 'A marca já tem um teste pedido ou rodando',
      texto: `“${opcoes.live.name}” ainda não acabou. O Liame faz um teste por vez: espere esse acabar, ou encerre-o em Aprovações.`,
      contas: false,
    };
  }
  if (!loja) return null;
  const cupons = opcoes.units.find((u) => u.unit_id === loja.id)?.coupons ?? 'sem_regem';
  if (cupons === 'sem_regem') return { titulo: `A ${loja.name} não está ligada ao Regem`, texto: `Cada criativo do teste tem o seu cupom, e o Liame cria os dois no Regem depois da aprovação. Ligue o Regem da ${loja.name} em Contas conectadas.`, contas: true };
  if (cupons === 'sem_permissao') {
    return {
      titulo: `A ${loja.name} ainda não liberou criar cupom`,
      texto: `Cada criativo do teste tem o seu cupom, e o Liame cria os dois no Regem depois da aprovação. Para isso, a conexão da ${loja.name} com o Regem precisa da permissão “Criar cupons”, em Contas conectadas.`,
      contas: true,
    };
  }
  if (cupons === 'escrita_desligada') return { titulo: 'Criar cupom no Regem não está ligado', texto: 'Sem os dois cupons, o teste não tem como dizer de onde veio o pedido. Fale com o suporte da Liame para ligar.', contas: false };
  return null;
}
