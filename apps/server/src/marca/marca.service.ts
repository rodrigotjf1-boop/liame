import {
  BrandDossierContent,
  type BrandDossierResponse,
  type BrandDossierSuggestion,
  type BrandDossierSuggestionItem,
  type BrandDossierSuggestionListResponse,
  type BrandDossierVersionListResponse,
  type BrandDossierVersionMeta,
  type BrandDossierVersionResponse,
  type BrandPhraseHit,
  type CheckBrandPhraseRequest,
  type CheckBrandPhraseResponse,
  DOSSIER_CONTENT_VERSION,
  DOSSIER_SECTIONS,
  type DossierSection,
  type DossierVersionSource,
  type RestoreBrandDossierRequest,
  type SaveBrandDossierRequest,
  type SystemProof,
  type UseBrandDossierSuggestionRequest,
} from '@liame/contracts';
import { uuidv7 } from '@liame/database';
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { type AuthContext, auditDetail, currentTx } from '../context/request-context.js';
import { AppProblem, ValidationProblem } from '../errors/problems.js';
import { conferirTexto, type RegraDeTexto } from '../policy/texto.js';
import { diaNoFuso, menosDias } from '../results/fora-do-normal.js';
import { ResultsService } from '../results/results.service.js';
import { arrumarDossie, camposComDadoPessoal, chave, DOSSIE_VAZIO, hashDoTexto, mudancas, proibidasDoDossie, provaDePedidos, ROTULO_DA_SECAO, situacaoDasSecoes, textoDoDossie } from './dossie.js';
import { aplicarItens, DIAS_DA_RECUSA, DIAS_DAS_VENDAS, recusados, SECOES_DO_SISTEMA, sugerirOfertas, sugerirProdutos } from './sugestoes.js';

// Minha marca (A3, I8): o dossiê da marca, as versões, o teste de frase e as sugestões do sistema. Tudo na
// transação da requisição, sob a RLS da empresa. Nenhuma versão é alterada nem apagada: salvar, voltar a uma
// anterior e usar uma sugestão criam a versão seguinte. Duas pessoas salvando a partir da mesma versão: a
// segunda recebe 409 e junta as mudanças na versão nova (protótipo P6).

const DIA_MS = 86_400_000;
const naoEncontrado = (detail: string) => new AppProblem(404, 'nao-encontrado', 'Não encontramos', detail);
const versaoMudou = (atual: number) =>
  new AppProblem(409, 'versao-mudou', 'Outra pessoa salvou antes', `O dossiê mudou depois que você abriu (agora está na versão ${atual}). Confira a versão nova e junte as suas mudanças.`);

/** As regras da Liame no teste de frase, como a tela de Minha marca mostra (protótipo P6). */
const REGRAS_DA_LIAME: Record<Exclude<RegraDeTexto, 'regra_da_marca'>, [string, string]> = {
  politico_eleitoral: ['Conteúdo político ou eleitoral', 'proibido em campanha, texto e conversa (Termos da Liame)'],
  promessa_de_resultado: ['Promessa de resultado', 'ninguém garante venda nem lucro (CDC e CONAR)'],
  categoria_proibida: ['Categoria que as plataformas proíbem', 'armas, cigarro e vape, apostas, drogas'],
  dado_pessoal: ['Dado pessoal de cliente', 'telefone, e-mail e documento não entram em texto feito por IA'],
  texto_longo: ['Texto longo demais', 'passa do tamanho que dá para conferir'],
};

type LinhaVersao = {
  id: string;
  version: number;
  source: DossierVersionSource;
  restored_from: number | null;
  content: unknown;
  content_version: number;
  changes: string[];
  created_at: Date | string;
  user_id: string | null;
  user_name: string | null;
};
type Versao = { id: string; meta: BrandDossierVersionMeta; content: BrandDossierContent };
type LinhaSugestao = { id: string; section: DossierSection; source: 'sistema' | 'lia' | 'pesquisador'; items: BrandDossierSuggestionItem[]; based_on_version: number; created_at: Date | string };

const COLUNAS_DA_VERSAO = sql`v.id, v.version, v.source, v.restored_from, v.content, v.content_version, v.changes, v.created_at, u.id as user_id, u.name as user_name`;

