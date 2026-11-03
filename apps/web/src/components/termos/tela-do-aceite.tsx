'use client';

import type { TermsVersionInfo } from '@liame/contracts';
import Link from 'next/link';
import { useEffect, useRef } from 'react';
import { Icone } from '@/components/ui/icone';
import { fraseDoAceite, secaoDaMudanca, tituloDaTelaDoDia } from './textos';

// A tela do aceite, no dia (A7, W14, parte 14d; P35 aprovado; D-A7-93): no lugar do conteúdo, só para quem ainda não
// aceitou a versão que vale. Ler o que muda, aceitar e seguir, ou sair; o Dono também cancela (Plano e cobrança) e
// exporta. O servidor recusa as outras rotas da pessoa até o aceite (parte 14b); nada da empresa para.

type Props = {
  versao: TermsVersionInfo;
  dono: boolean;
  ocupado: boolean;
  erro: string;
  aoAceitar: () => void;
  aoVer: (origem: HTMLElement) => void;
  aoSair: () => void;
};

export function TelaDoAceite({ versao, dono, ocupado, erro, aoAceitar, aoVer, aoSair }: Props) {
  const titulo = useRef<HTMLHeadingElement>(null);
  useEffect(() => titulo.current?.focus(), []);
  return (
    <section className="termos-tela" aria-labelledby="h-termos-dia">
      <article className="card termos-tela-card">
        <span className="termos-tela-ic" aria-hidden="true">
          <Icone nome="file" />
        </span>
        <div>
          <h1 id="h-termos-dia" ref={titulo} tabIndex={-1}>
            {tituloDaTelaDoDia(versao)}
          </h1>
          <p className="termos-tela-txt">
            Para continuar usando o Liame, aceite os Termos de Uso e a Política de Privacidade novos.{' '}
            {versao.changes.length === 1 ? 'É 1 mudança' : `São ${versao.changes.length} mudanças`}; ler leva uns 2 minutos.
          </p>
        </div>
        <ul className="termos-tela-lista">
          {versao.changes.map((m) => (
            <li key={`${m.document}-${m.section}-${m.title}`}>
              <b>{m.title}</b> ({secaoDaMudanca(m)})
            </li>
          ))}
        </ul>
        <div className="termos-tela-acoes">
          <button className="btn btn--primary" type="button" onClick={aoAceitar} disabled={ocupado} aria-busy={ocupado}>
            {ocupado ? 'Aceitando…' : 'Aceitar os Termos novos'}
          </button>
          <button className="btn" type="button" onClick={(e) => aoVer(e.currentTarget)} aria-haspopup="dialog">
            Ver o que muda
          </button>
          <button className="btn btn--ghost" type="button" onClick={aoSair}>
            Sair da conta
          </button>
        </div>
        <p className="campo-dica">{fraseDoAceite(versao, true)}</p>
        {erro && (
          <p className="dialogo-erro" role="alert">
            {erro}
          </p>
        )}
        <div className="termos-tela-outro">
          <h2>Não concorda?</h2>
          {dono ? (
            <>
              <p>
                Você pode cancelar a assinatura em Plano e cobrança, sem multa (vale no fim do período pago), e exportar os dados da empresa antes. A
                equipe de IA da empresa segue trabalhando; só a sua entrada espera o aceite.
              </p>
              <div className="termos-tela-acoes">
                <Link className="btn" href="/cobranca">
                  Plano e cobrança
                </Link>
              </div>
            </>
          ) : (
            <p>Fale com o Dono da empresa: só ele cancela a assinatura. Enquanto isso, a equipe de IA da empresa segue trabalhando; só a sua entrada espera o aceite.</p>
          )}
        </div>
      </article>
    </section>
  );
}
