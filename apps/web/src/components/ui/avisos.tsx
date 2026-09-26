'use client';

import { createContext, type ReactNode, useCallback, useContext, useMemo, useRef, useState } from 'react';
import { Icone } from './icone';

// Avisos curtos (toast) com o resultado de cada ação: toda ação tem retorno visível e anunciado.

type Aviso = { id: number; texto: string; tipo: 'ok' | 'perigo'; saindo: boolean };
type Avisar = (texto: string, opcoes?: { tipo?: 'ok' | 'perigo' }) => void;

const AvisosContexto = createContext<Avisar | null>(null);

export function useAvisar(): Avisar {
  const avisar = useContext(AvisosContexto);
  if (!avisar) throw new Error('useAvisar fora do AvisosProvider');
  return avisar;
}

export function AvisosProvider({ children }: { children: ReactNode }) {
  const [avisos, setAvisos] = useState<Aviso[]>([]);
  const seq = useRef(0);

  const fechar = useCallback((id: number) => {
    setAvisos((lista) => lista.map((a) => (a.id === id ? { ...a, saindo: true } : a)));
    setTimeout(() => setAvisos((lista) => lista.filter((a) => a.id !== id)), 260);
  }, []);

  const avisar = useCallback<Avisar>(
    (texto, { tipo = 'ok' } = {}) => {
      const id = ++seq.current;
      setAvisos((lista) => [...lista.slice(-2), { id, texto, tipo, saindo: false }]);
      setTimeout(() => fechar(id), tipo === 'perigo' ? 6500 : 4200);
    },
    [fechar],
  );

  const valor = useMemo(() => avisar, [avisar]);
  return (
    <AvisosContexto.Provider value={valor}>
      {children}
      <div className="toast-region" role="status" aria-live="polite">
        {avisos.map((a) => (
          <div key={a.id} className={`toast${a.tipo === 'perigo' ? ' toast--perigo' : ''}${a.saindo ? ' saindo' : ''}`}>
            <span>{a.texto}</span>
            <button className="toast-fechar" type="button" onClick={() => fechar(a.id)} aria-label="Fechar aviso">
              <Icone nome="x" pequeno />
            </button>
          </div>
        ))}
      </div>
    </AvisosContexto.Provider>
  );
}
