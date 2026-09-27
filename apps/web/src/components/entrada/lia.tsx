'use client';

import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Icone } from '@/components/ui/icone';

// A LIA em 3D no palco das telas de entrada (kit lia-agente-3d, ux-modelo-interface §6.1 e §10).
// O 3D carrega depois do formulário, da própria origem (public/lia, montado no build), e só no computador;
// sem WebGL, ou se algo falhar, fica o avatar 2D. O formulário nunca espera pela LIA.

export type EstadoLia =
  | 'idle' | 'wave' | 'talk' | 'listen' | 'think' | 'working' | 'analyze' | 'happy'
  | 'celebrate' | 'love' | 'wink' | 'surprised' | 'confused' | 'empathetic' | 'shy';

type Instancia = {
  setState(estado: EstadoLia): void;
  react(estado: EstadoLia, ms: number): void;
  destroy(): void;
};

declare global {
  interface Window {
    LiaAgent?: { create(el: HTMLElement, opcoes: Record<string, unknown>): Instancia };
  }
}

type Controle = {
  /** Muda a expressão (por `ms` milissegundos, se informado; depois volta a parada). */
  reagir(estado: EstadoLia, ms?: number): void;
  /** O que a LIA diz no balão do palco. */
  falar(texto: string): void;
};

const SEM_LIA: Controle = { reagir: () => {}, falar: () => {} };
const LiaContexto = createContext<Controle>(SEM_LIA);
const PalcoContexto = createContext<{ fala: string; registrar: (i: Instancia | null) => void; pendente: () => EstadoLia } | null>(null);

export function useLia(): Controle {
  return useContext(LiaContexto);
}

/** Cena de cada tela: a fala e a expressão de entrada, uma vez ao abrir. */
export function useCena(fala: string, estado: EstadoLia = 'idle') {
  const { falar, reagir } = useLia();
  useEffect(() => {
    falar(fala);
    reagir(estado, estado === 'idle' ? undefined : 2600);
  }, [fala, estado, falar, reagir]);
}

export function LiaProvider({ children }: { children: ReactNode }) {
  const [fala, setFala] = useState('Oi! Eu sou a LIA, do atendimento da sua agência.');
  const instancia = useRef<Instancia | null>(null);
  const ultimo = useRef<EstadoLia>('wave');

  const reagir = useCallback((estado: EstadoLia, ms?: number) => {
    ultimo.current = estado;
    const i = instancia.current;
    if (!i) return;
    if (ms) i.react(estado, ms);
    else i.setState(estado);
  }, []);
  const controle = useMemo<Controle>(() => ({ reagir, falar: setFala }), [reagir]);
  const palco = useMemo(
    () => ({ fala, registrar: (i: Instancia | null) => (instancia.current = i), pendente: () => ultimo.current }),
    [fala],
  );
  return (
    <LiaContexto.Provider value={controle}>
      <PalcoContexto.Provider value={palco}>{children}</PalcoContexto.Provider>
    </LiaContexto.Provider>
  );
}

const SCRIPTS = ['/lia/three.min.js', '/lia/RoomEnvironment.js', '/lia/lia-agent.js'];
let carregando: Promise<void> | null = null;

function carregarScript(src: string): Promise<void> {
  return new Promise((ok, falha) => {
    const s = document.createElement('script');
    s.src = src;
    s.async = false;
    s.onload = () => ok();
    s.onerror = () => falha(new Error(`não carregou ${src}`));
    document.head.append(s);
  });
}

/** Carrega o three.js e o kit uma vez só, em ordem (o kit usa o THREE global). */
function carregarKit(): Promise<void> {
  if (window.LiaAgent) return Promise.resolve();
  carregando ??= SCRIPTS.reduce<Promise<void>>((anterior, src) => anterior.then(() => carregarScript(src)), Promise.resolve());
  return carregando;
}

export function PalcoLia() {
  const palco = useContext(PalcoContexto);
  const caixa = useRef<HTMLDivElement>(null);
  const [reserva, setReserva] = useState(false);

  useEffect(() => {
    // No celular e no tablet o palco não aparece: nada de 3D.
    if (!palco || !caixa.current || !window.matchMedia('(min-width: 1024px)').matches) return;
    let viva = true;
    let instancia: Instancia | null = null;
    carregarKit()
      .then(() => {
        if (!viva || !caixa.current || !window.LiaAgent) return;
        instancia = window.LiaAgent.create(caixa.current, {
          framing: 'bust',
          background: 'transparent',
          controls: false,
          zoom: false,
          shadows: false,
          floorRing: true,
          lookAtPointer: !window.matchMedia('(prefers-reduced-motion: reduce)').matches,
          state: palco.pendente(),
          outfit: 'executiva',
          pixelRatio: 1.5,
        });
        palco.registrar(instancia);
      })
      .catch((erro: unknown) => {
        // Sem WebGL ou sem os arquivos: o avatar 2D assume, sem atrapalhar a entrada.
        console.warn('[liame] LIA 3D indisponível, usando o avatar 2D:', erro instanceof Error ? erro.message : erro);
        if (viva) setReserva(true);
      });
    return () => {
      viva = false;
      palco.registrar(null);
      instancia?.destroy();
    };
    // O palco monta uma vez por layout: a fala muda sem recriar a personagem (registrar e pendente usam refs).
  }, []);

  if (!palco) return null;
  return (
    <aside className="palco" aria-label="LIA, assistente virtual da Liame">
      <div className="lia-3d" ref={caixa} hidden={reserva} />
      {reserva && <img className="lia-reserva" src="/lia/lia-avatar.svg" alt="LIA, assistente virtual da Liame" width={260} height={260} />}
      <div className="palco-txt">
        <p className="rotulo-marca">LIA · atendimento da sua agência</p>
        <p className="fala">{palco.fala}</p>
        <ul className="garantias">
          <li>
            <Icone nome="shield" pequeno />
            Entrada com app autenticador
          </li>
          <li>
            <Icone nome="check" pequeno />
            Nada vai ao ar sem a sua aprovação
          </li>
          <li>
            <Icone nome="users" pequeno />
            Você decide quem tem acesso
          </li>
        </ul>
      </div>
    </aside>
  );
}
