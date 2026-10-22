import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { contaConectada, estaConectada } from '../src/connections/conectada.js';

// "Ligada" e "conectada" (achado A2 do Hub DMS, decisão F2-5): o critério de agir é um só, em `connections/conectada.ts`.
// Este arquivo prova a regra e guarda a LISTA FECHADA dos lugares que ainda usam só "ligada" (`disconnected_at is null`):
// cada um diz por que basta mostrar (ou gerenciar) a conta. Um uso novo reprova aqui até alguém decidir: se ele AGE na
// plataforma (lê, escreve, cria cupom, monta link, manda mensagem), usa `contaConectada`; se só mostra, entra na lista
// com o motivo. A lista é a revisão.

describe('conta conectada: a regra', () => {
  it('ligada e sem o status do 401; qualquer outro status serve (ativa, erro, sem permissão)', () => {
    const ligadaEm = new Date('2026-10-01T12:00:00Z');
    expect(estaConectada({ disconnected_at: null, status: 'ativa' })).toBe(true);
    expect(estaConectada({ disconnected_at: null, status: 'erro' })).toBe(true);
    expect(estaConectada({ disconnected_at: null, status: 'sem_permissao' })).toBe(true);
    expect(estaConectada({ disconnected_at: null, status: 'desconectada' })).toBe(false);
    expect(estaConectada({ disconnected_at: ligadaEm, status: 'ativa' })).toBe(false);
    expect(estaConectada({ disconnected_at: ligadaEm.toISOString(), status: 'ativa' })).toBe(false);
  });

  it('a mesma regra em SQL, pelo apelido da tabela; apelido que não é identificador simples é recusado', () => {
    const texto = new PgDialect().sqlToQuery(contaConectada('a')).sql;
    expect(texto).toBe(`(a.disconnected_at is null and a.status <> 'desconectada')`);
    expect(new PgDialect().sqlToQuery(contaConectada('conta_2')).sql).toContain('conta_2.status');
    for (const ruim of ['a; drop table x', 'A', '1a', 'a.b', '', 'a b']) expect(() => contaConectada(ruim)).toThrow('apelido de tabela inválido');
  });
});

// ------------------------------------------------------------------ a lista fechada

const SRC = resolve(process.cwd(), 'src');
const LIGADA = /disconnected_at\s+is\s+null/g;

const MOSTRA = 'mostra a conta ligada (lista, aviso, relatório ou conferência do que já existe), com o status';
const GERENCIA = 'gerencia a própria ligação (ligar, desligar, reconectar): é o "ligada" de verdade';
const SINCRONIZA = 'o sincronizador acha a conta que o laço reservou (o laço já conferiu "conectada") e grava o 401 sem tirá-la da lista';
const ACHA_E_CONFERE = 'acha a conta ligada; a decisão de agir é `contaConectada` na mesma consulta (sem token, quem chama diz "conecte de novo")';
const PENDENTE = 'PENDENTE (Meta e Google): age na plataforma com "ligada"; a plataforma recusa com 401 e a pessoa vê "conecte de novo". Migrar para `contaConectada` no próximo passo do achado A2';

