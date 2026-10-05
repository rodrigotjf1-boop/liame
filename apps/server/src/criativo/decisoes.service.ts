import type {
  AdPieceResponse,
  ApproveAdPieceRequest,
  ApproveAdPiecesRequest,
  ApproveAdPiecesResponse,
  ContestAdPieceRequest,
  RedoAdPieceRequest,
  RejectAdPieceRequest,
  UpdateAdPieceRequest,
} from '@liame/contracts';
import { uuidv7 } from '@liame/database';
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { baseDoPedido, conferirPedido } from '../ai/criativo/contexto.js';
import { type BotaoDaPeca, type ConferenciaDaPeca, conferirPeca, type Peca } from '../ai/criativo/peca.js';
import { CRIATIVO } from '../ai/criativo/prompt.js';
import { AiGateway } from '../ai/gateway.js';
import { funcionarioAtivo } from '../ai/registro/ativacao.js';
import { limparTexto } from '../ai/sanitizar.js';
import { RateLimitService } from '../auth/rate-limit.service.js';
import { type AuthContext, auditDetail, currentTx } from '../context/request-context.js';
import { AppProblem, type FieldError } from '../errors/problems.js';
import { FlagService } from '../flags/flag.service.js';
import { ResultsService } from '../results/results.service.js';
import { hashDaPeca, regrasDaConferencia, revisaoDaConferencia } from './apresentacao.js';
import { type MarcaDoCriativo, marcaDoCriativo, mensagemDoAchado, mensagemDoProblema } from './base.js';
import { pecaComHistorico, pecasComAVersaoAtual } from './consultas.js';
import { CustoDasPecasService } from './custo.service.js';
import { FLAG_DO_CRIATIVO, PEDIDOS_POR_DIA } from './pecas.service.js';

// As decisões sobre uma peça do Criativo (A4, X6; `plano-a4.md` D-A4-29 e D-A4-30, propostas; protótipo P10, aguardando
// aprovação; sem tela ainda): editar o texto (nasce uma versão nova, conferida de novo; o que seria barrado não é
// salvo), aprovar (a peça vai para a biblioteca; não pede o código do app, porque nada sai do Liame), uma peça ou
// várias de uma vez ("as que passaram"), recusar com o motivo, pedir outra ao Criativo e contestar a conferência
// (guarda o motivo e não destrava). Tudo é de quem opera campanhas e vale só para a peça que espera decisão. A peça é
// travada no começo de cada decisão (V37): duas pessoas decidindo juntas, uma só passa.

const CAMPO_DA_PECA = { titulo: 'title', texto: 'body' } as const;

type PecaTravada = {
  id: string;
  brand_id: string;
  status: string;
  version: number;
  offer: string;
  destination: string;
  instruction: string | null;
  reference_ad_id: string | null;
  reference_name: string | null;
  title: string;
  body: string;
  button: BotaoDaPeca;
  content_hash: string;
  author: string;
  review_status: string;
  redoing: boolean;
};

/** A peça com a versão atual e o pedido de onde nasceu: o que cada decisão lê ao travar a peça. */
const PECA_COM_A_VERSAO_ATUAL = sql`
  select p.id, p.brand_id, p.status, p.version, p.review_status, q.offer, q.destination, q.instruction, q.reference_ad_id, q.reference_name,
         v.title, v.body, v.button, v.content_hash, v.author,
         exists (select 1 from liame.ad_piece_request y where y.piece_id = p.id and y.status in ('pendente', 'gerando')) as redoing
    from liame.ad_piece p
    join liame.ad_piece_request q on q.id = p.request_id
    join liame.ad_piece_version v on v.piece_id = p.id and v.version = p.version`;

