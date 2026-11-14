import type { CreateCreativeTestRequest, CreativeTestListQuery, CreativeTestListResponse, CreativeTestResponse } from '@liame/contracts';
import { uuidv7 } from '@liame/database';
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { ActionService } from '../actions/action.service.js';
import { baseDoPedido } from '../ai/criativo/contexto.js';
import { conferirPeca } from '../ai/criativo/peca.js';
import { contaConectada } from '../connections/conectada.js';
import { emMenorUnidade } from '../connectors/meta/verba.js';
import { type AuthContext, auditDetail, currentTx } from '../context/request-context.js';
import { marcaDoCriativo, mensagemDoAchado } from '../criativo/base.js';
import { AppProblem } from '../errors/problems.js';
import { FlagService } from '../flags/flag.service.js';
import { PolicyService } from '../policy/policy.service.js';
import { tetoDaVerba } from '../policy/teto-da-verba.js';
import { destinoDoPost } from '../posts/link-do-post.js';
import { type BairroDaCampanha, lugaresDoRaio, lugaresDosBairros } from './bairros-da-campanha.js';
import { bloqueioDasContas, CampanhasNovasService, conflito, contasDaMarca, motivoSemCardapio, recusa, textoDoPublicoPequeno, textoDoPublicoPequenoNosBairros } from './campanhas-novas.service.js';
import { publicoSuficiente } from './publico-no-raio.js';
import { DIAS_DO_TESTE_DE_CRIATIVO, type LetraDoTeste } from './teste-contas.js';
import {
  type DescontoDoTeste,
  type EstadoDoTesteDeCriativo,
  FLAG_DO_TESTE_DE_CRIATIVO,
  LIMITE_DO_TEXTO_DO_ANUNCIO,
  oQueImpedeOTeste,
  recursoDoTesteDeCriativo,
  ResultadoDoTesteDeCriativo,
  textoDoAnuncioDoTeste,
  VALIDADE_DOS_CUPONS_DO_TESTE_DIAS,
} from './teste-de-criativo-plano.js';

// O teste de criativo (plano da região, R8; protótipo dos testes aprovado pelo dono em 13/11/2026; D-RG-76 a D-RG-80).
// A rota confere tudo o que a ferramenta `teste_de_criativo_criar` exige antes de pedir: as duas peças aprovadas, cada
// uma com a mídia pronta de Fotos; a conta de anúncios e a Página da marca; a loja com o ponto no endereço e o cardápio
// dela; a verba do teste inteiro (a metade exata para cada criativo, dentro do teto por campanha); os dois cupons (a loja
// liberou criar cupom no Regem, e os códigos estão livres); e o texto de cada anúncio com a linha do cupom, que passa de
// novo pelas regras de texto e precisa caber sem corte. O pedido nasce em Aprovações, esperando o código do app; nada vai
// à Meta nem ao Regem antes disso.

/** As situações do pedido que encerram sem criar: recusado (cancelado), expirado ou que falhou. */
const ENCERRADOS = sql`('cancelada', 'expirada', 'falhou')`;
/** As situações do pedido ainda em aberto: esperando a decisão, aprovado esperando a vez, ou executando. */
const EM_ABERTO = sql`('aguardando_aprovacao', 'aprovada', 'executando')`;

const LETRAS: readonly LetraDoTeste[] = ['A', 'B'];

function hojeNoFuso(agora: Date, fuso: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: fuso, year: 'numeric', month: '2-digit', day: '2-digit' }).format(agora);
}

