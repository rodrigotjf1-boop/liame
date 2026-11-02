import type { Passkey } from '@liame/contracts';
import { describe, expect, it } from 'vitest';
import {
  detalheDaChave,
  erroDoNome,
  rotuloDeCriar,
  seloDaCopia,
  sobreACopia,
  subtituloDasChaves,
  textoDeTirar,
  textoDosCodigos,
} from '@/components/seguranca/chaves-textos';
import { fraseDoMotivo, motivoDoErro } from '@/lib/chave-de-acesso';

// As chaves de acesso no web (A7, W9, parte 9c1; P28 aprovado; D-A7-54 a D-A7-58): as frases do cartão em Segurança da
// conta (as mesmas do protótipo) e a tradução do que a janela do aparelho devolve.

const agora = new Date(2026, 9, 31, 9, 0, 0); // 31/10/2026 09:00
const local = (m: number, d: number, h: number, min = 0) => new Date(2026, m - 1, d, h, min).toISOString();
const chave = (extra: Partial<Passkey> = {}): Passkey => ({
  id: '01a1a1a1-0000-7000-8000-000000000001',
  name: 'Senhas do Google',
  synced: true,
  created_at: local(10, 12, 9, 15),
  last_used_at: local(10, 31, 8, 10),
  last_used_where: 'Chrome no Windows',
  ...extra,
});

describe('o cartão das chaves', () => {
  it('o subtítulo e o botão contam as chaves', () => {
    expect(subtituloDasChaves(0)).toBe('Entre sem senha e confirme com a digital, o rosto ou o PIN do aparelho.');
    expect(subtituloDasChaves(1)).toBe('Entre sem senha e confirme com a digital, o rosto ou o PIN do aparelho. 1 chave.');
    expect(subtituloDasChaves(2)).toBe('Entre sem senha e confirme com a digital, o rosto ou o PIN do aparelho. 2 chaves.');
    expect(rotuloDeCriar(0)).toBe('Criar uma chave de acesso');
    expect(rotuloDeCriar(3)).toBe('Criar outra chave');
  });

  it('a linha da chave: criada, último uso com o aparelho, e se sincroniza', () => {
    expect(detalheDaChave(chave(), agora)).toBe('Criada em 12/10/2026 · último uso: hoje, 08:10 · Chrome no Windows');
    expect(detalheDaChave(chave({ last_used_at: null, last_used_where: null }), agora)).toBe('Criada em 12/10/2026 · último uso: ainda não usada');
    expect(detalheDaChave(chave({ last_used_at: local(10, 29, 19, 32), last_used_where: null }), agora)).toBe('Criada em 12/10/2026 · último uso: 29/10, 19:32');
    expect(sobreACopia(chave())).toBe('Aparece nos aparelhos da mesma conta do Google ou da Apple.');
    expect(sobreACopia(chave({ synced: false }))).toBe('Fica só neste aparelho ou nesta chave física.');
    expect(seloDaCopia(chave())).toEqual({ tom: 'concluido', texto: 'Sincronizada' });
    expect(seloDaCopia(chave({ synced: false }))).toEqual({ tom: 'espera', texto: 'Só neste aparelho' });
  });

  it('tirar, o nome e os códigos', () => {
    expect(textoDeTirar(true)).toBe('Tirar a última chave? Você volta a entrar com a senha e o código do app.');
    expect(textoDeTirar(false)).toBe('Tirar esta chave? Ela deixa de abrir a sua conta.');
    expect(erroDoNome('   ')).toBe('Dê um nome à chave, como "Celular do trabalho".');
    expect(erroDoNome('x'.repeat(61))).toBe('O nome tem até 60 letras.');
    expect(erroDoNome(' Celular do trabalho ')).toBe('');
    expect(textoDosCodigos(true)).toContain('Pedimos o código do app ou a chave de acesso para confirmar.');
    expect(textoDosCodigos(false)).toBe('Sem o app, eles são a sua saída se perder os aparelhos com chave. Guarde num lugar seguro, fora do celular.');
  });
});

describe('a janela do aparelho', () => {
  it('o motivo de a chave não vir: fechar a janela, o aparelho que já tem a chave, outro erro', () => {
    expect(motivoDoErro({ name: 'NotAllowedError', code: 'ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY' })).toBe('cancelou');
    expect(motivoDoErro({ name: 'AbortError' })).toBe('cancelou');
    expect(motivoDoErro({ name: 'InvalidStateError', code: 'ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED' })).toBe('ja-tem');
    expect(motivoDoErro({ name: 'SecurityError', code: 'ERROR_INVALID_RP_ID' })).toBe('falhou');
    expect(motivoDoErro(null)).toBe('falhou');
  });

  it('a frase de cada motivo, com a alternativa de quem chamou', () => {
    expect(fraseDoMotivo('cancelou', 'use o código do app')).toBe('Você fechou a janela da chave. Tente de novo ou use o código do app.');
    expect(fraseDoMotivo('ja-tem', 'use o código do app')).toBe('Este aparelho já tem uma chave do Liame. Use a que já existe.');
    expect(fraseDoMotivo('sem-suporte', 'entre com a senha')).toBe('Este navegador não aceita chave de acesso. Entre com a senha.');
    expect(fraseDoMotivo('falhou', 'entre com a senha')).toBe('O aparelho não conseguiu usar a chave. Tente de novo ou entre com a senha.');
  });
});
