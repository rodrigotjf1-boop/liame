import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { HttpException, Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../src/app.module.js';
import type { AppConfig } from '../src/config.js';
import { buscarSoNoHub, erroDaRequisicao, erroDoLaco, HubDms, MODO_DO_HUB } from '../src/connectors/dms/hub.js';
import { APP_VERSION } from '../src/version.js';
import { EventsLoopService } from '../src/worker/events-loop.service.js';
import { WorkerModule } from '../src/worker/worker.module.js';

/**
 * O hub da DMS do lado do Liame (Hub DMS, A4, etapa 3), contra um DMS ID e um hub de mentira por HTTP: desligado não
 * chama ninguém; no worker, pede o token do aplicativo do Liame, bate com a versão e lê a lista quando o hub diz que
 * mudou; na API, só manda os erros, de 5 em 5 segundos; os erros saem limpos de dado pessoal.
 */

type Pedido = { caminho: string; cabecalhos: IncomingMessage['headers']; corpo: string };
type Falsos = { servidor: Server; base: string; pedidos: Pedido[] };

const VALOR_DO_APLICATIVO = 'valor-do-aplicativo-de-teste-0123456789';
const RECURSO = 'https://hub.exemplo.test/api/v1';

async function subirFalsos(): Promise<Falsos> {
  const pedidos: Pedido[] = [];
  const servidor = createServer((req, res) => {
    let corpo = '';
    req.on('data', (d: Buffer) => {
      corpo += d.toString('utf8');
    });
    req.on('end', () => {
      pedidos.push({ caminho: req.url ?? '', cabecalhos: req.headers, corpo });
      const responder = (status: number, json: unknown) => {
        res.statusCode = status;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(json));
      };
      if (req.url === '/oidc/token') return responder(200, { access_token: 'acesso-de-teste-do-hub', expires_in: 3600, token_type: 'Bearer' });
      if (req.url === '/api/v1/batida') return responder(200, { parada_versao: 2 });
      if (req.url === '/api/v1/parada') return responder(200, { versao: 2, itens: [{ nivel: 'aplicativo', produto: null, alvo: 'liame' }] });
      if (req.url === '/api/v1/erros') return responder(202, { recebidos: 1, contados: 1, grupos: [] });
      if (req.url === '/api/v1/redireciona') {
        res.statusCode = 302;
        res.setHeader('location', '/api/v1/batida');
        return res.end();
      }
      return responder(404, {});
    });
  });
  await new Promise<void>((pronto) => servidor.listen(0, '127.0.0.1', pronto));
  return { servidor, base: `http://127.0.0.1:${(servidor.address() as AddressInfo).port}`, pedidos };
}

function configDe(f: Falsos, ligado = true): AppConfig {
  return {
    dmsId: { emissor: `${f.base}/oidc`, aplicativo: 'aplicativo-do-liame', segredo: VALOR_DO_APLICATIVO },
    hub: ligado ? { url: f.base, recurso: RECURSO } : null,
  } as unknown as AppConfig;
}

async function esperar(condicao: () => boolean, ms = 3000): Promise<void> {
  const fim = Date.now() + ms;
  while (!condicao()) {
    if (Date.now() > fim) throw new Error('não aconteceu a tempo');
    await new Promise((pronto) => setTimeout(pronto, 10));
  }
}

const caminhos = (f: Falsos) => f.pedidos.map((p) => p.caminho);