/** Arquivo (a partir de `src/`) → quantos usos de "ligada" e por quê. */
const LISTA: Record<string, { usos: number; porque: string }> = {
  'connections/conectada.ts': { usos: 2, porque: 'a definição de "conectada" (a primeira parte dela é "ligada") e o comentário que explica a reconexão' },
  'actions/action.service.ts': { usos: 1, porque: 'a marca do pedido: de quem é a conta, não se ela pode agir (o conector confere na hora)' },
  'actions/regemcast-mensagem.ts': { usos: 1, porque: ACHA_E_CONFERE },
  'mensageria/conta-do-regemcast.ts': { usos: 1, porque: ACHA_E_CONFERE },
  'mensageria/mensageria.service.ts': { usos: 1, porque: ACHA_E_CONFERE },
  'mensageria/pedido-de-mensagem.service.ts': { usos: 1, porque: ACHA_E_CONFERE },
  'mensageria/desconto.service.ts': { usos: 1, porque: 'lista as lojas ligadas; "pode criar" e "conectada" na tela usam `contaConectada`' },
  'coupons/coupons.service.ts': {
    usos: 6,
    porque: `${MOSTRA}; "pode criar" usa \`contaConectada\`; o cupom de outra plataforma e a plataforma de pedidos são registros do Liame (criar no Regem exige conectada)`,
  },
  'links/links.service.ts': { usos: 4, porque: `${MOSTRA}: as campanhas da tela, a conferência dos anúncios que já existem e quando cada conta foi lida (o link novo exige conectada)` },
  // O oitavo (Hub DMS, F3, parte C): ligar as lojas acha a loja do Regem ligada por outra autorização, para tirar do cofre
  // a ligação da troca automática do `rgm_it_` de antes.
  'connections/connections.service.ts': { usos: 8, porque: GERENCIA },
  'worker/conexao-processor.ts': { usos: 1, porque: GERENCIA },
  'worker/vendas-loop.ts': { usos: 1, porque: 'o aviso que chega do Regem acha a loja ligada; a leitura que ele dispara passa pelo laço, que confere "conectada"' },
  'worker/rotina-do-crm-loop.ts': { usos: 1, porque: 'inscreve a marca na fila uma vez; cada olhada confere a conta conectada (`lerContaDoRegemcast`)' },
  'attribution/sincronizador-conversas.ts': { usos: 2, porque: SINCRONIZA },
  'orders/sincronizador-vendas.ts': { usos: 3, porque: SINCRONIZA },
  'media/sincronizador.ts': { usos: 2, porque: SINCRONIZA },
  'avaliacoes/sincronizador-do-perfil.ts': { usos: 2, porque: SINCRONIZA },
  'buscas/sincronizador-das-buscas.ts': { usos: 2, porque: SINCRONIZA },
  'results/atencao-ciclo.service.ts': { usos: 12, porque: `${MOSTRA}: os avisos de Atenção, inclusive o de conta desconectada` },
  'results/results.service.ts': { usos: 2, porque: MOSTRA },
  'resumo/resumo.service.ts': { usos: 1, porque: MOSTRA },
  'media/media.service.ts': { usos: 4, porque: MOSTRA },
  'avaliacoes/avaliacoes.service.ts': { usos: 2, porque: `${MOSTRA} (responder exige o status ativa, que é mais que conectada)` },
  'avaliacoes/avisos-do-perfil.ts': { usos: 2, porque: MOSTRA },
  'worker/revisao-semanal-loop.ts': { usos: 1, porque: `${MOSTRA}: a revisão da semana por e-mail` },
  'worker/relatorio-mensal-loop.ts': { usos: 1, porque: `${MOSTRA}: o relatório do mês, lido do que já está guardado, na tela e por e-mail` },
  'actions/budget.service.ts': { usos: 3, porque: PENDENTE },
  'actions/google-anuncios.ts': { usos: 1, porque: PENDENTE },
  'actions/meta-anuncios.ts': { usos: 1, porque: PENDENTE },
  'actions/opcoes-do-pedido.service.ts': { usos: 2, porque: PENDENTE },
  'actions/perfil-avaliacao.ts': { usos: 1, porque: PENDENTE },
  'autonomia/autonomia.service.ts': { usos: 1, porque: PENDENTE },
  'conversoes/conversoes-google.ts': { usos: 1, porque: PENDENTE },
  'conversoes/conversoes.service.ts': { usos: 3, porque: PENDENTE },
  'results/desempenho.service.ts': { usos: 1, porque: PENDENTE },
  'worker/autonomia-propostas.ts': { usos: 2, porque: PENDENTE },
  'worker/conferencia-do-gasto.ts': { usos: 1, porque: PENDENTE },
  'worker/conversoes-loop.ts': { usos: 1, porque: PENDENTE },
  'worker/estrategista-agenda.ts': { usos: 1, porque: PENDENTE },
  'worker/pedidos-do-gestor.ts': { usos: 1, porque: PENDENTE },
  'worker/sombra-loop.ts': { usos: 1, porque: PENDENTE },
  'worker/sombra.service.ts': { usos: 1, porque: PENDENTE },
};

function usosNoCodigo(): Record<string, number> {
  if (!existsSync(SRC)) throw new Error(`não achei ${SRC}`);
  const usos: Record<string, number> = {};
  for (const nome of readdirSync(SRC, { recursive: true, encoding: 'utf8' })) {
    const caminho = nome.replaceAll('\\', '/');
    if (!caminho.endsWith('.ts')) continue;
    const n = (readFileSync(join(SRC, caminho), 'utf8').match(LIGADA) ?? []).length;
    if (n) usos[caminho] = n;
  }
  return usos;
}

describe('conta conectada: a lista fechada de quem ainda usa só "ligada"', () => {
  it('cada uso de `disconnected_at is null` no servidor está na lista, com o motivo, na quantidade certa', () => {
    const noCodigo = usosNoCodigo();
    const esperado = Object.fromEntries(Object.entries(LISTA).map(([arquivo, { usos }]) => [arquivo, usos]));
    expect(noCodigo).toEqual(esperado);
  });

  it('todo motivo está escrito', () => {
    for (const [arquivo, { porque }] of Object.entries(LISTA)) expect(porque.length, arquivo).toBeGreaterThan(20);
  });
});
