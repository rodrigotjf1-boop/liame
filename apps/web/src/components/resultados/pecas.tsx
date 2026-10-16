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

/** "Ver detalhes" do Lite: abre o Pro ali mesmo, no cartão (nada some no Lite). `rotulos` = [fechado, aberto]. */
export function BotaoDetalhes({
  aberto,
  controla,
  aoAlternar,
  rotulos = ['Ver detalhes', 'Ocultar detalhes'],
}: {
  aberto: boolean;
  controla: string;
  aoAlternar: () => void;
  rotulos?: [string, string];
}) {
  return (
    <button className="detalhes-bt" type="button" aria-expanded={aberto} aria-controls={controla} onClick={aoAlternar}>
      <span>{aberto ? rotulos[1] : rotulos[0]}</span>
      <Icone nome="chevron-down" pequeno />
    </button>
  );
}

/** "Dá lucro", "Empata", "Dá prejuízo" ou "Margem incompleta" (a regra é do servidor). */
export function SeloVeredito({ veredito }: { veredito: Veredito }) {
  return <span className={`veredito veredito--${veredito.classe}`}>{veredito.rotulo}</span>;
}