describe('HubDms', () => {
  let f: Falsos;
  beforeEach(async () => {
    f = await subirFalsos();
  });
  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await new Promise((fim) => f.servidor.close(fim));
  });

  it('desligado (sem HUB_LIGADO): não chama ninguém, e anotar um erro não faz nada', async () => {
    const hub = new HubDms(configDe(f, false), 'worker');
    hub.onModuleInit();
    expect(hub.ligado).toBe(false);
    hub.erro({ origem: 'backend', tipo: 'Error', mensagem: 'x', lugar: 'y' });
    await hub.onApplicationShutdown();
    expect(f.pedidos).toEqual([]);
  });

  it('no worker: pede o token do aplicativo do Liame (o recurso do hub e as duas permissões), bate com a versão e lê a lista', async () => {
    const hub = new HubDms(configDe(f), 'worker');
    hub.onModuleInit();
    try {
      await esperar(() => caminhos(f).includes('/api/v1/parada'));
      const token = f.pedidos.find((p) => p.caminho === '/oidc/token')!;
      expect(token.cabecalhos.authorization).toBe(`Basic ${Buffer.from(`aplicativo-do-liame:${VALOR_DO_APLICATIVO}`).toString('base64')}`);
      const pedido = new URLSearchParams(token.corpo);
      expect([pedido.get('grant_type'), pedido.get('resource'), pedido.get('scope')]).toEqual(['client_credentials', RECURSO, 'registro.enviar parada.ler']);
      const batida = f.pedidos.find((p) => p.caminho === '/api/v1/batida')!;
      expect(batida.cabecalhos.authorization).toBe('Bearer acesso-de-teste-do-hub');
      const corpo = JSON.parse(batida.corpo) as Record<string, unknown>;
      expect(corpo).toMatchObject({ versao: APP_VERSION, iniciado_em: expect.any(String) });
      // O Liame não recebe chamada de outro produto: não tem a chave própria "aceitar integrações" para mandar.
      expect(corpo).not.toHaveProperty('aceita_integracoes');
    } finally {
      await hub.onApplicationShutdown();
    }
  });

  it('no worker, o desligamento manda os erros que estavam na fila, limpos de dado pessoal', async () => {
    const hub = new HubDms(configDe(f), 'worker');
    hub.onModuleInit();
    const telefone = ['(21) 9', '0000', '-0000'].join('');
    hub.erro(erroDoLaco('sincronizacao', new Error(`a plataforma recusou ${telefone} e fulano@exemplo.test`)));
    await hub.onApplicationShutdown();
    const erros = JSON.parse(f.pedidos.find((p) => p.caminho === '/api/v1/erros')!.corpo) as { erros: Array<Record<string, unknown>> };
    expect(erros.erros).toHaveLength(1);
    expect(erros.erros[0]).toMatchObject({
      origem: 'rotina',
      tipo: 'Error',
      mensagem: 'a plataforma recusou <telefone> e <e-mail>',
      lugar: 'laço sincronizacao',
      versao: APP_VERSION,
      quantidade: 1,
    });
  });

  it('na API: não bate nem lê a lista; manda os erros de 5 em 5 segundos', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const hub = new HubDms(configDe(f), 'api');
    hub.onModuleInit();
    try {
      hub.erro(erroDaRequisicao(new TypeError('falhou ao montar'), { status: 500, code: 'interno' }, 'GET', '/v1/marcas', 'a'.repeat(32)));
      expect(f.pedidos).toEqual([]);
      vi.advanceTimersByTime(5_000);
      await esperar(() => caminhos(f).includes('/api/v1/erros'));
      expect(caminhos(f)).not.toContain('/api/v1/batida');
      expect(caminhos(f)).not.toContain('/api/v1/parada');
      const erros = JSON.parse(f.pedidos.find((p) => p.caminho === '/api/v1/erros')!.corpo) as { erros: Array<Record<string, unknown>> };
      expect(erros.erros[0]).toMatchObject({ origem: 'backend', tipo: 'TypeError', lugar: 'GET /v1/marcas', codigo: 'a'.repeat(32) });
    } finally {
      await hub.onApplicationShutdown();
    }
  });

  it('o fetch do cliente só vai às rotas do hub e não segue redirecionamento', async () => {
    const buscar = buscarSoNoHub(f.base);
    await expect(buscar('https://outro.exemplo.test/api/v1/erros')).rejects.toThrow('endereço fora do hub');
    await expect(buscar(`${f.base}/oidc/token`)).rejects.toThrow('endereço fora do hub');
    await expect(buscar(`${f.base}/api/v1/redireciona`)).rejects.toThrow();
    expect((await buscar(`${f.base}/api/v1/batida`, { method: 'POST', body: '{}' })).status).toBe(200);
  });

  it('a falha do hub vira aviso no log, sem repetir o mesmo motivo a cada volta', () => {
    const aviso = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const hub = new HubDms(configDe(f), 'worker') as unknown as { avisar(motivo: string): void };
    hub.avisar('sem resposta do hub na batida');
    hub.avisar('sem resposta do hub na batida');
    hub.avisar('o hub respondeu 503 em /api/v1/erros');
    expect(aviso).toHaveBeenCalledTimes(2);
  });
});