function versaoDaLinha(l: LinhaVersao): Versao {
  // O código lê a versão do contrato em que o dossiê foi salvo; versão mais nova que o código é erro de implantação.
  if (l.content_version > DOSSIER_CONTENT_VERSION) throw new Error(`dossiê ${l.id}: conteúdo na versão ${l.content_version}, o código lê até a ${DOSSIER_CONTENT_VERSION}`);
  return {
    id: l.id,
    meta: {
      version: l.version,
      source: l.source,
      restored_from: l.restored_from,
      created_by: l.user_id ? { id: l.user_id, name: l.user_name ?? '' } : null,
      created_at: new Date(l.created_at).toISOString(),
      changes: l.changes,
    },
    content: BrandDossierContent.parse(l.content),
  };
}

const sugestaoDaLinha = (l: LinhaSugestao): BrandDossierSuggestion => ({
  id: l.id,
  section: l.section,
  source: l.source,
  items: l.items,
  based_on_version: l.based_on_version,
  created_at: new Date(l.created_at).toISOString(),
});

/** O que a marca nunca diz, pela versão atual do dossiê. Roda na transação de quem chama (o Explicar, a revisão). */
export async function proibidasDaMarca(brandId: string): Promise<string[]> {
  const r = await currentTx().execute<{ itens: string[] | null }>(sql`
    select (select array_agg(e->>'text') from jsonb_array_elements(coalesce(v.content->'forbidden'->'items', '[]'::jsonb)) e) as itens
      from liame.brand_dossier_version v
     where v.brand_id = ${brandId}
     order by v.version desc limit 1`);
  return r.rows[0]?.itens ?? [];
}

/**
 * O dossiê como o modelo lê, pela versão atual (sem as provas do sistema, que pedem a leitura das vendas); nulo
 * sem dossiê. Roda na transação de quem chama (a Conversa, I10).
 */
export async function dossieParaOModelo(brandId: string, nomeDaMarca: string): Promise<string | null> {
  const r = await currentTx().execute<{ content: unknown; content_version: number }>(sql`
    select content, content_version from liame.brand_dossier_version where brand_id = ${brandId} order by version desc limit 1`);
  const l = r.rows[0];
  if (!l || l.content_version > DOSSIER_CONTENT_VERSION) return null;
  return textoDoDossie(nomeDaMarca, BrandDossierContent.parse(l.content), []);
}

@Injectable()
export class MarcaService {
  constructor(private readonly resultados: ResultsService) {}

  /** O dossiê atual, com as provas do sistema, a situação de cada parte e o texto que a IA lê. */
  async dossie(auth: Pick<AuthContext, 'permissions'>, brandId: string, agora = new Date()): Promise<BrandDossierResponse> {
    const marca = await this.marca(brandId);
    const atual = await this.versaoAtual(brandId);
    const conteudo = atual?.content ?? DOSSIE_VAZIO;
    const fuso = await this.resultados.fusoDaMarca(brandId);
    const provas = await this.provasDoSistema(brandId, fuso, agora);
    const comSugestao = await this.atualizarSugestoes(marca, atual, fuso, agora);
    const texto = textoDoDossie(marca.name, conteudo, provas);
    return {
      brand_id: brandId,
      brand_name: marca.name,
      version: atual?.meta ?? null,
      content: conteudo,
      system_proof: provas,
      sections: situacaoDasSecoes(conteudo, comSugestao),
      model_text: texto,
      model_text_hash: hashDoTexto(texto),
      can_edit: auth.permissions.has('dossie.editar'),
      generated_at: agora.toISOString(),
    };
  }

  /** Salvar o dossiê: nasce a versão seguinte, com o que mudou. Sem mudança, nada nasce. */
  async salvar(auth: AuthContext, body: SaveBrandDossierRequest, agora = new Date()): Promise<BrandDossierResponse> {
    const marca = await this.marca(body.brand_id);
    const conteudo = arrumarDossie(body.content);
    const pessoais = camposComDadoPessoal(conteudo);
    if (pessoais.length) throw new ValidationProblem(pessoais);
    const atual = await this.versaoAtual(body.brand_id);
    const numero = atual?.meta.version ?? 0;
    if (body.base_version !== numero) throw versaoMudou(numero);
    const mudou = mudancas(atual?.content ?? null, conteudo);
    if (mudou.length) {
      const id = await this.gravar(auth, marca, numero + 1, conteudo, mudou, body.merged ? 'mesclada' : 'pessoa', null);
      auditDetail({ resourceId: id, after: { brand_id: body.brand_id, version: numero + 1, changes: mudou } });
    } else {
      auditDetail({ ...(atual ? { resourceId: atual.id } : {}), after: { brand_id: body.brand_id, version: numero, changes: [] }, reason: 'nada mudou: nenhuma versão nova' });
    }
    return this.dossie(auth, body.brand_id, agora);
  }