const naoEncontrado = () => new AppProblem(404, 'nao-encontrado', 'Não encontramos', 'Esta peça não existe nesta empresa.');
const decidida = () => new AppProblem(409, 'peca-decidida', 'Esta peça já foi decidida', 'Alguém já aprovou ou recusou esta peça. Atualize a tela.');
const mudou = () => new AppProblem(409, 'peca-mudou', 'A peça mudou depois que você abriu', 'Há uma versão mais nova desta peça. Atualize a tela e confira de novo antes de decidir.');
const refazendo = () => new AppProblem(409, 'peca-refazendo', 'O Criativo está refazendo esta peça', 'Espere a versão nova ficar pronta para editar, pedir outra ou decidir.');
const ofertaMudou = () =>
  new AppProblem(409, 'oferta-mudou', 'A oferta desta peça mudou em Minha marca', 'A oferta de que esta peça partiu mudou ou saiu de Minha marca. Recuse esta peça e peça outra, para ela sair com a oferta de agora.');

/** Os achados que barram, como erros por campo (o título ou o texto), para a tela dizer o que mudar. */
function errosDaConferencia(c: ConferenciaDaPeca): FieldError[] {
  return c.itens.filter((i) => i.situacao === 'barrou').flatMap((i) => i.achados.map((a) => ({ path: CAMPO_DA_PECA[a.campo], message: mensagemDoAchado(a) })));
}

// A regra de aprovar é uma só, para uma peça e para várias: primeiro o que impede decidir sobre o que a pessoa viu;
// depois a conferência de novo, com Minha marca de agora.

type ImpedimentoDeAprovar = 'peca_decidida' | 'peca_refazendo' | 'peca_mudou';
const PROBLEMA_DO_IMPEDIMENTO: Record<ImpedimentoDeAprovar, () => AppProblem> = { peca_decidida: decidida, peca_refazendo: refazendo, peca_mudou: mudou };

/** O que impede aprovar a peça como a pessoa a viu, antes de olhar a marca; nulo quando nada impede. */
function impedimentoDeAprovar(p: PecaTravada, hashVisto: string): ImpedimentoDeAprovar | null {
  if (p.status !== 'decidir') return 'peca_decidida';
  if (p.redoing) return 'peca_refazendo';
  return hashVisto !== p.content_hash ? 'peca_mudou' : null;
}

/** A oferta da peça continua em Minha marca? Com ela fora (ou sem dossiê), o preço da peça pode não valer mais. */
const ofertaAindaVale = (p: PecaTravada, marca: MarcaDoCriativo | null): marca is MarcaDoCriativo => marca !== null && marca.conteudo.offers.items.includes(p.offer);

/** A conferência da versão atual com as regras e a marca de agora (a gravada com a versão é a do dia em que ela nasceu). */
const conferirDeNovo = (p: PecaTravada, marca: MarcaDoCriativo): ConferenciaDaPeca =>
  conferirPeca({ titulo: p.title, texto: p.body }, baseDoPedido({ oferta: p.offer, instrucao: p.instruction }, marca), p.author === 'criativo' ? 'ia' : 'pessoa');

@Injectable()
export class DecisoesDePecaService {
  constructor(
    private readonly gateway: AiGateway,
    private readonly flags: FlagService,
    private readonly limite: RateLimitService,
    private readonly resultados: ResultsService,
    private readonly custo: CustoDasPecasService,
  ) {}

