import { describe, expect, it } from 'vitest';
import { motivoParaNaoZerar, ResetError, resetTestDatabase } from '../src/reset-test.js';

// O comando que zera o banco de teste local (`pnpm db:reset:test`) é destrutivo: a trava dele é o que impede zerar o
// banco errado. Aqui só a trava; o comando inteiro não roda na suíte (ele apagaria o banco que os outros testes usam).

describe('zerar o banco de teste: só em host local e em banco terminado em _test', () => {
  it('aceita o banco de teste local, por nome ou por endereço', () => {
    expect(motivoParaNaoZerar('postgresql://liame_owner:senha@localhost:5432/liame_test')).toBeNull();
    expect(motivoParaNaoZerar('postgresql://liame_owner:senha@127.0.0.1/liame_test')).toBeNull();
    expect(motivoParaNaoZerar('postgresql://liame_owner:senha@[::1]:5432/liame_test')).toBeNull();
  });

  it('recusa o banco de desenvolvimento, o postgres e qualquer nome que não termine em _test', () => {
    for (const banco of ['liame_dev', 'postgres', 'liame', 'liame_test_copia', 'test', 'Liame_test', '']) {
      expect(motivoParaNaoZerar(`postgresql://liame_owner:senha@localhost:5432/${banco}`), banco).toContain('não termina em _test');
    }
  });

  it('recusa host que não é local, mesmo com o nome de teste (a nuvem nunca é zerada por aqui)', () => {
    for (const host of ['aws-0-sa-east-1.pooler.supabase.com', 'db.exemplo.supabase.co', '10.0.0.5', 'localhost.exemplo.com', 'meu-servidor']) {
      expect(motivoParaNaoZerar(`postgresql://liame_owner:senha@${host}:5432/liame_test`), host).toContain('não é local');
    }
  });

  it('recusa o que não é URL, e a mensagem não repete o que foi passado', () => {
    expect(motivoParaNaoZerar('liame_test')).toBe('a URL do banco não é válida');
    expect(motivoParaNaoZerar('')).toBe('a URL do banco não é válida');
  });

  it('o comando para na trava, sem conectar em lugar nenhum', async () => {
    await expect(resetTestDatabase('postgresql://liame_owner:senha@aws-0-sa-east-1.pooler.supabase.com:5432/postgres')).rejects.toBeInstanceOf(ResetError);
    await expect(resetTestDatabase('postgresql://liame_owner:senha@localhost:5432/liame_dev')).rejects.toThrow('não termina em _test');
  });
});
