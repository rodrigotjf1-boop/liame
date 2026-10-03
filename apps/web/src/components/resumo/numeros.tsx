'use client';

import { Fragment, useCallback, useRef, useState } from 'react';
import { Icone } from '@/components/ui/icone';
import type { LinhaDeFonte, Num, Texto } from './textos';

// Números com fonte (protótipo P8, como no Explicar do P4): cada número é um botão que abre "De onde vêm os
// números" na linha dele. A fonte é escrita pelo código a partir do que a API mandou, nunca por uma IA.

function semMovimento(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export type MostrarFonte = (i: number) => void;

export function useFontes(lista: LinhaDeFonte[]) {
  const [aberta, setAberta] = useState(false);
  const [destaque, setDestaque] = useState<number | null>(null);
  const [anuncio, setAnuncio] = useState('');
  const linhas = useRef<Array<HTMLDivElement | null>>([]);

  const mostrar = useCallback<MostrarFonte>(
    (i) => {
      const linha = lista[i];
      if (!linha) return;
      setAberta(true);
      setDestaque(i);
      setAnuncio(`${linha.valor}: ${linha.fonte}`);
      // A lista abre neste mesmo desenho: a linha só existe na tela no quadro seguinte.
      requestAnimationFrame(() => linhas.current[i]?.scrollIntoView({ block: 'nearest', behavior: semMovimento() ? 'auto' : 'smooth' }));
    },
    [lista],
  );
  return { aberta, setAberta, destaque, anuncio, linhas, mostrar };
}

export function NumeroComFonte({ num, lista, aoTocar }: { num: Num; lista: LinhaDeFonte[]; aoTocar: MostrarFonte }) {
  const fonte = lista[num.i]?.fonte;
  if (!fonte) return <>{num.texto}</>;
  return (
    <button type="button" className="nf" title={fonte} onClick={() => aoTocar(num.i)}>
      {num.texto}
      <span className="sr-only">, fonte: {fonte}</span>
    </button>
  );
}

export function TextoComNumeros({ texto, lista, aoTocar }: { texto: Texto; lista: LinhaDeFonte[]; aoTocar: MostrarFonte }) {
  return (
    <>
      {texto.map((p, i) =>
        'num' in p ? (
          <NumeroComFonte key={i} num={p.num} lista={lista} aoTocar={aoTocar} />
        ) : p.b ? (
          <b key={i}>{p.t}</b>
        ) : (
          <Fragment key={i}>{p.t}</Fragment>
        ),
      )}
    </>
  );
}

export function ListaDeFontes({ lista, estado }: { lista: LinhaDeFonte[]; estado: ReturnType<typeof useFontes> }) {
  if (!lista.length) return null;
  return (
    <>
      <details className="fontes-num" id="resumo-fontes" open={estado.aberta} onToggle={(ev) => estado.setAberta(ev.currentTarget.open)}>
        <summary>
          <Icone nome="chevron-down" pequeno />
          De onde vêm os números ({lista.length})
        </summary>
        <dl>
          {lista.map((l, i) => (
            <div
              key={i}
              className={estado.destaque === i ? 'destaque' : undefined}
              ref={(el) => {
                estado.linhas.current[i] = el;
              }}
            >
              <dt>{l.valor}</dt>
              <dd>{l.fonte}</dd>
            </div>
          ))}
        </dl>
      </details>
      <p className="sr-only" role="status" aria-live="polite">
        {estado.anuncio}
      </p>
    </>
  );
}
