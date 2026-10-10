import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { COMO_PEDIR, MOTIVOS_DA_MENSAGEM } from '../src/ai/crm/mensagem.js';
import { EM_ANDAMENTO, ehCodigo, podeIrPara, propostaAcabou, SITUACOES_DA_PROPOSTA } from '../src/mensageria/proposta-do-crm.js';

// A5 · Y6: o caminho da proposta de mensagem do funcionário de CRM e mensageria, sem banco. As situações e os passos
// do código são os mesmos que a migration 0062 aceita: o teste lê o arquivo dela.

const migration = readFileSync(resolve(process.cwd(), '../../packages/database/migrations/0062_proposta_do_crm.sql'), 'utf8');
const lista = (valores: readonly string[]) => valores.map((v) => `'${v}'`).join(', ');

describe('a proposta de mensagem do CRM e mensageria: o caminho (A5, Y6)', () => {
  it('de "preparando" ela vira rascunho, é barrada, descartada ou falha; do rascunho, vira pedido, é descartada ou falha', () => {
    const para = (de: (typeof SITUACOES_DA_PROPOSTA)[number]) => SITUACOES_DA_PROPOSTA.filter((s) => podeIrPara(de, s));
    expect(para('preparando')).toEqual(['rascunho', 'barrada', 'descartada', 'falhou']);
    expect(para('rascunho')).toEqual(['pedido', 'descartada', 'falhou']);
    // Sem o rascunho do modelo no RegemCast não há pedido de envio: a Meta só aprova o que uma pessoa enviou.
    expect(podeIrPara('preparando', 'pedido')).toBe(false);
    // A conferência é antes do rascunho: o que já foi para o RegemCast não é mais barrado.
    expect(podeIrPara('rascunho', 'barrada')).toBe(false);
  });

  it('a que acabou não anda mais, nem volta', () => {
    for (const fim of ['pedido', 'barrada', 'descartada', 'falhou'] as const) {
      expect(propostaAcabou(fim)).toBe(true);
      expect(SITUACOES_DA_PROPOSTA.filter((s) => podeIrPara(fim, s))).toEqual([]);
    }
    expect(SITUACOES_DA_PROPOSTA.filter((s) => !propostaAcabou(s))).toEqual(['preparando', 'rascunho']);
    expect(EM_ANDAMENTO).toEqual(['preparando', 'rascunho']);
    // Ninguém passa para a situação em que já está.
    for (const s of SITUACOES_DA_PROPOSTA) expect(podeIrPara(s, s)).toBe(false);
  });

  it('o porquê e o que barrou são códigos: letras minúsculas e sublinhado, de 2 a 40, como o banco confere', () => {
    for (const bom of ['prazo', 'modelo_recusado', 'ia_fora_do_ar', 'regras_da_liame', 'ab', 'a'.repeat(40)]) expect(ehCodigo(bom), bom).toBe(true);
    // Nem texto livre (que poderia ser o trecho barrado), nem vazio, nem comprido demais, nem com número ou acento.
    for (const ruim of ['', 'a', 'a'.repeat(41), 'Prazo', 'prometeu 50% de desconto', 'regra-da-marca', 'regra2', 'política', 'oferta,cupom']) expect(ehCodigo(ruim), ruim).toBe(false);
    // O mesmo formato está no banco, para o motivo; o que barrou tem as mesmas letras (e a vírgula que separa os itens).
    expect(migration).toContain(`check (reason ~ '^[a-z_]{2,40}$')`);
    expect(migration).toContain(`array_to_string(barred_by, ',') ~ '^[a-z_,]+$'`);
  });

  it('as situações, os motivos e o jeito de pedir do código são os que o banco aceita', () => {
    expect(migration).toContain(`check (status in (${lista(SITUACOES_DA_PROPOSTA)}))`);
    expect(migration).toContain(`check (motive in (${lista(MOTIVOS_DA_MENSAGEM)}))`);
    expect(migration).toContain(`check (destination in (${lista(COMO_PEDIR)}))`);
    // "Uma em andamento por marca e por motivo" vale para as mesmas situações nos dois lados.
    expect(migration).toContain(`on liame.message_proposal (brand_id, motive) where status in (${lista(EM_ANDAMENTO)})`);
    // E quem acabou tem a hora em que acabou.
    expect(migration).toContain(`(finished_at is not null) = (status in (${lista(SITUACOES_DA_PROPOSTA.filter(propostaAcabou))}))`);
  });
});
