import { randomInt, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { type Database, withTenant } from '@liame/database';
import sharp from 'sharp';
import { VaultService } from '../../src/vault/vault.service.js';
import { enableMfa, ownerQuery, resetIpRateLimits, signupAndLogin, type TestApi } from './api.js';

// Um "Google" local para os testes da escrita no Google Ads (A5, Y2): o OAuth (a troca do refresh token) e a Google
// Ads API v25 por REST, no que o conector usa e como a referência conferida em 08/10/2026 descreve (base §3.1):
// `googleAds:searchStream` com a campanha e o orçamento dela, e com as outras campanhas de um orçamento dividido; `campaigns:mutate` e `campaignBudgets:mutate` com
// `operations[].updateMask` em snake_case, o corpo em camelCase e `validateOnly` (não muda nada e só devolve erros);
// erros com o `GoogleAdsFailure` dentro de `error.details`.
// A criação da Performance Max (Y9, parte 3): `googleAds:mutate` com `mutateOperations` e os ids provisórios negativos,
// conferida como a referência lida em 12/11/2026 descreve (a campanha pausada com as regras da marca, o nome da loja e a
// logo na campanha, o grupo de recursos com os textos e as imagens nas quantidades, nos tamanhos e nas proporções; as
// imagens medidas de verdade); tudo ou nada; e a procura da campanha criada pelo nome com a marca do Liame.

export const ACESSO_DO_GOOGLE = 'acesso-de-teste-google';
export const REFRESH_DO_GOOGLE = 'refresh-de-teste-google';
/** O refresh token que o Google de mentira recusa (autorização revogada). */
export const REFRESH_REVOGADO = 'refresh-revogado';
const FUSO = 'America/Sao_Paulo';

export type CampanhaNoGoogle = { cliente: string; id: string; name: string; status: 'ENABLED' | 'PAUSED' | 'REMOVED'; primaryStatus: string; orcamento: string | null };
export type OrcamentoNoGoogle = { cliente: string; id: string; amountMicros: number | null; totalAmountMicros: number | null; explicitlyShared: boolean; period: 'DAILY' | 'CUSTOM_PERIOD' };
export type ChamadaAoGoogle = {
  tipo: 'leitura' | 'validacao' | 'escrita';
  cliente: string;
  /** `searchStream`, `mutate` (a criação da Performance Max), `campaigns` ou `campaignBudgets`. */
  recurso: string;
  corpo: Record<string, unknown>;
  autorizacao: string | undefined;
  gerente: string | undefined;
};
type Resposta = { status: number; corpo: unknown };
/** O grupo de recursos de uma Performance Max criada: o link e os recursos de cada papel (o texto, ou as medidas da imagem). */
export type GrupoNoGoogle = {
  cliente: string;
  id: string;
  campanha: string;
  finalUrls: string[];
  recursos: { papel: string; texto?: string; largura?: number; altura?: number }[];
};
/** O que a campanha criada leva além do que a lista de campanhas guarda: a marca, os critérios, a automação, o fim. */
export type CriacaoNoGoogle = { campanha: string; corpoDaCampanha: Record<string, unknown>; criterios: Record<string, unknown>[]; daCampanha: { papel: string; texto?: string; largura?: number; altura?: number }[] };

const numero = () => String(randomInt(1_000_000_000, 9_999_999_999));

export class GoogleDeMentira {
  base = '';
  readonly campanhas = new Map<string, CampanhaNoGoogle>();
  readonly orcamentos = new Map<string, OrcamentoNoGoogle>();
  readonly chamadas: ChamadaAoGoogle[] = [];
  /** Por conta (id do cliente): o que responder no lugar do normal. Devolver nulo segue o normal. */
  readonly defeitos = new Map<string, (c: ChamadaAoGoogle) => Resposta | null>();
  /** Os grupos de recursos das Performance Max criadas, pelo id. */
  readonly grupos = new Map<string, GrupoNoGoogle>();
  /** O resto do que cada criação levou, pelo id da campanha. */
  readonly criacoes = new Map<string, CriacaoNoGoogle>();
  /** As contas em que a próxima criação de verdade acontece e a resposta se perde (o Google responde 503 depois de criar). */
  readonly perderResposta = new Set<string>();
  renovacoes = 0;
  private servidor: Server | null = null;

  async subir(): Promise<void> {
    this.servidor = createServer((req, res) => {
      let texto = '';
      req.on('data', (d: Buffer) => (texto += d.toString('utf8')));
      req.on('end', () => {
        void this.responder(req, texto)
          .catch((err: unknown) => this.erro(500, 'INTERNAL', err instanceof Error ? err.message : 'erro'))
          .then((r) => {
            res.writeHead(r.status, { 'content-type': 'application/json' });
            res.end(JSON.stringify(r.corpo));
          });
      });
    });
    await new Promise<void>((ok) => this.servidor!.listen(0, '127.0.0.1', ok));
    this.base = `http://127.0.0.1:${(this.servidor.address() as AddressInfo).port}`;
  }

  async fechar(): Promise<void> {
    await new Promise((ok) => (this.servidor ? this.servidor.close(ok) : ok(undefined)));
  }

  /** As variáveis de ambiente que apontam o app para este Google (antes de subir a API). */
  ambiente(): Record<string, string> {
    return {
      GOOGLE_OAUTH_CLIENT_ID: 'cliente-de-teste.apps.googleusercontent.com',
      GOOGLE_OAUTH_CLIENT_SECRET: 'segredo-do-cliente-de-teste',
      GOOGLE_AUTH_URL: `${this.base}/google`,
      GOOGLE_TOKEN_URL: `${this.base}/oauth`,
      GOOGLE_ADS_URL: `${this.base}/ads`,
    };
  }

  /** O erro como a Google Ads API responde: o geral por fora e o específico no `GoogleAdsFailure`. */
  erro(status: number, nome: string, mensagem: string, especifico?: { codigo: Record<string, string>; texto: string; esperar?: string }): Resposta {
    return {
      status,
      corpo: {
        error: {
          code: status,
          message: mensagem,
          status: nome,
          ...(especifico
            ? {
                details: [
                  {
                    '@type': 'type.googleapis.com/google.ads.googleads.v25.errors.GoogleAdsFailure',
                    errors: [
                      {
                        errorCode: especifico.codigo,
                        message: especifico.texto,
                        ...(especifico.esperar ? { details: { quotaErrorDetails: { rateScope: 'DEVELOPER', rateName: 'Number of operations for explorer access', retryDelay: especifico.esperar } } } : {}),
                      },
                    ],
                    requestId: 'pedido-de-teste',
                  },
                ],
              }
            : {}),
        },
      },
    };
  }

  /** Um orçamento novo na conta: por padrão diário, de R$ 30,00, de uma campanha só. */
  novoOrcamento(cliente: string, extra: Partial<Omit<OrcamentoNoGoogle, 'cliente' | 'id'>> = {}): OrcamentoNoGoogle {
    const o: OrcamentoNoGoogle = { cliente, id: numero(), amountMicros: 30_000_000, totalAmountMicros: null, explicitlyShared: false, period: 'DAILY', ...extra };
    this.orcamentos.set(o.id, o);
    return o;
  }

  /** Uma campanha nova na conta, com o orçamento dado (ou um novo, só dela). */
  novaCampanha(cliente: string, extra: Partial<Omit<CampanhaNoGoogle, 'cliente' | 'id'>> = {}): CampanhaNoGoogle {
    const orcamento = extra.orcamento === undefined ? this.novoOrcamento(cliente).id : extra.orcamento;
    const c: CampanhaNoGoogle = { cliente, id: numero(), name: 'Busca hambúrguer perto', status: 'ENABLED', primaryStatus: 'ELIGIBLE', ...extra, orcamento };
    this.campanhas.set(c.id, c);
    return c;
  }

  chamadasDe(cliente: string): ChamadaAoGoogle[] {
    return this.chamadas.filter((c) => c.cliente === cliente);
  }
  /** O resumo das chamadas de uma conta, na ordem: `leitura`, `validacao:campaigns`, `escrita:campaignBudgets`… */
  resumo(cliente: string): string[] {
    return this.chamadasDe(cliente).map((c) => (c.tipo === 'leitura' ? 'leitura' : `${c.tipo}:${c.recurso}`));
  }
  /** As escritas de verdade (sem as validações) que chegaram para a conta. */
  escritasDe(cliente: string): ChamadaAoGoogle[] {
    return this.chamadasDe(cliente).filter((c) => c.tipo === 'escrita');
  }

  private linha(c: CampanhaNoGoogle): Record<string, unknown> {
    const o = c.orcamento ? this.orcamentos.get(c.orcamento) : undefined;
    const usando = o ? [...this.campanhas.values()].filter((x) => x.orcamento === o.id && x.status !== 'REMOVED').length : 0;
    return {
      campaign: {
        resourceName: `customers/${c.cliente}/campaigns/${c.id}`,
        id: c.id,
        name: c.name,
        status: c.status,
        primaryStatus: c.primaryStatus,
        ...(o ? { campaignBudget: `customers/${c.cliente}/campaignBudgets/${o.id}` } : {}),
      },
      ...(o
        ? {
            campaignBudget: {
              resourceName: `customers/${c.cliente}/campaignBudgets/${o.id}`,
              id: o.id,
              // O JSON do protobuf manda int64 como texto e omite o que não foi definido.
              ...(o.amountMicros !== null ? { amountMicros: String(o.amountMicros) } : {}),
              ...(o.totalAmountMicros !== null ? { totalAmountMicros: String(o.totalAmountMicros) } : {}),
              explicitlyShared: o.explicitlyShared,
              referenceCount: String(usando),
              period: o.period,
            },
          }
        : {}),
    };
  }

  /** A recusa de um pedido de criação, como o Google responde (o `GoogleAdsFailure` com o código e o texto). */
  private recusa(codigo: Record<string, string>, texto: string): Resposta {
    return this.erro(400, 'INVALID_ARGUMENT', 'Request contains an invalid argument.', { codigo, texto });
  }

  /**
   * A criação da Performance Max numa requisição (`googleAds:mutate`): confere cada operação, na ordem (o id provisório
   * só vale depois de criado na mesma requisição), e as regras da Performance Max no fim; a validação para aí. A de
   * verdade cria o orçamento, a campanha (pausada) e o grupo de recursos, e responde uma linha por operação.
   */
  private async criarPerformanceMax(chamada: ChamadaAoGoogle): Promise<Resposta> {
    const cliente = chamada.cliente;
    const ops = chamada.corpo.mutateOperations as Array<Record<string, { create?: Record<string, unknown> }>> | undefined;
    if (!Array.isArray(ops) || !ops.length) return this.recusa({ requestError: 'REQUIRED_FIELD_MISSING' }, 'The required field was not present.');
    type Recurso = { tipo: string; corpo: Record<string, unknown>; largura?: number; altura?: number };
    const criados = new Map<string, Recurso>();
    const provisorio = (nome: unknown, tipo: string) => typeof nome === 'string' && new RegExp(`^customers/${cliente}/${tipo}/-\\d+$`).test(nome);
    const existe = (nome: unknown, tipo: string) => typeof nome === 'string' && criados.get(nome)?.tipo === tipo;
    const naoAchou = () => this.recusa({ mutateError: 'RESOURCE_NOT_FOUND' }, 'Resource was not found.');
    let campanha: Record<string, unknown> | null = null;
    let grupo: Record<string, unknown> | null = null;
    const criterios: Record<string, unknown>[] = [];
    const daCampanha: { papel: string; asset: string }[] = [];
    const doGrupo: { papel: string; asset: string }[] = [];
    const respostas: Record<string, { resourceName: string }>[] = [];

    for (const op of ops) {
      const [chave, valor] = Object.entries(op)[0] ?? [];
      const c = valor?.create;
      if (!chave || !c || Object.keys(op).length !== 1) return this.recusa({ requestError: 'REQUIRED_FIELD_MISSING' }, 'The required field was not present.');
      if (chave === 'campaignBudgetOperation') {
        if (!provisorio(c.resourceName, 'campaignBudgets') || !/^\d+$/.test(String(c.amountMicros ?? '')) || c.explicitlyShared !== false || !c.name) {
          return this.recusa({ campaignBudgetError: 'INVALID_BUDGET' }, 'The budget is invalid.');
        }
        criados.set(String(c.resourceName), { tipo: 'campaignBudgets', corpo: c });
        respostas.push({ campaignBudgetResult: { resourceName: String(c.resourceName) } });
      } else if (chave === 'campaignOperation') {
        if (!provisorio(c.resourceName, 'campaigns') || !existe(c.campaignBudget, 'campaignBudgets')) return naoAchou();
        if (c.advertisingChannelType !== 'PERFORMANCE_MAX' || c.status !== 'PAUSED' || typeof c.maximizeConversions !== 'object') {
          return this.recusa({ campaignError: 'INVALID_CAMPAIGN' }, 'The campaign is invalid.');
        }
        if (!c.containsEuPoliticalAdvertising) return this.recusa({ campaignError: 'MISSING_EU_POLITICAL_ADVERTISING_SELF_DECLARATION' }, 'The EU political advertising declaration is missing.');
        if ([...this.campanhas.values()].some((x) => x.cliente === cliente && x.status !== 'REMOVED' && x.name === c.name)) {
          return this.recusa({ campaignError: 'DUPLICATE_CAMPAIGN_NAME' }, 'Campaign with the same name already exists.');
        }
        if (c.endDateTime !== undefined && !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(String(c.endDateTime))) return this.recusa({ dateError: 'INVALID_STRING_DATE_TIME_SECONDS' }, 'The string date time is invalid.');
        campanha = c;
        criados.set(String(c.resourceName), { tipo: 'campaigns', corpo: c });
        respostas.push({ campaignResult: { resourceName: String(c.resourceName) } });
      } else if (chave === 'campaignCriterionOperation') {
        if (!existe(c.campaign, 'campaigns')) return naoAchou();
        criterios.push(c);
        respostas.push({ campaignCriterionResult: { resourceName: `customers/${cliente}/campaignCriteria/${numero()}` } });
      } else if (chave === 'assetOperation') {
        if (!provisorio(c.resourceName, 'assets')) return naoAchou();
        const textAsset = c.textAsset as { text?: unknown } | undefined;
        const imageAsset = c.imageAsset as { data?: unknown } | undefined;
        if (textAsset && typeof textAsset.text === 'string' && textAsset.text) {
          criados.set(String(c.resourceName), { tipo: 'assets', corpo: c });
        } else if (imageAsset && typeof imageAsset.data === 'string') {
          let medidas: { width?: number; height?: number };
          try {
            medidas = await sharp(Buffer.from(imageAsset.data, 'base64'), { failOn: 'error' }).metadata();
          } catch {
            return this.recusa({ imageError: 'INVALID_IMAGE' }, 'The image is not valid.');
          }
          if (!c.name) return this.recusa({ assetError: 'REQUIRED_FIELD_MISSING' }, 'The asset name is missing.');
          criados.set(String(c.resourceName), { tipo: 'assets', corpo: c, largura: medidas.width ?? 0, altura: medidas.height ?? 0 });
        } else {
          return this.recusa({ assetError: 'ASSET_TYPE_NOT_SUPPORTED' }, 'The asset type is not supported.');
        }
        respostas.push({ assetResult: { resourceName: String(c.resourceName) } });
      } else if (chave === 'campaignAssetOperation') {
        if (!existe(c.campaign, 'campaigns') || !existe(c.asset, 'assets')) return naoAchou();
        daCampanha.push({ papel: String(c.fieldType), asset: String(c.asset) });
        respostas.push({ campaignAssetResult: { resourceName: `customers/${cliente}/campaignAssets/${numero()}` } });
      } else if (chave === 'assetGroupOperation') {
        if (!provisorio(c.resourceName, 'assetGroups') || !existe(c.campaign, 'campaigns')) return naoAchou();
        if (!Array.isArray(c.finalUrls) || !c.finalUrls.length || !c.name) return this.recusa({ assetGroupError: 'FINAL_URL_REQUIRED' }, 'The final URL is required.');
        grupo = c;
        criados.set(String(c.resourceName), { tipo: 'assetGroups', corpo: c });
        respostas.push({ assetGroupResult: { resourceName: String(c.resourceName) } });
      } else if (chave === 'assetGroupAssetOperation') {
        if (!existe(c.assetGroup, 'assetGroups') || !existe(c.asset, 'assets')) return naoAchou();
        doGrupo.push({ papel: String(c.fieldType), asset: String(c.asset) });
        respostas.push({ assetGroupAssetResult: { resourceName: `customers/${cliente}/assetGroupAssets/${numero()}` } });
      } else {
        return this.recusa({ requestError: 'UNKNOWN_OPERATION' }, `Unsupported operation ${chave}.`);
      }
    }

    // As regras da Performance Max, sobre o que a requisição inteira levou.
    if (!campanha || !grupo) return this.recusa({ assetGroupError: 'ASSET_GROUP_REQUIRED' }, 'A Performance Max campaign needs an asset group.');
    const recurso = (nome: string) => criados.get(nome)!;
    const texto = (nome: string) => (recurso(nome).corpo.textAsset as { text?: string } | undefined)?.text;
    const contar = (papel: string) => doGrupo.filter((d) => d.papel === papel);
    const faixas: [string, number, number, number | null][] = [
      ['HEADLINE', 3, 15, 30],
      ['LONG_HEADLINE', 1, 5, 90],
      ['DESCRIPTION', 2, 5, 90],
      ['MARKETING_IMAGE', 1, 20, null],
      ['SQUARE_MARKETING_IMAGE', 1, 20, null],
      ['PORTRAIT_MARKETING_IMAGE', 0, 20, null],
    ];
    for (const [papel, min, max, letras] of faixas) {
      const itens = contar(papel);
      if (itens.length < min || itens.length > max) return this.recusa({ assetGroupError: `NOT_ENOUGH_${papel}_ASSET` }, `Not enough ${papel} assets.`);
      if (letras && itens.some((d) => [...(texto(d.asset) ?? '')].length > letras)) return this.recusa({ assetError: 'TEXT_TOO_LONG' }, `A ${papel} is too long.`);
    }
    // A proporção de cada imagem (1% de folga) e o mínimo, como o Google confere ao ligar a imagem ao papel.
    const proporcao: Record<string, [number, number, number]> = {
      MARKETING_IMAGE: [1.91, 600, 314],
      SQUARE_MARKETING_IMAGE: [1, 300, 300],
      PORTRAIT_MARKETING_IMAGE: [0.8, 480, 600],
      LOGO: [1, 128, 128],
    };
    for (const d of [...doGrupo, ...daCampanha]) {
      const regra = proporcao[d.papel];
      if (!regra) continue;
      const { largura = 0, altura = 0 } = recurso(d.asset);
      if (!largura || Math.abs(largura / altura - regra[0]) / regra[0] > 0.01) return this.recusa({ assetLinkError: 'ASPECT_RATIO_NOT_ALLOWED' }, `The image aspect ratio is not allowed for ${d.papel}.`);
      if (largura < regra[1] || altura < regra[2]) return this.recusa({ imageError: 'IMAGE_TOO_SMALL' }, `The image is too small for ${d.papel}.`);
    }
    // As regras da marca: exatamente um nome da loja (texto, até 25) e ao menos uma logo, na campanha.
    if (campanha.brandGuidelinesEnabled === true) {
      const nomes = daCampanha.filter((d) => d.papel === 'BUSINESS_NAME');
      if (nomes.length !== 1 || [...(texto(nomes[0]!.asset) ?? '')].length > 25 || !daCampanha.some((d) => d.papel === 'LOGO')) {
        return this.recusa({ campaignError: 'BRAND_GUIDELINES_REQUIRED_ASSETS_MISSING' }, 'Brand guidelines require a business name and a logo on the campaign.');
      }
    }
    if (chamada.tipo === 'validacao') return { status: 200, corpo: {} };

    // A de verdade: tudo ou nada.
    const orcamento = this.novoOrcamento(cliente, { amountMicros: Number(recurso(String(campanha.campaignBudget)).corpo.amountMicros) });
    const nova = this.novaCampanha(cliente, { name: String(campanha.name), status: 'PAUSED', primaryStatus: 'PAUSED', orcamento: orcamento.id });
    const g: GrupoNoGoogle = {
      cliente,
      id: numero(),
      campanha: nova.id,
      finalUrls: grupo.finalUrls as string[],
      recursos: doGrupo.map((d) => ({ papel: d.papel, texto: texto(d.asset), largura: recurso(d.asset).largura, altura: recurso(d.asset).altura })),
    };
    this.grupos.set(g.id, g);
    this.criacoes.set(nova.id, {
      campanha: nova.id,
      corpoDaCampanha: campanha,
      criterios,
      daCampanha: daCampanha.map((d) => ({ papel: d.papel, texto: texto(d.asset), largura: recurso(d.asset).largura, altura: recurso(d.asset).altura })),
    });
    if (this.perderResposta.delete(cliente)) return this.erro(503, 'UNAVAILABLE', 'The service is currently unavailable.');
    const real: Record<string, string> = {
      [String(campanha.resourceName)]: `customers/${cliente}/campaigns/${nova.id}`,
      [String(campanha.campaignBudget)]: `customers/${cliente}/campaignBudgets/${orcamento.id}`,
      [String(grupo.resourceName)]: `customers/${cliente}/assetGroups/${g.id}`,
    };
    const resultado = respostas.map((r) => {
      const [campo, v] = Object.entries(r)[0]!;
      return { [campo]: { resourceName: real[v.resourceName] ?? v.resourceName.replace(/\/-\d+$/, `/${numero()}`) } };
    });
    return { status: 200, corpo: { mutateOperationResponses: resultado } };
  }

  private async responder(req: IncomingMessage, texto: string): Promise<Resposta> {
    const url = new URL(req.url ?? '/', this.base);
    if (url.pathname === '/oauth/token') {
      this.renovacoes += 1;
      const pedido = new URLSearchParams(texto);
      if (pedido.get('refresh_token') === REFRESH_REVOGADO) return { status: 400, corpo: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' } };
      return { status: 200, corpo: { access_token: ACESSO_DO_GOOGLE, expires_in: 3599, token_type: 'Bearer' } };
    }
    const m = url.pathname.match(/^\/ads\/v25\/customers\/(\d+)\/(googleAds:searchStream|googleAds:mutate|campaigns:mutate|campaignBudgets:mutate)$/);
    if (!m || req.method !== 'POST') return this.erro(404, 'NOT_FOUND', url.pathname);
    const cliente = m[1]!;
    const recurso = m[2]!.replace(/^googleAds:/, '').replace(/:mutate$/, '');
    const corpo = texto ? (JSON.parse(texto) as Record<string, unknown>) : {};
    const gerente = req.headers['login-customer-id'];
    const chamada: ChamadaAoGoogle = {
      tipo: recurso === 'searchStream' ? 'leitura' : corpo.validateOnly === true ? 'validacao' : 'escrita',
      cliente,
      recurso,
      corpo,
      autorizacao: req.headers.authorization,
      gerente: Array.isArray(gerente) ? gerente[0] : gerente,
    };
    this.chamadas.push(chamada);
    if (req.headers.authorization !== `Bearer ${ACESSO_DO_GOOGLE}`) return this.erro(401, 'UNAUTHENTICATED', 'Request had invalid authentication credentials.');
    const defeito = this.defeitos.get(cliente)?.(chamada);
    if (defeito) return defeito;

    if (recurso === 'mutate') return this.criarPerformanceMax(chamada);
    if (recurso === 'searchStream') {
      const consulta = String(corpo.query ?? '');
      // A procura da campanha criada pelo nome com a marca do Liame (Y9, parte 3), com o grupo de recursos dela.
      const criada = /^SELECT campaign\.id, campaign\.campaign_budget, asset_group\.id FROM asset_group WHERE campaign\.name LIKE '%(\(Liame [0-9a-f]{12}\))' AND campaign\.status != 'REMOVED'$/.exec(consulta);
      if (criada) {
        const linhas = [...this.grupos.values()]
          .filter((g) => g.cliente === cliente)
          .map((g) => ({ g, c: this.campanhas.get(g.campanha) }))
          .filter(({ c }) => c && c.name.endsWith(criada[1]!) && c.status !== 'REMOVED')
          .map(({ g, c }) => ({
            campaign: { resourceName: `customers/${cliente}/campaigns/${c!.id}`, id: c!.id, campaignBudget: `customers/${cliente}/campaignBudgets/${c!.orcamento}` },
            assetGroup: { resourceName: `customers/${cliente}/assetGroups/${g.id}`, id: g.id },
          }));
        return { status: 200, corpo: linhas.length ? [{ results: linhas, fieldMask: 'campaign.id,campaign.campaignBudget,assetGroup.id', requestId: 'leitura-de-teste' }] : [] };
      }
      // Com quem a verba é dividida: as campanhas do orçamento, menos a que perguntou e as removidas, pelo nome.
      const dividida = /^SELECT campaign\.id, campaign\.name FROM campaign WHERE campaign\.campaign_budget = 'customers\/(\d+)\/campaignBudgets\/(\d+)' AND campaign\.status != 'REMOVED' AND campaign\.id != (\d+) ORDER BY campaign\.name LIMIT (\d+)$/.exec(consulta);
      if (dividida) {
        const [, daConta, orcamento, menos, limite] = dividida;
        const outras = [...this.campanhas.values()]
          .filter((x) => daConta === cliente && x.cliente === cliente && x.orcamento === orcamento && x.status !== 'REMOVED' && x.id !== menos)
          .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'))
          .slice(0, Number(limite));
        return { status: 200, corpo: outras.length ? [{ results: outras.map((x) => ({ campaign: { resourceName: `customers/${cliente}/campaigns/${x.id}`, id: x.id, name: x.name } })), fieldMask: 'campaign.id,campaign.name', requestId: 'leitura-de-teste' }] : [] };
      }
      const id = /FROM campaign WHERE campaign\.id = (\d+)$/.exec(consulta)?.[1];
      if (!id) return this.erro(400, 'INVALID_ARGUMENT', 'Request contains an invalid argument.', { codigo: { queryError: 'UNRECOGNIZED_FIELD' }, texto: 'Error in query: unexpected input.' });
      const c = this.campanhas.get(id);
      // Sem linha, o searchStream devolve a lista de lotes vazia.
      return { status: 200, corpo: c && c.cliente === cliente ? [{ results: [this.linha(c)], fieldMask: 'campaign.id,campaign.name', requestId: 'leitura-de-teste' }] : [] };
    }

    const operacoes = corpo.operations as Array<{ updateMask?: string; update?: Record<string, unknown> }> | undefined;
    const op = operacoes?.[0];
    if (!Array.isArray(operacoes) || operacoes.length !== 1 || !op?.update || typeof op.update.resourceName !== 'string') {
      return this.erro(400, 'INVALID_ARGUMENT', 'Request contains an invalid argument.', { codigo: { requestError: 'REQUIRED_FIELD_MISSING' }, texto: 'The required field was not present.' });
    }
    const nome = op.update.resourceName;
    if (recurso === 'campaigns') {
      const c = this.campanhas.get(nome.match(new RegExp(`^customers/${cliente}/campaigns/(\\d+)$`))?.[1] ?? '');
      if (!c || c.cliente !== cliente) return this.erro(400, 'INVALID_ARGUMENT', 'Request contains an invalid argument.', { codigo: { mutateError: 'RESOURCE_NOT_FOUND' }, texto: 'Resource was not found.' });
      if (op.updateMask !== 'status' || (op.update.status !== 'ENABLED' && op.update.status !== 'PAUSED')) {
        return this.erro(400, 'INVALID_ARGUMENT', 'Request contains an invalid argument.', { codigo: { fieldMaskError: 'FIELD_NOT_FOUND' }, texto: 'The field mask contained an invalid field.' });
      }
      if (c.status === 'REMOVED') return this.erro(400, 'INVALID_ARGUMENT', 'Request contains an invalid argument.', { codigo: { campaignError: 'CANNOT_MODIFY_REMOVED_CAMPAIGN' }, texto: 'Cannot modify a removed campaign.' });
      if (chamada.tipo === 'validacao') return { status: 200, corpo: {} };
      c.status = op.update.status;
      c.primaryStatus = c.status === 'PAUSED' ? 'PAUSED' : 'ELIGIBLE';
      return { status: 200, corpo: { results: [{ resourceName: nome }] } };
    }
    const o = this.orcamentos.get(nome.match(new RegExp(`^customers/${cliente}/campaignBudgets/(\\d+)$`))?.[1] ?? '');
    if (!o || o.cliente !== cliente) return this.erro(400, 'INVALID_ARGUMENT', 'Request contains an invalid argument.', { codigo: { mutateError: 'RESOURCE_NOT_FOUND' }, texto: 'Resource was not found.' });
    // A máscara vai em snake_case; o campo, em camelCase.
    if (op.updateMask !== 'amount_micros' || !/^\d+$/.test(String(op.update.amountMicros ?? ''))) {
      return this.erro(400, 'INVALID_ARGUMENT', 'Request contains an invalid argument.', { codigo: { fieldMaskError: 'FIELD_NOT_FOUND' }, texto: 'The field mask contained an invalid field.' });
    }
    const valor = Number(op.update.amountMicros);
    if (valor > 5_000_000_000) return this.erro(400, 'INVALID_ARGUMENT', 'Request contains an invalid argument.', { codigo: { campaignBudgetError: 'MONEY_AMOUNT_TOO_LARGE' }, texto: 'A money amount was greater than the maximum allowed.' });
    if (chamada.tipo === 'validacao') return { status: 200, corpo: {} };
    o.amountMicros = valor;
    return { status: 200, corpo: { results: [{ resourceName: nome }] } };
  }
}

export type EmpresaComGoogle = { cookie: string; tenantId: string; userId: string; brandId: string; conta: string; cliente: string; gerente: string; /** O segredo do app autenticador do dono, para aprovar com o código. */ secret: string };

/** Uma empresa nova com uma conta do Google Ads conectada (em reais), com a autorização no cofre e o dono com o app autenticador. */
export async function empresaComGoogle(api: TestApi, database: Database, opcoes: { refresh?: string; nome?: string } = {}): Promise<EmpresaComGoogle> {
  await resetIpRateLimits();
  const s = await signupAndLogin(api, undefined, opcoes.nome ?? 'Hamburgueria do Google');
  const { secret } = await enableMfa(api, s.cookie);
  const tenantId = s.me.active_organization_id as string;
  const brandId = (await ownerQuery<{ id: string }>(`select id from liame.brand where tenant_id = $1 limit 1`, [tenantId]))[0]!.id;
  const conta = randomUUID();
  const [cliente, gerente] = [numero(), numero()];
  const segredo = await withTenant(database.db, tenantId, (tx) =>
    api.app.get(VaultService).putSecret(tx, {
      tenantId,
      purpose: 'oauth_google',
      plaintext: JSON.stringify({
        tipo: 'google',
        refresh_token: opcoes.refresh ?? REFRESH_DO_GOOGLE,
        escopos: ['https://www.googleapis.com/auth/adwords', 'https://www.googleapis.com/auth/analytics.readonly'],
        obtido_em: new Date().toISOString(),
        refresh_expira_em: null,
      }),
    }),
  );
  await ownerQuery(
    `insert into liame.connected_account (id, tenant_id, brand_id, provider, external_id, name, currency, timezone, credential_secret_id, provider_attributes)
     values ($1, $2, $3, 'google_ads', $4, 'Hamburgueria Ads', 'BRL', $5, $6, $7::jsonb)`,
    [conta, tenantId, brandId, cliente, FUSO, segredo, JSON.stringify({ login_customer_id: gerente })],
  );
  return { cookie: s.cookie, tenantId, userId: s.me.user.id as string, brandId, conta, cliente, gerente, secret };
}

/** Põe a campanha na lista que o Liame leu da conta (sem isso, o conector não a reconhece). */
export async function campanhaLida(e: EmpresaComGoogle, c: CampanhaNoGoogle, conta = e.conta): Promise<string> {
  const id = randomUUID();
  await ownerQuery(
    `insert into liame.campaign (id, tenant_id, connected_account_id, provider, external_id, name, status, last_seen_at)
     values ($1, $2, $3, 'google_ads', $4, $5, 'ativa', now() - interval '6 hours')`,
    [id, e.tenantId, conta, c.id, c.name],
  );
  return id;
}