  /** Editar o texto: nasce a versão seguinte, da pessoa, conferida de novo. O texto que seria barrado não é salvo. */
  async editar(auth: AuthContext, id: string, body: UpdateAdPieceRequest, agora = new Date()): Promise<AdPieceResponse> {
    const tenantId = await this.exigirCriativo(auth);
    const p = await this.travar(id);
    if (p.status !== 'decidir') throw decidida();
    if (p.redoing) throw refazendo();
    if (body.base_version !== p.version) throw mudou();
    const nova: Peca = { titulo: body.title.replace(/\s+/g, ' ').trim(), texto: body.body.replace(/\s+/g, ' ').trim(), botao: body.button };
    if (nova.titulo === p.title && nova.texto === p.body && nova.botao === p.button) {
      auditDetail({ resourceId: id, after: { version: p.version }, reason: 'nada mudou: nenhuma versão nova' });
      return this.detalhe(id);
    }
    const marca = await this.marcaDaPeca(p, agora);
    // Quem escreve responde pelo que escreve: a regra dos números em geral não roda; o preço continua o da oferta.
    const conferencia = conferirPeca(nova, baseDoPedido({ oferta: p.offer, instrucao: p.instruction }, marca), 'pessoa');
    if (conferencia.situacao === 'barrou') {
      throw new AppProblem(422, 'texto-barrado', 'Este texto não passa na conferência', 'O texto bate numa regra de anúncio e não foi salvo. Veja o que mudar em cada campo.', {}, errosDaConferencia(conferencia));
    }
    const versao = p.version + 1;
    const tx = currentTx();
    await tx.execute(sql`
      insert into liame.ad_piece_version (id, tenant_id, piece_id, version, title, body, button, review, review_status, rules_version, content_hash, author, created_by)
      values (${uuidv7()}, ${tenantId}, ${id}, ${versao}, ${nova.titulo}, ${nova.texto}, ${nova.botao}, ${JSON.stringify(revisaoDaConferencia(conferencia))}::jsonb, ${conferencia.situacao},
              ${JSON.stringify(regrasDaConferencia())}::jsonb, ${hashDaPeca(nova)}, 'pessoa', ${auth.userId})`);
    await tx.execute(sql`update liame.ad_piece set version = ${versao}, review_status = ${conferencia.situacao}, updated_at = now() where id = ${id}`);
    auditDetail({ resourceId: id, before: { version: p.version }, after: { version: versao, review_status: conferencia.situacao } });
    return this.detalhe(id);
  }

  /**
   * Aprovar: a peça vai para a biblioteca. Vale para o hash que a pessoa viu, e a peça é conferida de novo com as
   * regras e a oferta de agora: a barrada não é aprovada, nem a que partiu de uma oferta que mudou. Não pede o código
   * do app: nada sai do Liame (criar e ativar a campanha são pedidos à parte, com o código).
   */
  async aprovar(auth: AuthContext, id: string, body: ApproveAdPieceRequest, agora = new Date()): Promise<AdPieceResponse> {
    const tenantId = await this.exigirCriativo(auth);
    const p = await this.travar(id);
    const impede = impedimentoDeAprovar(p, body.content_hash);
    if (impede) throw PROBLEMA_DO_IMPEDIMENTO[impede]();
    const conferencia = conferirDeNovo(p, await this.marcaDaPeca(p, agora));
    if (conferencia.situacao === 'barrou') {
      throw new AppProblem(409, 'peca-barrada', 'Esta peça não passa na conferência', 'A peça bate numa regra de anúncio e não pode ser aprovada. Edite o texto, peça outra ou recuse.', {}, errosDaConferencia(conferencia));
    }
    await this.decidir(tenantId, auth, p, 'aprovada', null, null, agora);
    auditDetail({ resourceId: id, before: { status: 'decidir' }, after: { status: 'aprovada', version: p.version, review_status: conferencia.situacao } });
    return this.detalhe(id);
  }

