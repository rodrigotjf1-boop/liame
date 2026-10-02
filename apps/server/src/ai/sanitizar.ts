import { redactCounting } from '@liame/telemetry';

// Remoção de dado pessoal antes de qualquer envio a um modelo (D-A3-4, Política 7.1). É a segunda
// barreira: quem monta o contexto já não inclui dado de cliente. Os padrões de e-mail, telefone, CPF e
// CNPJ são os mesmos da redação dos spans (um lugar só); aqui entra também o CEP.

const CEP = /(?<!\d)\d{5}-\d{3}(?!\d)/g;

export interface TextoLimpo {
  texto: string;
  removidos: number;
}

export function limparTexto(texto: string): TextoLimpo {
  const base = redactCounting(texto);
  let removidos = base.removed;
  const limpo = base.text.replace(CEP, () => {
    removidos += 1;
    return '[cep]';
  });
  return { texto: limpo, removidos };
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
