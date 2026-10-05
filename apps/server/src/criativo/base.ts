import { BrandDossierContent, DOSSIER_CONTENT_VERSION } from '@liame/contracts';
import { sql } from 'drizzle-orm';
import type { ProblemaDoPedido } from '../ai/criativo/contexto.js';
import { currentTx } from '../context/request-context.js';
import { concorrentesDoDossie, fatosDoDossie, proibidasDoDossie, textoDoDossie } from '../marca/dossie.js';
import { provasDoSistema } from '../marca/marca.service.js';

// O que o Criativo e a conferência de cada peça precisam da marca (A4, X6): o dossiê de uma versão (a atual, ou a do
// pedido), com as provas que o sistema calcula. Roda na transação de quem chama, sob a RLS da empresa: a rota (as
// opções e o pedido) e o worker (a geração) leem do mesmo jeito.

export interface MarcaDoCriativo {
  nome: string;
  /** A versão do dossiê que foi lida. */
  versao: number;
  conteudo: BrandDossierContent;
  /** O dossiê como o modelo lê, com as provas do sistema. */
  dossie: string;
  /** O que a marca afirma de si: de onde a conferência tira os números. */
  fatos: string;
  proibidas: string[];
  concorrentes: string[];
}

/**
 * O dossiê da marca para o Criativo: a versão pedida ou, sem ela, a atual. Nulo quando a marca não existe (ou foi
 * arquivada), não tem dossiê, não tem essa versão ou o conteúdo é de um formato mais novo que o código.
 */
export async function marcaDoCriativo(brandId: string, fuso: string, agora: Date, versao?: number): Promise<MarcaDoCriativo | null> {
  const tx = currentTx();
  const marca = (await tx.execute<{ name: string }>(sql`select name from liame.brand where id = ${brandId} and archived_at is null`)).rows[0];
  if (!marca) return null;
  const l = (
    await tx.execute<{ content: unknown; content_version: number; version: number }>(
      versao === undefined
        ? sql`select content, content_version, version from liame.brand_dossier_version where brand_id = ${brandId} order by version desc limit 1`
        : sql`select content, content_version, version from liame.brand_dossier_version where brand_id = ${brandId} and version = ${versao}`,
    )
  ).rows[0];
  if (!l || l.content_version > DOSSIER_CONTENT_VERSION) return null;
  const conteudo = BrandDossierContent.parse(l.content);
  const provas = await provasDoSistema(brandId, fuso, agora);
  return {
    nome: marca.name,
    versao: l.version,
    conteudo,
    dossie: textoDoDossie(marca.name, conteudo, provas),
    fatos: fatosDoDossie(marca.name, conteudo, provas),
    proibidas: proibidasDoDossie(conteudo),
    concorrentes: concorrentesDoDossie(conteudo),
  };
}

const entreAspas = (t: string) => `"${t}"`;

/** O que impede o pedido, em palavras para a tela: o que é, com o trecho, e o que fazer. */
export function mensagemDoProblema(p: ProblemaDoPedido): string {
  if (p.campo === 'variacoes') return `Peça ${p.trecho} peças por vez.`;
  if (p.campo === 'oferta') {
    switch (p.motivo) {
      case 'politico_eleitoral':
        return `A oferta tem conteúdo político ou eleitoral (${entreAspas(p.trecho)}): o Liame não faz anúncio disso.`;
      case 'categoria_proibida':
        return `A oferta é de uma categoria que as plataformas de anúncio proíbem ou restringem (${entreAspas(p.trecho)}).`;
      case 'bebida_alcoolica':
        return `A oferta cita bebida alcoólica (${entreAspas(p.trecho)}): o Criativo ainda não escreve esse anúncio, que pede aviso obrigatório.`;
      case 'dado_pessoal':
        return 'A oferta tem dado pessoal (telefone, e-mail ou documento): tire-o em Minha marca.';
      default:
        return `A oferta não pode ir ao Criativo como está (${entreAspas(p.trecho)}).`;
    }
  }
  switch (p.motivo) {
    case 'regra_da_marca':
      return `A instrução usa o que a marca não diz (${entreAspas(p.trecho)}). Tire esse trecho.`;
    case 'dado_pessoal':
      return 'A instrução tem dado pessoal (telefone, e-mail ou documento). Tire-o.';
    case 'bebida_alcoolica':
      return `A instrução cita bebida alcoólica (${entreAspas(p.trecho)}): o Criativo ainda não escreve esse anúncio.`;
    case 'concorrente':
      return `A instrução cita um concorrente (${entreAspas(p.trecho)}): anúncio não cita concorrente.`;
    case 'link':
      return 'A instrução tem endereço de site: o anúncio leva ao destino escolhido, sem link no texto.';
    case 'preco_fora_da_oferta':
      return `A instrução traz um valor que a oferta não tem (${entreAspas(p.trecho)}). O preço vem da oferta: para mudar, atualize a oferta em Minha marca.`;
    case 'instrucao_longa':
      return `A instrução passa do tamanho: ${p.trecho}.`;
    default:
      return `A instrução bate numa regra da Liame (${entreAspas(p.trecho)}). Tire esse trecho.`;
  }
}