  async versoes(brandId: string): Promise<BrandDossierVersionListResponse> {
    await this.marca(brandId);
    const r = await currentTx().execute<LinhaVersao>(sql`
      select ${COLUNAS_DA_VERSAO}
        from liame.brand_dossier_version v left join liame.app_user u on u.id = v.created_by
       where v.brand_id = ${brandId}
       order by v.version desc limit 200`);
    return { items: r.rows.map((l) => versaoDaLinha(l).meta) };
  }

  async versao(brandId: string, numero: number): Promise<BrandDossierVersionResponse> {
    await this.marca(brandId);
    const v = await this.lerVersao(brandId, numero);
    if (!v) throw naoEncontrado(`A versão ${numero} do dossiê não existe nesta marca.`);
    return { meta: v.meta, content: v.content };
  }

  /** Voltar a uma versão anterior: o conteúdo dela vira a versão seguinte (nada é apagado). */
  async voltar(auth: AuthContext, body: RestoreBrandDossierRequest, agora = new Date()): Promise<BrandDossierResponse> {
    const marca = await this.marca(body.brand_id);
    const atual = await this.versaoAtual(body.brand_id);
    if (!atual) throw naoEncontrado('O dossiê desta marca ainda não tem versão salva.');
    if (body.base_version !== atual.meta.version) throw versaoMudou(atual.meta.version);
    if (body.version === atual.meta.version) throw new AppProblem(422, 'ja-e-a-atual', 'Esta já é a versão atual', `A versão ${body.version} é a que está valendo.`);
    const alvo = await this.lerVersao(body.brand_id, body.version);
    if (!alvo) throw naoEncontrado(`A versão ${body.version} do dossiê não existe nesta marca.`);
    const mudou = mudancas(atual.content, alvo.content);
    const id = await this.gravar(auth, marca, atual.meta.version + 1, alvo.content, mudou, 'restaurada', body.version);
    auditDetail({ resourceId: id, after: { brand_id: body.brand_id, version: atual.meta.version + 1, restored_from: body.version, changes: mudou } });
    return this.dossie(auth, body.brand_id, agora);
  }

  /** Testar uma frase nas regras da Liame e nas da marca (a lista em edição, ou a da versão atual). Sem IA. */
  async conferirFrase(body: CheckBrandPhraseRequest): Promise<CheckBrandPhraseResponse> {
    await this.marca(body.brand_id);
    const salvas = (await this.versaoAtual(body.brand_id))?.content.forbidden.items ?? [];
    const lista = body.forbidden ?? proibidasDoDossie({ ...DOSSIE_VAZIO, forbidden: { items: salvas } });
    const motivo = new Map(salvas.map((i) => [chave(i.text), i.why || null]));
    const original = new Map(lista.map((f) => [chave(f), f]));
    const hits: BrandPhraseHit[] = conferirTexto(body.text, { daMarca: lista }).map((a) =>
      a.regra === 'regra_da_marca'
        ? { owner: 'marca' as const, rule: a.regra, text: original.get(a.trecho) ?? a.trecho, why: motivo.get(a.trecho) ?? null }
        : { owner: 'liame' as const, rule: a.regra, text: REGRAS_DA_LIAME[a.regra][0], why: REGRAS_DA_LIAME[a.regra][1] },
    );
    return { ok: hits.length === 0, hits };
  }

  /** As sugestões esperando conferência (as do sistema são refeitas agora, pelos números de hoje). */
  async sugestoes(brandId: string, agora = new Date()): Promise<BrandDossierSuggestionListResponse> {
    const marca = await this.marca(brandId);
    const atual = await this.versaoAtual(brandId);
    await this.atualizarSugestoes(marca, atual, await this.resultados.fusoDaMarca(brandId), agora);
    const r = await currentTx().execute<LinhaSugestao>(sql`
      select id, section, source, items, based_on_version, created_at
        from liame.brand_dossier_suggestion
       where brand_id = ${brandId} and status = 'pendente'
       order by source, created_at`);
    // Na ordem das partes da tela.
    const ordem = (s: DossierSection) => DOSSIER_SECTIONS.indexOf(s);
    return { items: r.rows.sort((a, b) => ordem(a.section) - ordem(b.section)).map(sugestaoDaLinha) };
  }