/** O dia `dias` depois de `dia` (`AAAA-MM-DD`). */
function diaMais(dia: string, dias: number): string {
  const d = new Date(`${dia}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

/** O resultado guardado pela rotina, como a resposta o mostra; nulo antes da primeira olhada. */
function resultadoDaResposta(guardado: unknown): CreativeTestResponse['result'] {
  const r = ResultadoDoTesteDeCriativo.safeParse(guardado);
  if (!r.success) return null;
  const numeros = (letter: LetraDoTeste) => {
    const n = r.data.criativos[letter];
    return { letter, orders: n.pedidos, revenue_micros: Math.round(n.receita_micros), spend_micros: n.gasto_micros === null ? null : Math.round(n.gasto_micros), link_clicks: n.visitas };
  };
  return {
    looks: r.data.olhadas.map((o) => ({ day: o.dia, orders_a: o.a, orders_b: o.b, chance: o.acaso })),
    verdict: r.data.veredito,
    winner: r.data.vencedor,
    arms: [numeros('A'), numeros('B')],
  };
}

type Linha = {
  id: string;
  brand_id: string;
  unit_id: string;
  name: string;
  status: CreativeTestResponse['status'];
  active: boolean;
  daily_budget_micros: string;
  min_days: number;
  max_days: number;
  plan: unknown;
  action_id: string | null;
  pending_action_id: string | null;
  meta_campaign_id: string | null;
  meta_account_id: string | null;
  started_on: string | null;
  ended_on: string | null;
  error: string | null;
  reason: string | null;
  result: unknown;
  created_at: Date;
};

type LinhaDoBraco = {
  letter: LetraDoTeste;
  piece_id: string;
  piece_version: number;
  media_id: string;
  coupon_code: string;
  coupon_status: CreativeTestResponse['arms'][number]['coupon_status'];
  meta_adset_id: string | null;
  meta_ad_id: string | null;
};

@Injectable()
export class TestesDeCriativoService {
  constructor(
    private readonly actions: ActionService,
    private readonly flags: FlagService,
    private readonly policies: PolicyService,
    private readonly campanhas: CampanhasNovasService,
  ) {}

  private quem(auth: AuthContext): { tenantId: string; userId: string } {
    if (!auth.tenantId) throw new AppProblem(403, 'sem-empresa', 'Sem empresa na sessão', 'Escolha uma empresa antes de continuar.');
    return { tenantId: auth.tenantId, userId: auth.userId };
  }

  private async exigirAFuncao(quem: { tenantId: string; userId: string }, brandId: string): Promise<void> {
    const ligada = await this.flags.isEnabled(FLAG_DO_TESTE_DE_CRIATIVO, this.flags.context({ tenantId: quem.tenantId, userId: quem.userId, brandId }));
    if (!ligada) throw conflito('funcao-desligada', 'Função desligada', 'O teste de criativo não está ligado para esta empresa.');
  }

  /** Pedir o teste: confere tudo, grava o teste e os dois criativos, e pede `teste_de_criativo_criar` em Aprovações. */
  async criar(auth: AuthContext, body: CreateCreativeTestRequest, agora: Date = new Date()): Promise<CreativeTestResponse> {
    const tx = currentTx();
    const quem = this.quem(auth);
    const marca = await tx.execute(sql`select 1 from liame.brand where id = ${body.brand_id} and tenant_id = ${quem.tenantId} and archived_at is null`);
    if (!marca.rows[0]) throw new AppProblem(404, 'nao-encontrado', 'Não encontramos', 'Marca não encontrada nesta empresa.');
    await this.exigirAFuncao(quem, body.brand_id);

    // As duas peças aprovadas (na versão atual), cada uma com a foto ou o vídeo pronto de Fotos.
    const criativos: Array<{ letra: LetraDoTeste; pieceId: string; versao: number; titulo: string; texto: string; botao: 'pedir_agora' | 'ver_cardapio'; oferta: string; instrucao: string | null; mediaId: string; tipo: 'foto' | 'video'; arquivo: string; cupom: string }> = [];
    for (const [i, braco] of body.arms.entries()) {
      const letra = LETRAS[i]!;
      const caminho = `arms.${i}`;
      const peca = (
        await tx.execute<{ status: string; version: number; title: string | null; body: string | null; button: string | null; offer: string; instruction: string | null }>(sql`
          select p.status, p.version, v.title, v.body, v.button, q.offer, q.instruction
            from liame.ad_piece p
            join liame.ad_piece_request q on q.id = p.request_id
            left join liame.ad_piece_version v on v.piece_id = p.id and v.version = p.version and v.tenant_id = p.tenant_id
           where p.id = ${braco.piece_id} and p.tenant_id = ${quem.tenantId} and p.brand_id = ${body.brand_id}`)
      ).rows[0];
      if (!peca || peca.title === null || peca.body === null) throw recusa('peca-nao-encontrada', 'Peça não encontrada', `A peça do criativo ${letra} não está em Criativos desta marca.`, `${caminho}.piece_id`);
      if (peca.status !== 'aprovada') throw recusa('peca-nao-aprovada', 'A peça não foi aprovada', `Só a peça aprovada em Criativos entra no teste. Aprove a peça do criativo ${letra} antes.`, `${caminho}.piece_id`);
      if (peca.button !== 'pedir_agora' && peca.button !== 'ver_cardapio') {
        throw recusa('peca-de-outro-destino', 'A peça não leva ao cardápio', `O teste é de pedidos pelo cardápio, e a peça do criativo ${letra} leva a uma conversa. Escolha uma peça com o botão do cardápio.`, `${caminho}.piece_id`);
      }
      const midia = (
        await tx.execute<{ kind: string; has_cover: boolean | null; arquivo: string }>(sql`
          select kind, has_cover, coalesce(sha256, object_key) as arquivo from liame.brand_photo
           where id = ${braco.media_id} and tenant_id = ${quem.tenantId} and brand_id = ${body.brand_id} and status = 'pronta' and removed_at is null`)
      ).rows[0];
      if (!midia) throw recusa('midia-fora-das-fotos', 'Mídia não encontrada', `Escolha uma foto ou um vídeo pronto de Fotos desta marca para o criativo ${letra}.`, `${caminho}.media_id`);
      if (midia.kind === 'video' && !midia.has_cover) {
        throw recusa('video-sem-capa', 'O vídeo não tem capa', `O anúncio de vídeo leva a capa: escolha a capa do vídeo do criativo ${letra} em Fotos, ou use outro vídeo.`, `${caminho}.media_id`);
      }
      criativos.push({
        letra,
        pieceId: braco.piece_id,
        versao: peca.version,
        titulo: peca.title,
        texto: peca.body,
        botao: peca.button,
        oferta: peca.offer,
        instrucao: peca.instruction,
        mediaId: braco.media_id,
        tipo: midia.kind === 'video' ? 'video' : 'foto',
        arquivo: midia.arquivo,
        cupom: braco.coupon_code,
      });
    }

    // A conta de anúncios da Meta e a Página da marca (D-A4-35): uma de cada.
    const { anuncios, paginas } = await contasDaMarca(tx, quem.tenantId, body.brand_id);
    const bloqueio = bloqueioDasContas(anuncios, paginas);
    if (bloqueio) throw bloqueio;
    const contaDeAnuncios = anuncios[0]!;
    const pagina = paginas[0]!;
    if (emMenorUnidade(body.daily_budget_micros / 2, contaDeAnuncios.currency) === null || !Number.isInteger(body.daily_budget_micros / 2)) {
      throw recusa('verba-invalida', 'Verba inválida', 'A verba do teste é dividida ao meio entre os dois criativos: escolha um valor que dê a metade exata em centavos.', 'daily_budget_micros');
    }

    // A loja e o ponto dela no endereço, e o cardápio dela (o teste é de pedidos pelo cardápio).
    const loja = (
      await tx.execute<{ name: string; location_precision: string | null; latitude: string | null; longitude: string | null; ibge_city_code: string | null }>(sql`
        select name, location_precision, latitude::text, longitude::text, ibge_city_code from liame.unit
         where id = ${body.unit_id} and tenant_id = ${quem.tenantId} and brand_id = ${body.brand_id}`)
    ).rows[0];
    if (!loja) throw recusa('loja-nao-encontrada', 'Loja não encontrada', 'A loja não é desta marca.', 'unit_id');
    if (loja.location_precision !== 'endereco' || loja.latitude === null || loja.longitude === null) {
      throw recusa('loja-sem-endereco', 'Falta o endereço da loja', 'O teste mostra os anúncios em volta da loja, e o ponto dela ainda não está no endereço. Ajuste o endereço da loja em Minha marca antes.', 'unit_id');
    }
    const destino = await destinoDoPost(tx, quem.tenantId, body.brand_id);
    const semCardapio = motivoSemCardapio(destino, body.unit_id);
    if (semCardapio || !destino.ok) throw recusa('sem-cardapio', 'Sem o cardápio da loja', semCardapio ?? 'A loja não tem o cardápio online ligado ao Liame.', 'unit_id');
    const link = destino.url;

    // A verba do teste INTEIRO dentro do teto por campanha, quando ele existe: criar não gasta, mas ativar vai pedir o teto.
    const { policies, timezone } = await this.policies.load(tx, quem.tenantId, body.brand_id);
    const teto = tetoDaVerba(policies, 'meta_ads');
    if (teto !== null && body.daily_budget_micros > teto) {
      throw recusa(
        'acima-do-teto',
        'Acima do teto por campanha',
        `A verba diária do teste passa do teto por campanha, que é de R$ ${(teto / 1_000_000).toFixed(2).replace('.', ',')} por dia. Quem muda o teto é o Dono ou o Administrador, em Verba do mês.`,
        'daily_budget_micros',
      );
    }

    // Os dois cupons: a loja no Regem, com "criar cupom de campanha" liberado e a escrita ligada; os códigos, livres.
    const regem = (
      await tx.execute<{ id: string; pode_criar: boolean }>(sql`
        select a.id, coalesce(a.provider_attributes -> 'escopos' @> '["cupons.criar"]'::jsonb, false) as pode_criar
          from liame.connected_account a
         where a.tenant_id = ${quem.tenantId} and a.brand_id = ${body.brand_id} and a.provider = 'regem' and a.unit_id = ${body.unit_id} and ${contaConectada('a')}
         order by a.id limit 1`)
    ).rows[0];
    if (!regem) throw conflito('sem-regem', 'A loja não está ligada ao Regem', 'Cada criativo do teste tem um cupom, criado no Regem. Ligue o Regem da loja em Contas conectadas.');
    if (!regem.pode_criar) {
      throw conflito('regem-sem-cupom', 'A loja não liberou criar cupom', 'A loja não liberou "criar cupom de campanha" no Regem. Autorize de novo em Contas conectadas e ligue essa chave lá.');
    }
    if (!(await this.flags.isEnabled('regem_write', this.flags.context({ tenantId: quem.tenantId, userId: quem.userId, brandId: body.brand_id })))) {
      throw conflito('regem-sem-escrita', 'Criar cupom não está ligado', 'Criar cupom no Regem não está ligado para esta empresa: sem os dois cupons, o teste não tem como dizer de onde veio o pedido.');
    }
    const usados = (
      await tx.execute<{ code: string }>(sql`
        select code from liame.coupon
         where tenant_id = ${quem.tenantId} and connected_account_id = ${regem.id} and code in (${body.arms[0]!.coupon_code}, ${body.arms[1]!.coupon_code})`)
    ).rows;
    if (usados.length) {
      const i = body.arms.findIndex((b) => b.coupon_code === usados[0]!.code);
      throw recusa('cupom-em-uso', 'Código de cupom em uso', `Já existe um cupom ${usados[0]!.code} nesta loja. Escolha outro código para o criativo ${LETRAS[i] ?? 'A'}.`, `arms.${Math.max(i, 0)}.coupon_code`);
    }

    // O desconto e a validade dos dois cupons: valem desde hoje, o bastante para a espera até ativar e os dias do teste.
    const hoje = hojeNoFuso(agora, timezone);
    const desconto: DescontoDoTeste =
      body.discount.kind === 'percentual'
        ? { tipo: 'percentual', percentual: body.discount.percent!, pedido_minimo_centavos: body.discount.min_order_cents, valido_de: hoje, valido_ate: diaMais(hoje, VALIDADE_DOS_CUPONS_DO_TESTE_DIAS) }
        : { tipo: 'valor', valor_centavos: body.discount.value_cents!, pedido_minimo_centavos: body.discount.min_order_cents, valido_de: hoje, valido_ate: diaMais(hoje, VALIDADE_DOS_CUPONS_DO_TESTE_DIAS) };

    // O texto de cada anúncio: o da peça com a linha do cupom. Passa de novo pelas regras de texto (a linha do cupom é
    // promessa de desconto, e entra na conferência como parte da oferta: o cupom é criado com exatamente esse desconto)
    // e precisa caber sem corte (D-A5-33: o que não cabe não entra).
    const daMarca = await marcaDoCriativo(body.brand_id, timezone, agora);
    if (!daMarca) throw conflito('sem-dossie', 'Falta o dossiê da marca', 'A conferência do texto do anúncio parte de Minha marca. Preencha Minha marca antes de pedir o teste.');
    const textos = new Map<LetraDoTeste, string>();
    for (const [i, c] of criativos.entries()) {
      const texto = textoDoAnuncioDoTeste(c.texto, c.cupom, desconto);
      if ([...texto].length > LIMITE_DO_TEXTO_DO_ANUNCIO) {
        throw recusa(
          'texto-nao-cabe',
          'O texto com o cupom não cabe',
          `O texto da peça do criativo ${c.letra} com a linha do cupom passa de ${LIMITE_DO_TEXTO_DO_ANUNCIO} caracteres, e o Liame não corta texto. Use uma peça com o texto mais curto.`,
          `arms.${i}.piece_id`,
        );
      }
      const linhaDoCupom = texto.slice(c.texto.trimEnd().length).trim();
      const conferencia = conferirPeca({ titulo: c.titulo, texto }, baseDoPedido({ oferta: `${c.oferta}\n${linhaDoCupom}`, instrucao: c.instrucao }, daMarca), 'pessoa');
      if (conferencia.situacao === 'barrou') {
        const achado = conferencia.itens.flatMap((item) => (item.situacao === 'barrou' ? item.achados : []))[0];
        throw recusa(
          'texto-barrado',
          'O texto com o cupom não passou na conferência',
          `O texto do anúncio do criativo ${c.letra}, com a linha do cupom, não passou nas regras de texto${achado ? `: ${mensagemDoAchado(achado)}` : '.'}`,
          `arms.${i}.coupon_code`,
        );
      }
      textos.set(c.letra, texto);
    }

    // Quem vê: o raio em volta da loja, ou os bairros do município dela (como na campanha nova). O mesmo nos dois conjuntos.
    const bairros: BairroDaCampanha[] | null = body.districts ? await this.campanhas.bairrosDoPedido(tx, loja.ibge_city_code, body.districts) : null;
    const lugares = bairros ? lugaresDosBairros(bairros) : lugaresDoRaio(Number(loja.latitude), Number(loja.longitude), body.radius_km!);
    const estimativa = await this.campanhas.estimativa(tx, contaDeAnuncios, lugares);
    if (estimativa.status === 'pronta' && !publicoSuficiente(estimativa.publico)) {
      throw bairros
        ? recusa('publico-pequeno', 'Público pequeno demais nos bairros', textoDoPublicoPequenoNosBairros(estimativa.publico, bairros.length), 'districts')
        : recusa('publico-pequeno', 'Público pequeno demais no raio', textoDoPublicoPequeno(estimativa.publico, body.radius_km!, loja.name), 'radius_km');
    }
    const publico = estimativa.status === 'pronta' ? estimativa.publico : null;

    // Quem assina: a Página e, quando ligado e conectado, o Instagram dela.
    const instagram = pagina.instagram_id
      ? ((
          await tx.execute<{ external_id: string; name: string }>(sql`
            select ig.external_id, ig.name from liame.connected_account ig
             where ig.tenant_id = ${quem.tenantId} and ig.brand_id = ${body.brand_id} and ig.provider = 'instagram' and ig.external_id = ${pagina.instagram_id} and ${contaConectada('ig')}
             limit 1`)
        ).rows[0] ?? null)
      : null;

    const id = uuidv7();
    const plano: Omit<EstadoDoTesteDeCriativo, 'situacao' | 'ativa'> = {
      teste: id,
      marca: body.brand_id,
      nome: body.name,
      objetivo: 'cardapio',
      criativos: criativos.map((c) => ({
        letra: c.letra,
        peca: { id: c.pieceId, versao: c.versao, titulo: c.titulo, texto: c.texto, botao: c.botao },
        texto_do_anuncio: textos.get(c.letra)!,
        midia: { id: c.mediaId, tipo: c.tipo, arquivo: c.arquivo },
        cupom: { codigo: c.cupom, situacao: 'a_criar' as const },
      })) as EstadoDoTesteDeCriativo['criativos'],
      desconto,
      pagina: { id: pagina.external_id, nome: pagina.name },
      instagram: instagram ? { id: instagram.external_id, nome: instagram.name } : null,
      publico: publico ? { de: publico.de, ate: publico.ate } : null,
      loja: { id: body.unit_id, nome: loja.name, latitude: Number(loja.latitude), longitude: Number(loja.longitude) },
      raio_km: body.radius_km ?? null,
      bairros,
      verba_diaria_micros: body.daily_budget_micros,
      moeda: contaDeAnuncios.currency ?? 'BRL',
      fuso: timezone,
      link,
      dias: { minimo: DIAS_DO_TESTE_DE_CRIATIVO.minimo, maximo: DIAS_DO_TESTE_DE_CRIATIVO.maximo },
    };
    // As mesmas regras do plano da ferramenta, antes de gravar: o pedido que o plano recusaria não nasce.
    const impede = oQueImpedeOTeste({ ...plano, situacao: 'pedido', ativa: false });
    if (impede) throw recusa('teste-invalido', 'O teste não pode ser pedido assim', impede);

    // O teste anterior da marca cujo pedido já se encerrou em Aprovações (recusado, expirado, ou que falhou) sai do caminho.
    await tx.execute(sql`
      update liame.campaign_test t
         set status = 'cancelado', error = coalesce(t.error, left(r.status_reason, 2000)), updated_at = now()
        from liame.action_request r
       where t.tenant_id = ${quem.tenantId} and t.brand_id = ${body.brand_id} and t.status in ('pedido', 'criando')
         and r.id = t.action_id and r.tenant_id = t.tenant_id and r.status in ${ENCERRADOS}`);

    // O teste e os dois criativos. Um teste vivo por marca (o índice único): o segundo espera o primeiro acabar.
    const novo = await tx.execute(sql`
      insert into liame.campaign_test (id, tenant_id, brand_id, unit_id, ad_account_id, page_account_id, kind, name, daily_budget_micros, min_days, max_days, plan, created_by)
      values (${id}, ${quem.tenantId}, ${body.brand_id}, ${body.unit_id}, ${contaDeAnuncios.id}, ${pagina.id}, 'criativo', ${body.name}, ${body.daily_budget_micros},
              ${DIAS_DO_TESTE_DE_CRIATIVO.minimo}, ${DIAS_DO_TESTE_DE_CRIATIVO.maximo}, ${JSON.stringify(plano)}::jsonb, ${quem.userId})
      on conflict do nothing
      returning id`);
    if (!novo.rows[0]) {
      throw conflito('teste-em-andamento', 'Já existe um teste desta marca', 'A marca já tem um teste pedido ou rodando. O Liame faz um teste por vez: espere esse acabar, ou encerre-o.');
    }
    for (const c of criativos) {
      await tx.execute(sql`
        insert into liame.campaign_test_arm (id, tenant_id, test_id, letter, piece_id, piece_version, media_id, coupon_code)
        values (${uuidv7()}, ${quem.tenantId}, ${id}, ${c.letra}, ${c.pieceId}, ${c.versao}, ${c.mediaId}, ${c.cupom})`);
    }
    const pedido = await this.actions.pedirPelaRota(auth, {
      tool: 'teste_de_criativo_criar',
      brand_id: body.brand_id,
      provider: 'meta_ads',
      account_id: contaDeAnuncios.id,
      resource_id: recursoDoTesteDeCriativo(id),
      params: {},
    });
    await tx.execute(sql`update liame.campaign_test set action_id = ${pedido}, updated_at = now() where id = ${id}`);
    auditDetail({
      resourceId: id,
      before: null,
      after: {
        brand_id: body.brand_id,
        unit_id: body.unit_id,
        arms: criativos.map((c) => ({ letter: c.letra, piece_id: c.pieceId, piece_version: c.versao, media_id: c.mediaId, coupon_code: c.cupom })),
        discount: body.discount,
        radius_km: body.radius_km ?? null,
        districts: body.districts ?? null,
        daily_budget_micros: body.daily_budget_micros,
        action_id: pedido,
      },
    });
    return this.obter(auth, id);
  }

  /**
   * Pedir para ativar a campanha de teste: um pedido em Aprovações (`teste_de_criativo_ativar`), com o código do app, os
   * limites da empresa e a verba do mês. Só com o teste pronto (tudo criado na Meta e os dois cupons no Regem), e com
   * os cupons valendo até o fim do teste.
   */
  async ativar(auth: AuthContext, id: string, agora: Date = new Date()): Promise<CreativeTestResponse> {
    const tx = currentTx();
    const quem = this.quem(auth);
    const t = await this.linha(quem.tenantId, id, true);
    await this.exigirAFuncao(quem, t.brand_id);
    if (t.status !== 'pronto') throw conflito('teste-nao-esta-pronto', 'O teste ainda não está pronto', 'A campanha de teste e os dois cupons precisam existir antes de ativar.');
    if (t.pending_action_id) throw conflito('ja-pedido', 'Já existe um pedido de ativar', 'Já existe um pedido de ativar este teste esperando a decisão, em Aprovações.');
    const plano = t.plan as { desconto?: { valido_ate?: string }; fuso?: string };
    const fimPossivel = diaMais(hojeNoFuso(agora, plano.fuso ?? 'America/Sao_Paulo'), t.max_days + 1);
    if (plano.desconto?.valido_ate && fimPossivel > plano.desconto.valido_ate) {
      throw conflito('cupons-vencem-antes', 'Os cupons vencem antes do fim do teste', 'Os cupons deste teste vencem antes de o teste poder acabar. Peça o teste de novo, com cupons novos.');
    }
    // O teto por campanha de AGORA, com a verba do teste inteiro: a empresa pode ter baixado o teto depois do pedido de
    // criar, e a regra de valor máximo do motor da política não casa com a ação de ativar (como na campanha nova).
    const { policies } = await this.policies.load(tx, quem.tenantId, t.brand_id);
    const teto = tetoDaVerba(policies, 'meta_ads');
    if (teto !== null && Number(t.daily_budget_micros) > teto) {
      throw recusa(
        'acima-do-teto',
        'Acima do teto por campanha',
        `A verba diária do teste passa do teto por campanha, que é de R$ ${(teto / 1_000_000).toFixed(2).replace('.', ',')} por dia. Quem muda o teto é o Dono ou o Administrador, em Verba do mês.`,
      );
    }
    const conta = (await tx.execute<{ ad_account_id: string }>(sql`select ad_account_id from liame.campaign_test where id = ${id} and tenant_id = ${quem.tenantId}`)).rows[0]!;
    await this.actions.pedirPelaRota(auth, { tool: 'teste_de_criativo_ativar', brand_id: t.brand_id, provider: 'meta_ads', account_id: conta.ad_account_id, resource_id: recursoDoTesteDeCriativo(id), params: {} });
    auditDetail({ resourceId: id, before: { active: false }, after: { active: 'pedido' } });
    return this.obter(auth, id);
  }

  /**
   * "Encerrar o teste" (D-RG-80): com a campanha de teste no ar, pede `teste_de_criativo_pausar`, que para de gastar e não
   * pede o código do app; o conector deixa o teste encerrado. Sem ela no ar (o teste pronto e ainda não ativado, ou o que
   * já terminou), só marca o teste como encerrado: nada muda na Meta.
   */
  async encerrar(auth: AuthContext, id: string): Promise<CreativeTestResponse> {
    const tx = currentTx();
    const quem = this.quem(auth);
    const t = await this.linha(quem.tenantId, id, true);
    if (t.status === 'encerrado' || t.status === 'cancelado') return this.obter(auth, id);
    if (t.status === 'pedido' || t.status === 'criando') {
      throw conflito('teste-nao-comecou', 'O teste ainda não começou', 'O pedido deste teste ainda está em Aprovações ou em criação. Recuse o pedido em Aprovações, ou espere a campanha de teste existir.');
    }
    if (t.active) {
      const conta = (await tx.execute<{ ad_account_id: string }>(sql`select ad_account_id from liame.campaign_test where id = ${id} and tenant_id = ${quem.tenantId}`)).rows[0]!;
      await this.actions.pedirPelaRota(auth, { tool: 'teste_de_criativo_pausar', brand_id: t.brand_id, provider: 'meta_ads', account_id: conta.ad_account_id, resource_id: recursoDoTesteDeCriativo(id), params: {} });
      await tx.execute(sql`update liame.campaign_test set stopped_by = ${quem.userId}, updated_at = now() where id = ${id} and tenant_id = ${quem.tenantId}`);
    } else if (t.status === 'pronto') {
      await tx.execute(sql`update liame.campaign_test set status = 'encerrado', stopped_at = now(), stopped_by = ${quem.userId}, version = version + 1, updated_at = now() where id = ${id} and tenant_id = ${quem.tenantId}`);
    }
    auditDetail({ resourceId: id, before: { status: t.status, active: t.active }, after: { status: 'encerrado' } });
    return this.obter(auth, id);
  }

  /** Os testes de criativo da marca, do mais novo para o mais antigo (D-RG-83: o que funcionou fica guardado por empresa). */
  async listar(auth: AuthContext, query: CreativeTestListQuery): Promise<CreativeTestListResponse> {
    const quem = this.quem(auth);
    const tx = currentTx();
    const marca = await tx.execute(sql`select 1 from liame.brand where id = ${query.brand_id} and tenant_id = ${quem.tenantId} and archived_at is null`);
    if (!marca.rows[0]) throw new AppProblem(404, 'nao-encontrado', 'Não encontramos', 'Marca não encontrada nesta empresa.');
    const ids = (
      await tx.execute<{ id: string }>(sql`
        select id from liame.campaign_test where tenant_id = ${quem.tenantId} and brand_id = ${query.brand_id} and kind = 'criativo' order by created_at desc, id desc limit 50`)
    ).rows;
    const items: CreativeTestResponse[] = [];
    for (const { id } of ids) items.push(await this.obter(auth, id));
    return { items };
  }

  async obter(auth: AuthContext, id: string): Promise<CreativeTestResponse> {
    const quem = this.quem(auth);
    const t = await this.linha(quem.tenantId, id, false);
    const bracos = (
      await currentTx().execute<LinhaDoBraco>(sql`
        select letter, piece_id, piece_version, media_id, coupon_code, coupon_status, meta_adset_id, meta_ad_id
          from liame.campaign_test_arm where test_id = ${id} and tenant_id = ${quem.tenantId} order by letter`)
    ).rows;
    const plano = t.plan as Omit<EstadoDoTesteDeCriativo, 'situacao' | 'ativa'>;
    const doPlano = (letra: LetraDoTeste) => plano.criativos[letra === 'A' ? 0 : 1];
    return {
      id: t.id,
      brand_id: t.brand_id,
      unit_id: t.unit_id,
      name: t.name,
      status: t.status,
      active: t.active,
      arms: bracos.map((b) => ({
        letter: b.letter,
        piece_id: b.piece_id,
        piece_version: b.piece_version,
        media_id: b.media_id,
        title: doPlano(b.letter).peca.titulo,
        ad_text: doPlano(b.letter).texto_do_anuncio,
        coupon_code: b.coupon_code,
        coupon_status: b.coupon_status,
        meta: { adset_id: b.meta_adset_id, ad_id: b.meta_ad_id },
      })),
      discount: {
        kind: plano.desconto.tipo,
        percent: plano.desconto.tipo === 'percentual' ? plano.desconto.percentual : null,
        value_cents: plano.desconto.tipo === 'valor' ? plano.desconto.valor_centavos : null,
        min_order_cents: plano.desconto.pedido_minimo_centavos,
        valid_until: plano.desconto.valido_ate,
      },
      radius_km: plano.raio_km,
      districts: plano.bairros?.length ? plano.bairros.map((b) => ({ code: b.codigo, name: b.nome, meta: b.meta !== null, radius_km: b.raio_km })) : null,
      daily_budget_micros: Number(t.daily_budget_micros),
      min_days: t.min_days,
      max_days: t.max_days,
      link: plano.link,
      action_id: t.action_id,
      pending_action_id: t.pending_action_id,
      started_on: t.started_on,
      ended_on: t.ended_on,
      error: t.error,
      reason: t.reason,
      result: resultadoDaResposta(t.result),
      meta: { account_id: t.meta_account_id, campaign_id: t.meta_campaign_id },
      created_at: new Date(t.created_at).toISOString(),
    };
  }

  /** O teste de criativo desta empresa, com o pedido de ativar que espera decisão; 404 quando não é dela. */
  private async linha(tenantId: string, id: string, travar: boolean): Promise<Linha> {
    const r = await currentTx().execute<Linha>(sql`
      select t.id, t.brand_id, t.unit_id, t.name, t.status, t.active, t.daily_budget_micros::text, t.min_days, t.max_days, t.plan, t.action_id,
             (select p.id from liame.action_request p
               where p.tenant_id = t.tenant_id and p.tool = 'teste_de_criativo_ativar' and p.resource_id = ${recursoDoTesteDeCriativo(id)} and p.status in ${EM_ABERTO}
               order by p.created_at desc limit 1) as pending_action_id,
             t.meta_campaign_id, a.external_id as meta_account_id, t.started_on::text as started_on, t.ended_on::text as ended_on, t.error, t.reason, t.result, t.created_at
        from liame.campaign_test t
        left join liame.connected_account a on a.id = t.ad_account_id and a.tenant_id = t.tenant_id
       where t.id = ${id} and t.tenant_id = ${tenantId} and t.kind = 'criativo'
       ${travar ? sql`for update of t` : sql``}`);
    if (!r.rows[0]) throw new AppProblem(404, 'nao-encontrado', 'Não encontramos', 'Teste não encontrado nesta empresa.');
    return r.rows[0];
  }
}