  /**
   * Aprovar várias de uma vez ("as que passaram"): a mesma regra de aprovar uma, peça por peça. Cada uma vale para o
   * hash que a pessoa viu e é conferida de novo com Minha marca de agora. A que não pode ser aprovada fica como está,
   * com o motivo, e as outras entram: uma peça não segura as outras. As peças são travadas juntas, em ordem (duas
   * pessoas aprovando o mesmo lote: cada peça é aprovada uma vez), e a gravação é uma instrução para as decisões e
   * outra para as peças, qualquer que seja a quantidade.
   */
  async aprovarVarias(auth: AuthContext, body: ApproveAdPiecesRequest, agora = new Date()): Promise<ApproveAdPiecesResponse> {
    const tenantId = await this.exigirCriativo(auth);
    const tx = currentTx();
    const travadas = new Map((await this.travarVarias(body.brand_id, body.items.map((i) => i.id))).map((p) => [p.id, p]));
    // Minha marca de agora, lida uma vez: as peças são todas desta marca.
    const marca = travadas.size ? await marcaDoCriativo(body.brand_id, await this.resultados.fusoDaMarca(body.brand_id), agora) : null;
    const avaliar = (item: { id: string; content_hash: string }): { motivo: string } | { p: PecaTravada; conferencia: ConferenciaDaPeca } => {
      const p = travadas.get(item.id);
      if (!p) return { motivo: 'nao_encontrada' };
      const impede = impedimentoDeAprovar(p, item.content_hash);
      if (impede) return { motivo: impede };
      if (!ofertaAindaVale(p, marca)) return { motivo: 'oferta_mudou' };
      const conferencia = conferirDeNovo(p, marca);
      return conferencia.situacao === 'barrou' ? { motivo: 'peca_barrada' } : { p, conferencia };
    };
    const motivos = new Map<string, string>();
    const aprovadas: Array<{ p: PecaTravada; conferencia: ConferenciaDaPeca }> = [];
    for (const item of body.items) {
      const avaliada = avaliar(item);
      if ('motivo' in avaliada) motivos.set(item.id, avaliada.motivo);
      else aprovadas.push(avaliada);
    }
    if (aprovadas.length) {
      const decisoes = aprovadas.map(({ p }) => sql`(${uuidv7()}, ${tenantId}, ${p.id}, ${p.version}, ${p.content_hash}, 'aprovada', ${auth.userId})`);
      await tx.execute(sql`
        insert into liame.ad_piece_decision (id, tenant_id, piece_id, version, content_hash, decision, decided_by)
        values ${sql.join(decisoes, sql`, `)}`);
      await tx.execute(sql`
        update liame.ad_piece set status = 'aprovada', decided_by = ${auth.userId}, decided_at = ${agora.toISOString()}::timestamptz, updated_at = now()
         where id in ${aprovadas.map(({ p }) => p.id)}`);
    }
    auditDetail({
      after: {
        brand_id: body.brand_id,
        aprovadas: aprovadas.map(({ p, conferencia }) => ({ id: p.id, version: p.version, review_status: conferencia.situacao })),
        nao_aprovadas: [...motivos].map(([id, motivo]) => ({ id, motivo })),
      },
    });
    // As peças como ficaram: a aprovada e a que não foi (a tela mostra o estado de agora de cada uma).
    const agoraEstao = travadas.size ? new Map((await pecasComAVersaoAtual(sql`p.id in ${[...travadas.keys()]}`, travadas.size)).map((x) => [x.id, x])) : new Map<string, AdPieceResponse>();
    return {
      approved: aprovadas.length,
      items: body.items.map((i) => ({ id: i.id, approved: !motivos.has(i.id), reason: motivos.get(i.id) ?? null, piece: agoraEstao.get(i.id) ?? null })),
    };
  }

  /** Recusar, com o motivo. O comentário é guardado sem dado pessoal. */
  async recusar(auth: AuthContext, id: string, body: RejectAdPieceRequest, agora = new Date()): Promise<AdPieceResponse> {
    const tenantId = await this.exigirCriativo(auth);
    const p = await this.travar(id);
    if (p.status !== 'decidir') throw decidida();
    if (body.content_hash !== p.content_hash) throw mudou();
    await this.decidir(tenantId, auth, p, 'recusada', body.reason, this.comentario(body.comment), agora);
    auditDetail({ resourceId: id, before: { status: 'decidir' }, after: { status: 'recusada', version: p.version, reason: body.reason } });
    return this.detalhe(id);
  }

