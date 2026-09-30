import { Fragment } from 'react';
import { Icone } from '@/components/ui/icone';
import type { Frase, Veredito } from './textos';

// Peças pequenas da tela de Resultados (protótipo P1): frase com negrito, "Ver detalhes" e o veredito.

/** Frase com os trechos em negrito que a regra marcou (o que a pessoa lê primeiro). */
export function TextoRico({ frase }: { frase: Frase }) {
  return (
    <>
      {frase.map((t, i) => (t.b ? <b key={i}>{t.t}</b> : <Fragment key={i}>{t.t}</Fragment>))}
    </>
  );
}

/** "Ver detalhes" do Lite: abre o Pro ali mesmo, no cartão (nada some no Lite). */
export function BotaoDetalhes({ aberto, controla, aoAlternar }: { aberto: boolean; controla: string; aoAlternar: () => void }) {
  return (
    <button className="detalhes-bt" type="button" aria-expanded={aberto} aria-controls={controla} onClick={aoAlternar}>
      <span>{aberto ? 'Ocultar detalhes' : 'Ver detalhes'}</span>
      <Icone nome="chevron-down" pequeno />
    </button>
  );
}

/** "Dá lucro", "Empata", "Dá prejuízo" ou "Margem incompleta" (a regra é do servidor). */
export function SeloVeredito({ veredito }: { veredito: Veredito }) {
  return <span className={`veredito veredito--${veredito.classe}`}>{veredito.rotulo}</span>;
}
