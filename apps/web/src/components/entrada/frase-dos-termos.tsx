'use client';

import type { LegalTermsResponse } from '@liame/contracts';
import { useRef, useState } from 'react';
import { GavetaOQueMuda } from '@/components/termos/gaveta-o-que-muda';
import { dataBr } from '@/components/termos/textos';

// A frase do aceite no cadastro e no convite (A0-6; com os Termos novos, A7, W14, parte 14e; P35; D-A7-94): os Termos de
// Uso e a Política de Privacidade de hoje e, no meio do aviso, também a versão que vem, com "ver o que muda" (a gaveta só
// para ler). Quem aceita aqui aceita as duas: o cadastro manda `next_terms_version`, e a pessoa não vê a faixa depois.

export function FraseDosTermos({ termos, acao }: { termos: LegalTermsResponse; acao: string }) {
  const [vendo, setVendo] = useState(false);
  const origem = useRef<HTMLElement | null>(null);
  return (
    <>
      <p className="campo-dica">
        {acao}, você concorda com os{' '}
        <a href={termos.terms_url} target="_blank" rel="noopener noreferrer">
          Termos de Uso
        </a>{' '}
        e a{' '}
        <a href={termos.privacy_url} target="_blank" rel="noopener noreferrer">
          Política de Privacidade
        </a>
        {termos.next ? (
          <>
            , e também com a versão que vale a partir de {dataBr(termos.next.effective_on)} (
            <button
              className="link-bt"
              type="button"
              aria-haspopup="dialog"
              aria-expanded={vendo}
              onClick={(e) => {
                origem.current = e.currentTarget;
                setVendo(true);
              }}
            >
              ver o que muda
            </button>
            ).
          </>
        ) : (
          '.'
        )}
      </p>
      {vendo && termos.next && (
        <GavetaOQueMuda
          versao={termos.next}
          noDia={false}
          dono={false}
          hoje={{ termos: termos.terms_url, privacidade: termos.privacy_url }}
          leitura
          reserva={origem}
          aoFechar={() => setVendo(false)}
        />
      )}
    </>
  );
}