  /**
   * Pedir outra: o Criativo refaz a peça, diferente da versão atual, e a versão nova entra na mesma peça. É um pedido
   * à IA: precisa do Criativo ligado, passa pela conferência do pedido, precisa caber no que resta do limite de uso de
   * IA e conta no limite de pedidos do dia. Um de cada vez por peça.
   */
  async pedirOutra(auth: AuthContext, id: string, body: RedoAdPieceRequest, agora = new Date()): Promise<AdPieceResponse> {
    const tenantId = await this.exigirCriativo(auth);
    const p = await this.travar(id);
    if (p.status !== 'decidir') throw decidida();
    if (p.redoing) throw refazendo();
    if (body.content_hash !== p.content_hash) throw mudou();
    const contexto = { tenantId, userId: auth.userId, brandId: p.brand_id };
    const ativo = (await this.gateway.ligada(contexto)) && (await funcionarioAtivo(currentTx(), { tenantId, brandId: p.brand_id, agentKey: CRIATIVO.key, ativoPorPadrao: CRIATIVO.ativoPorPadrao }));
    if (!ativo) throw new AppProblem(409, 'criativo-desligado', 'O Criativo não está ligado', 'Pedir outra versão depende da IA ligada para a empresa e do Criativo ativo. Dá para editar o texto, aprovar ou recusar.');
    const marca = await this.marcaDaPeca(p, agora);
    const instrucao = body.instruction ?? p.instruction;
    const problemas = conferirPedido({ oferta: p.offer, instrucao, variacoes: 1 }, marca);
    if (problemas.length) {
      const erros: FieldError[] = problemas.map((x) => ({ path: x.campo === 'instrucao' ? 'instruction' : 'offer', message: mensagemDoProblema(x) }));
      throw new AppProblem(422, 'pedido-recusado', 'O Criativo não pode fazer este pedido', 'O pedido bate numa regra de anúncio. Veja o que mudar.', {}, erros);
    }
    // A versão nova também é um pedido à IA: sem caber no que resta do limite, é negada na hora (D-A4-32).
    await this.custo.exigirQueCaiba(tenantId, p.brand_id, agora);
    await this.limite.consume(`pecas:${p.brand_id}`, PEDIDOS_POR_DIA, 86_400);
    const pedido = uuidv7();
    const novo = await currentTx().execute<{ id: string }>(sql`
      insert into liame.ad_piece_request (id, tenant_id, brand_id, kind, offer, dossier_version, destination, variations, instruction, reference_ad_id, reference_name, piece_id, requested_by)
      values (${pedido}, ${tenantId}, ${p.brand_id}, 'texto', ${p.offer}, ${marca.versao}, ${p.destination}, 1, ${instrucao}, ${p.reference_ad_id}, ${p.reference_name}, ${id}, ${auth.userId})
      on conflict (piece_id) where status in ('pendente', 'gerando') and piece_id is not null do nothing
      returning id`);
    if (!novo.rows[0]) throw refazendo();
    auditDetail({ resourceId: id, after: { request_id: pedido, version: p.version, com_instrucao: body.instruction !== undefined } });
    return this.detalhe(id);
  }

  /** "A conferência errou?": guarda o motivo, sem dado pessoal, para a regra ser revista. A peça não muda. */
  async contestar(auth: AuthContext, id: string, body: ContestAdPieceRequest): Promise<AdPieceResponse> {
    const tenantId = await this.exigirCriativo(auth);
    const p = await this.travar(id);
    if (p.status !== 'decidir') throw decidida();
    if (body.content_hash !== p.content_hash) throw mudou();
    if (p.review_status === 'passou') {
      throw new AppProblem(409, 'sem-o-que-contestar', 'Esta peça passou na conferência', 'Só dá para contestar a conferência de uma peça barrada ou com aviso.');
    }
    const comentario = this.comentario(body.comment);
    if (!comentario) throw new AppProblem(422, 'comentario-vazio', 'Diga o que a conferência errou', 'Escreva o motivo sem telefone, e-mail nem documento.');
    const tx = currentTx();
    const ja = await tx.execute(sql`select 1 from liame.ad_piece_decision where piece_id = ${id} and version = ${p.version} and decision = 'contestada' limit 1`);
    if (ja.rows.length) throw new AppProblem(409, 'ja-contestada', 'Esta conferência já foi contestada', 'O motivo desta versão já está guardado para a regra ser revista.');
    await tx.execute(sql`
      insert into liame.ad_piece_decision (id, tenant_id, piece_id, version, content_hash, decision, comment, decided_by)
      values (${uuidv7()}, ${tenantId}, ${id}, ${p.version}, ${p.content_hash}, 'contestada', ${comentario}, ${auth.userId})`);
    auditDetail({ resourceId: id, after: { version: p.version, review_status: p.review_status } });
    return this.detalhe(id);
  }