describe('o erro na forma do hub', () => {
  it('a requisição 5xx: o nome do erro, ou o status e o código do problema; o lugar é o método e o caminho; o código é o trace_id', () => {
    expect(erroDaRequisicao(new TypeError('x de undefined'), { status: 500, code: 'interno' }, 'POST', '/v1/acoes', 'b'.repeat(32))).toEqual({
      origem: 'backend',
      tipo: 'TypeError',
      mensagem: 'x de undefined',
      lugar: 'POST /v1/acoes',
      codigo: 'b'.repeat(32),
    });
    expect(erroDaRequisicao(new HttpException('a Meta não respondeu', 502), { status: 502, code: 'dependencia-indisponivel' }, 'GET', '/v1/resultados', 'c'.repeat(32)).tipo).toBe(
      'HTTP 502 dependencia-indisponivel',
    );
    expect(erroDaRequisicao('texto solto', { status: 500, code: 'interno' }, 'GET', '/v1/x', 'd'.repeat(32)).tipo).toBe('Erro');
  });

  it('a falha de um laço do worker: rotina, o nome do erro e o laço', () => {
    expect(erroDoLaco('vendas', new RangeError('fora da faixa'))).toEqual({ origem: 'rotina', tipo: 'RangeError', mensagem: 'fora da faixa', lugar: 'laço vendas' });
    expect(erroDoLaco('vendas', 'texto solto')).toEqual({ origem: 'rotina', tipo: 'Erro', mensagem: 'texto solto', lugar: 'laço vendas' });
  });

  it('o laço do worker que cai registra no log e manda a falha ao hub, e segue', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const hub = { erro: vi.fn() };
    // Os laços não rodam aqui: só o hub importa, e ele é o último parâmetro.
    const laco = Reflect.construct(EventsLoopService, [...Array.from({ length: EventsLoopService.length - 1 }, () => ({})), hub]) as unknown as {
      stopped: boolean;
      loop(nome: string, lote: number, esperaMs: number, rodar: () => Promise<number>): Promise<void>;
    };
    await laco.loop('vendas', 1, 1, () => {
      laco.stopped = true;
      return Promise.reject(new Error('o banco caiu'));
    });
    expect(hub.erro).toHaveBeenCalledWith({ origem: 'rotina', tipo: 'Error', mensagem: 'o banco caiu', lugar: 'laço vendas' });
    vi.restoreAllMocks();
  });

  it('o worker é quem bate: o módulo do worker dá o papel "worker" ao HubDms; a API fica no padrão (só os erros)', () => {
    type Provedor = { provide?: unknown; useValue?: unknown };
    const doWorker = (Reflect.getMetadata('providers', WorkerModule) as Provedor[]).find((p) => p.provide === MODO_DO_HUB);
    expect(doWorker?.useValue).toBe('worker');
    expect(Reflect.getMetadata('providers', WorkerModule) as unknown[]).toContain(HubDms);
    const daApi = Reflect.getMetadata('providers', AppModule) as Provedor[];
    expect(daApi).toContain(HubDms);
    expect(daApi.some((p) => p.provide === MODO_DO_HUB)).toBe(false);
  });
});
