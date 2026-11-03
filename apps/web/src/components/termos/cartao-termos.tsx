'use client';

import type { TermsVersionInfo } from '@liame/contracts';
import { type RefObject, useRef, useState } from 'react';
import { useSessao } from '@/lib/sessao';
import { useTermosNovos } from './aviso-dos-termos';
import { GavetaOQueMuda } from './gaveta-o-que-muda';
import { diaDoAviso, diaEHora, linhaDaVersao, linhaDoAceite, seloDaVersao } from './textos';

// "Termos e privacidade" em Segurança da conta (A7, W14, parte 14e; P35 aprovado; D-A7-95): o que vale hoje, o que a pessoa
// aceitou e quando, o que vem (se houver) e as versões, cada uma com o que mudou. A situação é a do shell (o aviso dos
// Termos): "Ver o que muda" da versão que vem abre a mesma gaveta da faixa, com o aceite, e aceitar aqui tira a faixa na
// hora. Já aceita, a gaveta só mostra quando. Com a função desligada (ou sem resposta), o cartão não aparece.

export function CartaoTermos({ reserva }: { reserva: RefObject<HTMLElement | null> }) {
  const { empresa } = useSessao();
  const { estado, verOQueMuda } = useTermosNovos();
  const [vendo, setVendo] = useState<{ versao: TermsVersionInfo; aceitoEm: string | null } | null>(null);
  const origem = useRef<HTMLElement | null>(null);

  if (!estado) return null;
  const ler = (de: HTMLElement, versao: TermsVersionInfo, aceitoEm: string | null = null) => {
    origem.current = de;
    setVendo({ versao, aceitoEm });
  };
  const proxima = estado.next;
  return (
    <article className="card seg-largo termos-cartao" aria-labelledby="t-termos">
      <div className="card-cab">
        <div>
          <h2 id="t-termos">Termos e privacidade</h2>
          <p className="card-sub">Os textos que valem para a sua conta e quando você aceitou cada um.</p>
        </div>
      </div>
      <dl className="termos-dl">
        <div>
          <dt>Valem hoje</dt>
          <dd>
            <span>Os de {linhaDaVersao(estado.current.version)}</span>
            <a href={estado.current.terms_url} target="_blank" rel="noopener noreferrer">
              Ler o texto
            </a>
          </dd>
        </div>
        <div>
          <dt>Você aceitou</dt>
          <dd>
            <span>{linhaDoAceite(estado)}</span>
          </dd>
        </div>
        {proxima && (
          <div>
            <dt>Vêm aí</dt>
            <dd>
              <span>
                Os de {linhaDaVersao(proxima.version)}, avisados em {diaDoAviso(proxima)}
              </span>
              <span className={`st ${estado.next_accepted_at ? 'st--concluido' : 'st--aguardando'}`}>
                <span className="dot" aria-hidden="true" />
                {estado.next_accepted_at ? 'Aceitos' : 'Falta o seu aceite'}
              </span>
              <button
                className={`btn btn--sm${verOQueMuda ? ' btn--primary' : ''}`}
                type="button"
                aria-haspopup="dialog"
                onClick={(e) => {
                  if (verOQueMuda) verOQueMuda(e.currentTarget);
                  else ler(e.currentTarget, proxima, estado.next_accepted_at ? diaEHora(estado.next_accepted_at) : null);
                }}
              >
                Ver o que muda
              </button>
            </dd>
          </div>
        )}
      </dl>
      {estado.history.length > 0 && (
        <>
          <h3 className="termos-sub">As versões</h3>
          <ul className="termos-versoes">
            {estado.history.map((v) => {
              const selo = seloDaVersao(v, estado);
              return (
                <li key={v.version} className="termos-versao">
                  <div className="termos-versao-cab">
                    <b>{linhaDaVersao(v.version)}</b>
                    <span className={`st st--${selo.tom}`}>
                      <span className="dot" aria-hidden="true" />
                      {selo.texto}
                    </span>
                  </div>
                  <p>{selo.detalhe}</p>
                  {v.kind === 'relevante' && v.changes.length > 0 && (
                    <button className="link-bt" type="button" aria-haspopup="dialog" onClick={(e) => ler(e.currentTarget, v)}>
                      O que mudou
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}
      {vendo && (
        <GavetaOQueMuda
          versao={vendo.versao}
          noDia={false}
          dono={empresa?.role === 'dono'}
          hoje={{ termos: estado.current.terms_url, privacidade: estado.current.privacy_url }}
          leitura
          aceitoEm={vendo.aceitoEm}
          reserva={origem.current ? origem : reserva}
          aoFechar={() => setVendo(null)}
        />
      )}
    </article>
  );
}