  /** Grava a decisão e muda a situação da peça. */
  private async decidir(tenantId: string, auth: AuthContext, p: PecaTravada, decisao: 'aprovada' | 'recusada', motivo: string | null, comentario: string | null, agora: Date): Promise<void> {
    const tx = currentTx();
    await tx.execute(sql`
      insert into liame.ad_piece_decision (id, tenant_id, piece_id, version, content_hash, decision, reason, comment, decided_by)
      values (${uuidv7()}, ${tenantId}, ${p.id}, ${p.version}, ${p.content_hash}, ${decisao}, ${motivo}, ${comentario}, ${auth.userId})`);
    await tx.execute(sql`
      update liame.ad_piece set status = ${decisao}, decided_by = ${auth.userId}, decided_at = ${agora.toISOString()}::timestamptz, updated_at = now() where id = ${p.id}`);
  }

  /** A peça, com a versão atual e o pedido de onde nasceu, travada até o fim da transação. */
  private async travar(id: string): Promise<PecaTravada> {
    const r = await currentTx().execute<PecaTravada>(sql`${PECA_COM_A_VERSAO_ATUAL} where p.id = ${id} for update of p`);
    if (!r.rows[0]) throw naoEncontrado();
    return r.rows[0];
  }

  /**
   * As peças pedidas que são desta marca, travadas juntas até o fim da transação. Em ordem de id: dois pedidos com as
   * mesmas peças travam na mesma sequência, e um espera o outro em vez de os dois se travarem.
   */
  private async travarVarias(brandId: string, ids: string[]): Promise<PecaTravada[]> {
    const r = await currentTx().execute<PecaTravada>(sql`${PECA_COM_A_VERSAO_ATUAL} where p.id in ${ids} and p.brand_id = ${brandId} order by p.id for update of p`);
    return r.rows;
  }

  /** O dossiê de agora, com a oferta da peça ainda lá: é contra ele que a peça é conferida ao editar e ao aprovar. */
  private async marcaDaPeca(p: PecaTravada, agora: Date): Promise<MarcaDoCriativo> {
    const marca = await marcaDoCriativo(p.brand_id, await this.resultados.fusoDaMarca(p.brand_id), agora);
    if (!marca || !marca.conteudo.offers.items.includes(p.offer)) throw ofertaMudou();
    return marca;
  }

  /** O comentário sem dado pessoal; vazio depois da limpeza, nulo. */
  private comentario(texto: string | undefined): string | null {
    const limpo = texto ? limparTexto(texto).texto.trim().slice(0, 500) : '';
    return limpo.length >= 1 ? limpo : null;
  }

  private async detalhe(id: string): Promise<AdPieceResponse> {
    const peca = await pecaComHistorico(id);
    if (!peca) throw naoEncontrado();
    return peca;
  }

  /** As decisões são da empresa com o Criativo ligado (a flag); não dependem da IA estar ligada nem do limite de IA. */
  private async exigirCriativo(auth: AuthContext): Promise<string> {
    if (!auth.tenantId) throw new AppProblem(403, 'sem-empresa', 'Sem empresa ativa', 'Escolha uma empresa para continuar.');
    if (!(await this.flags.isEnabled(FLAG_DO_CRIATIVO, this.flags.context({ tenantId: auth.tenantId, userId: auth.userId })))) {
      throw new AppProblem(409, 'criativo-desligado', 'O Criativo não está ligado', 'As peças do Criativo não estão ligadas para esta empresa.');
    }
    return auth.tenantId;
  }
}