  /** Usar os itens marcados de uma sugestão: nasce a versão seguinte, e a sugestão fica como usada. */
  async usarSugestao(auth: AuthContext, id: string, body: UseBrandDossierSuggestionRequest, agora = new Date()): Promise<BrandDossierResponse> {
    const s = await this.sugestaoPendente(id);
    const marca = await this.marca(s.brand_id);
    const atual = await this.versaoAtual(s.brand_id);
    const numero = atual?.meta.version ?? 0;
    if (body.base_version !== numero) throw versaoMudou(numero);
    const posicoes = [...new Set(body.items)].sort((a, b) => a - b);
    if (posicoes.some((p) => p >= s.items.length)) throw new ValidationProblem([{ path: 'items', message: `A sugestão tem ${s.items.length} itens.` }]);
    const escolhidos = posicoes.map((p) => s.items[p]!);
    const antes = atual?.content ?? DOSSIE_VAZIO;
    // Os limites do contrato valem também para o que vem de sugestão: passar deles é 422, sem versão nova.
    const aplicado = BrandDossierContent.safeParse(aplicarNaSecao(antes, s.section, escolhidos));
    if (!aplicado.success) {
      throw new AppProblem(422, 'parte-cheia', 'A parte ficaria grande demais', `Com estes itens, "${ROTULO_DA_SECAO[s.section]}" passa do limite. Tire um item antes de usar a sugestão.`);
    }
    const depois = aplicado.data;
    const pessoais = camposComDadoPessoal(depois);
    if (pessoais.length) throw new ValidationProblem(pessoais);
    const mudou = mudancas(atual?.content ?? null, depois);
    let versaoGerada = numero;
    if (mudou.length) {
      versaoGerada = numero + 1;
      await this.gravar(auth, marca, versaoGerada, depois, mudou, 'sugestao', null);
    }
    await currentTx().execute(sql`
      update liame.brand_dossier_suggestion
         set status = 'usada', used = ${JSON.stringify(posicoes)}::jsonb, result_version = ${Math.max(versaoGerada, 1)},
             decided_by = ${auth.userId}, decided_at = ${agora}, updated_at = now()
       where id = ${id} and status = 'pendente'`);
    auditDetail({ resourceId: id, after: { brand_id: s.brand_id, section: s.section, used: posicoes, version: versaoGerada, changes: mudou } });
    return this.dossie(auth, s.brand_id, agora);
  }

  /** Descartar uma sugestão: os itens dela não voltam por um tempo. */
  async descartarSugestao(auth: AuthContext, id: string, agora = new Date()): Promise<void> {
    const s = await this.sugestaoPendente(id);
    await currentTx().execute(sql`
      update liame.brand_dossier_suggestion
         set status = 'descartada', decided_by = ${auth.userId}, decided_at = ${agora}, updated_at = now()
       where id = ${id} and status = 'pendente'`);
    auditDetail({ resourceId: id, after: { brand_id: s.brand_id, section: s.section, items: s.items.length } });
  }

  // ------------------------------------------------------------ leitura e gravação

  private async marca(brandId: string): Promise<{ id: string; name: string; tenantId: string }> {
    const r = await currentTx().execute<{ id: string; name: string; tenant_id: string }>(sql`
      select id, name, tenant_id from liame.brand where id = ${brandId} and archived_at is null`);
    const m = r.rows[0];
    if (!m) throw naoEncontrado('Marca não encontrada nesta empresa.');
    return { id: m.id, name: m.name, tenantId: m.tenant_id };
  }

  private async versaoAtual(brandId: string): Promise<Versao | null> {
    const r = await currentTx().execute<LinhaVersao>(sql`
      select ${COLUNAS_DA_VERSAO}
        from liame.brand_dossier_version v left join liame.app_user u on u.id = v.created_by
       where v.brand_id = ${brandId}
       order by v.version desc limit 1`);
    return r.rows[0] ? versaoDaLinha(r.rows[0]) : null;
  }

  private async lerVersao(brandId: string, numero: number): Promise<Versao | null> {
    const r = await currentTx().execute<LinhaVersao>(sql`
      select ${COLUNAS_DA_VERSAO}
        from liame.brand_dossier_version v left join liame.app_user u on u.id = v.created_by
       where v.brand_id = ${brandId} and v.version = ${numero}`);
    return r.rows[0] ? versaoDaLinha(r.rows[0]) : null;
  }

