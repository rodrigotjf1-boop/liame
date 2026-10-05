import { redactCounting, withIdsPreserved } from '@liame/telemetry';

// Remoção de dado pessoal antes de qualquer envio a um modelo (D-A3-4, Política 7.1). É a segunda
// barreira: quem monta o contexto já não inclui dado de cliente. Os padrões de e-mail, telefone, CPF e
// CNPJ são os mesmos da redação dos spans (um lugar só); aqui entra também o CEP. Os ids do sistema (UUID)
// passam intactos: o modelo usa o da marca nas ferramentas.

const CEP = /(?<!\d)\d{5}-\d{3}(?!\d)/g;

export interface TextoLimpo {
  texto: string;
  removidos: number;
}

export function limparTexto(texto: string): TextoLimpo {
  let removidos = 0;
  // Os UUIDs ficam de lado também para o CEP: `a1b12345-678c-…` parece um CEP.
  const limpo = withIdsPreserved(texto, (t) => {
    const base = redactCounting(t);
    removidos = base.removed;
    return base.text.replace(CEP, () => {
      removidos += 1;
      return '[cep]';
    });
  });
  return { texto: limpo, removidos };
}

/**
 * As marcas que a limpeza põe no lugar do dado pessoal (aqui e na redação dos spans). O texto que já passou por ela
 * (tudo o que sai do gateway) e traz uma destas marcas tinha dado pessoal: quem confere a saída de um modelo depois
 * do gateway olha a marca, porque o dado em si já não está lá.
 */
const MARCA_DE_REMOCAO = /\[(?:email|cnpj|cpf|telefone|cep|removido)\]/;
export const temMarcaDeRemocao = (texto: string): boolean => MARCA_DE_REMOCAO.test(texto);

/** O texto tem dado pessoal (cru, ou já trocado pela marca da limpeza)? */
export const temDadoPessoal = (texto: string): boolean => temMarcaDeRemocao(texto) || limparTexto(texto).removidos > 0;

/**
 * O motivo que uma pessoa escreve numa decisão (recusar uma promoção, desligar um funcionário), sem dado pessoal e
 * no tamanho que o banco guarda (de 3 a 300 caracteres); curto demais depois da limpeza, nulo.
 */
export function motivoSemDadoPessoal(texto: string): string | null {
  const limpo = limparTexto(texto).texto.trim().slice(0, 300);
  return limpo.length >= 3 ? limpo : null;
}

/** Limpa todo texto de um valor JSON (a resposta estruturada que vai para a guarda de 30 dias). */
export function limparJson(valor: unknown): { valor: unknown; removidos: number } {
  let removidos = 0;
  const andar = (v: unknown): unknown => {
    if (typeof v === 'string') {
      const r = limparTexto(v);
      removidos += r.removidos;
      return r.texto;
    }
    if (Array.isArray(v)) return v.map(andar);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, andar(x)]));
    return v;
  };
  return { valor: andar(valor), removidos };
}
