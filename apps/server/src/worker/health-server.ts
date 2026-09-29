import { createServer, type Server } from 'node:http';

/**
 * Sonda de vida do worker. A imagem é a mesma da API, e o HEALTHCHECK dela pergunta `/health` na porta do
 * processo; sem isto, o contêiner do worker ficaria "unhealthy" e o orquestrador (Swarm, no EasyPanel) o
 * reiniciaria em ciclo. Só no 127.0.0.1 do contêiner: não é um endpoint público.
 */
export function startWorkerHealth(port: number, version: string, host = '127.0.0.1'): Promise<Server> {
  const body = JSON.stringify({ status: 'ok', service: 'liame-worker', version });
  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(body);
      return;
    }
    res.writeHead(404).end();
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(server));
  });
}