  /** Grava a versão; se outra pessoa gravou o mesmo número antes, 409 (a unicidade decide, sem trava). */
  private async gravar(
    auth: Pick<AuthContext, 'userId'>,
    marca: { id: string; name: string; tenantId: string },
    numero: number,
    conteudo: BrandDossierContent,
    mudou: string[],
    origem: DossierVersionSource,
    voltouPara: number | null,
  ): Promise<string> {
    const id = uuidv7();
    const texto = textoDoDossie(marca.name, conteudo, []);
    const r = await currentTx().execute<{ id: string }>(sql`
      insert into liame.brand_dossier_version (id, tenant_id, brand_id, version, content, content_version, text_hash, changes, source, restored_from, created_by)
      values (${id}, ${marca.tenantId}, ${marca.id}, ${numero}, ${JSON.stringify(conteudo)}::jsonb, ${DOSSIER_CONTENT_VERSION}, ${hashDoTexto(texto)},
              ${JSON.stringify(mudou)}::jsonb, ${origem}, ${voltouPara}, ${auth.userId})
      on conflict (brand_id, version) do nothing
      returning id`);
    if (!r.rows[0]) throw versaoMudou(numero);
    return id;
  }

  private async sugestaoPendente(id: string): Promise<LinhaSugestao & { brand_id: string }> {
    const r = await currentTx().execute<LinhaSugestao & { brand_id: string; status: string }>(sql`
      select id, brand_id, section, source, items, based_on_version, created_at, status
        from liame.brand_dossier_suggestion where id = ${id}
         for update`);
    const s = r.rows[0];
    if (!s) throw naoEncontrado('Sugestão não encontrada nesta empresa.');
    if (s.status !== 'pendente') throw new AppProblem(409, 'sugestao-decidida', 'Esta sugestão já foi decidida', 'Alguém já usou, descartou ou o sistema trocou esta sugestão. Atualize a tela.');
    return s;
  }

  /** As provas que o sistema calcula: os pedidos dos últimos 7 dias completos, no fuso da marca. */
  private async provasDoSistema(brandId: string, fuso: string, agora: Date): Promise<SystemProof[]> {
    const hoje = diaNoFuso(agora, fuso);
    const de = menosDias(hoje, 7);
    const r = await currentTx().execute<{ n: number }>(sql`
      select count(*)::int as n from liame.order_fact o
       where o.brand_id = ${brandId} and o.status = 'confirmado'
         and o.confirmed_at >= (${de}::date)::timestamp at time zone ${fuso}
         and o.confirmed_at < (${hoje}::date)::timestamp at time zone ${fuso}`);
    const prova = provaDePedidos(r.rows[0]?.n ?? 0, de, menosDias(hoje, 1));
    return prova ? [prova] : [];
  }

