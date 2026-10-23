import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { tetoDoDia, tetoDoMes } from '../src/cobranca/franquia.js';
import { VIVAS_PAGAS } from '../src/cobranca/vida.js';

// A7 · W1, parte 2: a franquia de IA dos planos como o teto da empresa (D-A7-26). Este arquivo prova o formato do teto
// em SQL (o da distribuição, senão a soma das franquias das assinaturas pagas e vivas, senão o padrão) e guarda a LISTA
// FECHADA dos leitores do teto: todo lugar que lê `ai_budget` lê o teto por `tetoDoDia`/`tetoDoMes`, e nenhum escreve o
// `coalesce` à mão. Um leitor novo reprova aqui até usar os pedaços de `cobranca/franquia.ts` e entrar na lista.

describe('a franquia de IA como o teto da empresa: o SQL', () => {
  const dialeto = new PgDialect();

  it('o teto do dia: a linha da distribuição, a soma das franquias das assinaturas pagas e vivas da empresa, o padrão', () => {
    const q = dialeto.sqlToQuery(tetoDoDia(2_000_000));
    const texto = q.sql.replace(/\s+/g, ' ');
    expect(texto).toBe(
      'coalesce(b.daily_usd_micros, ( select sum(p.ai_daily_usd_micros) from liame.subscription s join liame.billing_plan p on p.id = s.plan_id where s.tenant_id = o.id and s.status in ($1, $2, $3, $4)), $5)::text',
    );
    expect(q.params).toEqual(['ativa', 'em_atraso', 'acoes_paradas', 'suspensa', 2_000_000]);
  });

  it('o teto do mês: o mesmo, pelas colunas do mês', () => {
    const q = dialeto.sqlToQuery(tetoDoMes(20_000_000));
    const texto = q.sql.replace(/\s+/g, ' ');
    expect(texto).toContain('coalesce(b.monthly_usd_micros, ( select sum(p.ai_monthly_usd_micros) from liame.subscription s');
    expect(q.params).toEqual(['ativa', 'em_atraso', 'acoes_paradas', 'suspensa', 20_000_000]);
  });

  it('as situações que contam são as da assinatura paga e viva: nem a que espera o primeiro pagamento, nem a encerrada', () => {
    expect([...VIVAS_PAGAS]).toEqual(['ativa', 'em_atraso', 'acoes_paradas', 'suspensa']);
    expect(VIVAS_PAGAS).not.toContain('aguardando_pagamento');
    expect(VIVAS_PAGAS).not.toContain('encerrada');
  });
});

// ------------------------------------------------------------------ a lista fechada

const SRC = resolve(process.cwd(), 'src');

/** Arquivo (a partir de `src/`) → quantas leituras do teto do dia e do mês, e o que lê. */
const LEITORES: Record<string, { dia: number; mes: number; porque: string }> = {
  'ai/gateway.ts': { dia: 1, mes: 1, porque: 'o AI Gateway confere o teto em toda chamada (barra, ou passa ao modelo econômico a partir de 80%)' },
  'ai/uso.ts': { dia: 1, mes: 1, porque: 'o uso para quem pergunta ANTES de pedir (o Criativo, as sugestões, a conversa)' },
  'equipe/equipe.service.ts': { dia: 1, mes: 2, porque: 'Sua equipe (o mês corrente, com o teto do dia e do mês) e a equipe do relatório do mês fechado (só o mês)' },
};

function arquivos(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const caminho = join(dir, e.name);
    if (e.isDirectory()) return arquivos(caminho);
    return e.name.endsWith('.ts') ? [caminho] : [];
  });
}

const contar = (texto: string, trecho: string): number => texto.split(trecho).length - 1;

describe('a franquia de IA como o teto da empresa: os leitores do teto (lista fechada)', () => {
  const lidos = arquivos(SRC).map((caminho) => ({ nome: relative(SRC, caminho).replaceAll('\\', '/'), texto: readFileSync(caminho, 'utf8') }));

  it('todo arquivo que junta `ai_budget` à empresa está na lista, com as leituras do teto pelos pedaços de `franquia.ts`', () => {
    const encontrados: Record<string, { dia: number; mes: number }> = {};
    for (const { nome, texto } of lidos) {
      if (nome === 'cobranca/franquia.ts' || !texto.includes('left join liame.ai_budget b')) continue;
      encontrados[nome] = { dia: contar(texto, 'tetoDoDia('), mes: contar(texto, 'tetoDoMes(') };
    }
    const esperados = Object.fromEntries(Object.entries(LEITORES).map(([nome, l]) => [nome, { dia: l.dia, mes: l.mes }]));
    expect(encontrados).toEqual(esperados);
  });

  it('ninguém escreve o teto à mão: o `coalesce` da linha da distribuição só existe em `franquia.ts`', () => {
    const fora = lidos
      .filter(({ nome }) => nome !== 'cobranca/franquia.ts')
      .filter(({ texto }) => texto.includes('coalesce(b.daily_usd_micros') || texto.includes('coalesce(b.monthly_usd_micros'))
      .map(({ nome }) => nome);
    expect(fora).toEqual([]);
  });
});
