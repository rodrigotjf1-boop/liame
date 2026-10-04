// Dá nota de novo a uma saída já gravada do promptfoo, com o avaliador do servidor compilado de AGORA, sem chamar o
// modelo. Serve para ver o efeito de uma mudança na régua ou nos casos sem gastar; mudou o prompt, é rodar de novo.
// Uso: node evals/apoio/renota.mjs <tarefa> <saida.json> [--limiar 0.95]
import { readFileSync } from 'node:fs';
import { casosDa, servidor, tarefaDe } from './servidor.mjs';

const args = process.argv.slice(2);
const [nome, arquivo] = args;
if (!nome || !arquivo) {
  console.error('uso: node evals/apoio/renota.mjs <tarefa> <saida.json> [--limiar 0.95]');
  process.exit(2);
}
const limiar = Number(args.includes('--limiar') ? args[args.indexOf('--limiar') + 1] : '0.95');
if (!(limiar > 0 && limiar <= 1)) {
  console.error('renota: --limiar entre 0 e 1');
  process.exit(2);
}

const { portao, resumir } = await servidor();
const tarefa = await tarefaDe(nome);
const casos = await casosDa(nome);
const linhas = JSON.parse(readFileSync(arquivo, 'utf8')).results?.results ?? [];
if (!linhas.length) {
  console.error('renota: a saída do eval não tem resultado nenhum');
  process.exit(1);
}

const resultados = [];
for (const r of linhas) {
  const id = String(r.vars?.id);
  const caso = casos.find((c) => c.id === id);
  // Caso que saiu do arquivo desde a rodada não entra na nota.
  if (!caso) {
    console.log(`  (o caso ${id} não existe mais)`);
    continue;
  }
  const saida = r.response?.output;
  const avaliacao = saida === undefined ? { ok: false, falhas: [`chamada falhou: ${r.error ?? 'sem saída'}`] } : tarefa.avaliar(caso, saida);
  resultados.push({ caso: { id: caso.id, grupo: caso.grupo }, avaliacao });
}

const resumo = resumir(resultados);
const motivos = portao(resumo, limiar);
console.log(`nota com a régua de agora: ${resumo.nota} (${resumo.aprovados} de ${resumo.total}); limiar ${limiar}`);
for (const [grupo, g] of Object.entries(resumo.porGrupo)) console.log(`  ${grupo}: ${g.aprovados} de ${g.total}`);
for (const r of resumo.reprovados) console.log(`  reprovado ${r.id}: ${r.falhas.join('; ')}`);
if (motivos.length) {
  console.error(`REPROVADO: ${motivos.join('; ')}`);
  process.exit(1);
}
console.log('APROVADO');