  /**
   * Refaz as sugestões do sistema pelos números de agora: a pendente que mudou é trocada; a que não faz mais
   * sentido sai. Devolve as partes com alguma sugestão esperando conferência (de qualquer autor).
   */
  private async atualizarSugestoes(marca: { id: string; tenantId: string }, atual: Versao | null, fuso: string, agora: Date): Promise<Set<DossierSection>> {
    const tx = currentTx();
    const conteudo = atual?.content ?? DOSSIE_VAZIO;
    const base = atual?.meta.version ?? 0;
    const decididas = await tx.execute<{ section: DossierSection; status: string; items: BrandDossierSuggestionItem[]; used: number[] | null }>(sql`
      select section, status, items, used from liame.brand_dossier_suggestion
       where brand_id = ${marca.id} and source = 'sistema' and status in ('usada', 'descartada')
         and decided_at > ${new Date(agora.getTime() - DIAS_DA_RECUSA * DIA_MS)}`);
    const recusa = (s: DossierSection) => recusados(decididas.rows.filter((d) => d.section === s));

    const hoje = diaNoFuso(agora, fuso);
    const de = menosDias(hoje, DIAS_DAS_VENDAS);
    const janela = sql`o.brand_id = ${marca.id} and o.status = 'confirmado'
      and o.confirmed_at >= (${de}::date)::timestamp at time zone ${fuso} and o.confirmed_at < (${hoje}::date)::timestamp at time zone ${fuso}`;
    const vendidos = await tx.execute<{ nome: string; pedidos: number }>(sql`
      select i.name as nome, count(distinct o.id)::int as pedidos
        from liame.order_item_fact i join liame.order_fact o on o.id = i.order_id
       where ${janela} and i.removed_at is null
       group by i.name order by pedidos desc, i.name limit 500`);
    const pedidos = (await tx.execute<{ n: number }>(sql`select count(*)::int as n from liame.order_fact o where ${janela}`)).rows[0]?.n ?? 0;
    const cupons = await tx.execute<{ codigo: string; campanha: string; ate: string | null }>(sql`
      select k.code as codigo, c.name as campanha, to_char(least(cc.unlinked_at, k.valid_until) at time zone ${fuso}, 'DD/MM') as ate
        from liame.campaign_coupon cc
        join liame.coupon k on k.id = cc.coupon_id
        join liame.campaign c on c.id = cc.campaign_id
       where cc.brand_id = ${marca.id} and cc.exclusive and cc.linked_at <= ${agora} and (cc.unlinked_at is null or cc.unlinked_at > ${agora})
         and k.active and (k.valid_until is null or k.valid_until > ${agora}) and c.status = 'ativa'
       order by c.name, k.code limit 20`);

    const novas: Record<(typeof SECOES_DO_SISTEMA)[number], BrandDossierSuggestionItem[]> = {
      produtos: sugerirProdutos(conteudo, vendidos.rows, pedidos, recusa('produtos')),
      ofertas: sugerirOfertas(conteudo, cupons.rows, recusa('ofertas')),
    };
    for (const secao of SECOES_DO_SISTEMA) {
      const itens = novas[secao];
      const pendente = (
        await tx.execute<{ id: string; items: BrandDossierSuggestionItem[] }>(sql`
          select id, items from liame.brand_dossier_suggestion
           where brand_id = ${marca.id} and section = ${secao} and source = 'sistema' and status = 'pendente'
           for update`)
      ).rows[0];
      // Compara campo a campo: o jsonb devolve as chaves de cada item em outra ordem (comparar o JSON em texto
      // trocava a sugestão a cada leitura).
      if (pendente && mesmosItens(pendente.items, itens)) continue;
      if (pendente) await tx.execute(sql`update liame.brand_dossier_suggestion set status = 'substituida', updated_at = now() where id = ${pendente.id}`);
      if (!itens.length) continue;
      await tx.execute(sql`
        insert into liame.brand_dossier_suggestion (id, tenant_id, brand_id, section, source, items, based_on_version, status)
        values (${uuidv7()}, ${marca.tenantId}, ${marca.id}, ${secao}, 'sistema', ${JSON.stringify(itens)}::jsonb, ${base}, 'pendente')
        on conflict (brand_id, section, source) where status = 'pendente' do nothing`);
    }
    const r = await tx.execute<{ section: DossierSection }>(sql`
      select distinct section from liame.brand_dossier_suggestion where brand_id = ${marca.id} and status = 'pendente'`);
    return new Set(r.rows.map((l) => l.section));
  }
}

/** As mesmas sugestões, na mesma ordem (o que a pessoa vê e as posições que ela marca). */
function mesmosItens(a: BrandDossierSuggestionItem[], b: BrandDossierSuggestionItem[]): boolean {
  return a.length === b.length && a.every((x, i) => x.op === b[i]!.op && x.text === b[i]!.text && (x.before ?? null) === (b[i]!.before ?? null) && x.why === b[i]!.why);
}

/** Aplica os itens escolhidos de uma sugestão na parte certa do dossiê. */
function aplicarNaSecao(c: BrandDossierContent, secao: DossierSection, itens: BrandDossierSuggestionItem[]): BrandDossierContent {
  switch (secao) {
    case 'produtos':
      return { ...c, products: { items: aplicarItens(c.products.items, itens) } };
    case 'ofertas':
      return { ...c, offers: { items: aplicarItens(c.offers.items, itens) } };
    case 'datas':
      return { ...c, seasonality: { items: aplicarItens(c.seasonality.items, itens) } };
    case 'voz':
      return { ...c, voice: { ...c.voice, rules: aplicarItens(c.voice.rules, itens) } };
    default:
      // As outras partes ainda não recebem sugestão (a LIA e o Pesquisador chegam com a IA).
      throw new AppProblem(422, 'sugestao-sem-aplicacao', 'Esta sugestão não se aplica', `A parte "${secao}" ainda não recebe sugestão.`);
  }
}
