'use client';

import type { TermsVersionInfo } from '@liame/contracts';
import { type FormEvent, type RefObject, useId } from 'react';
import { Icone } from '@/components/ui/icone';
import { useDialogo } from '@/components/ui/use-dialogo';
import { dataBr, fraseDoAceite, NOME_DO_DOCUMENTO, naoConcorda, quandoVale, secaoDaMudanca } from './textos';

// "O que muda nos Termos" (A7, W14, parte 14d; P35 aprovado; D-A7-91): a gaveta à direita, aberta pela faixa, pela tela do
// dia e pelo cadastro (só para ler). Cada mudança com o documento e a seção, como é hoje e como fica; "nada muda para
// trás"; os textos inteiros; o caminho de quem não concorda; e "Aceitar os Termos novos", com a frase ao lado do botão.

type Props = {
  versao: TermsVersionInfo;
  /** Já vale (a tela do dia): "desde", e o botão volta em vez de "Depois". */
  noDia: boolean;
  dono: boolean;
  /** Os endereços dos textos de hoje. */
  hoje: { termos: string; privacidade: string };
  /** Só para ler (o cadastro, Segurança da conta): sem o aceite. */
  leitura?: boolean;
  /** Quando a pessoa já aceitou (a hora, já escrita). */
  aceitoEm?: string | null;
  ocupado?: boolean;
  erro?: string;
  reserva?: RefObject<HTMLElement | null>;
  aoAceitar?: () => void;
  aoFechar: () => void;
};

export function GavetaOQueMuda({ versao, noDia, dono, hoje, leitura = false, aceitoEm = null, ocupado = false, erro = '', reserva, aoAceitar, aoFechar }: Props) {
  const ids = useId();
  const { ref, fechar, devolverFoco } = useDialogo({ reserva });
  const podeAceitar = !leitura && !aceitoEm && !!aoAceitar;
  const enviar = (e: FormEvent) => {
    e.preventDefault();
    if (podeAceitar && !ocupado) aoAceitar?.();
  };
  return (
    <dialog
      ref={ref}
      className="dialogo dialogo--lado"
      aria-labelledby={`${ids}-t`}
      onClose={() => {
        aoFechar();
        devolverFoco();
      }}
      onClick={(e) => {
        if (e.target === ref.current && !ocupado) fechar();
      }}
    >
      <form className="dialogo-form" onSubmit={enviar} noValidate>
        <div className="dialogo-cab">
          <h2 id={`${ids}-t`}>O que muda nos Termos</h2>
          <button className="btn btn--ghost btn--icon" type="button" onClick={fechar} aria-label="Fechar" disabled={ocupado}>
            <Icone nome="x" />
          </button>
        </div>
        <div className="dialogo-corpo">
          <div className="termos-quando">
            <p className="termos-quando-txt">{quandoVale(versao, noDia)}</p>
            <span className="st st--info">
              <span className="dot" aria-hidden="true" />
              Aviso de {dataBr(versao.notice_at.slice(0, 10))}
            </span>
          </div>
          <ol className="termos-mudancas" aria-label="As mudanças">
            {versao.changes.map((m) => (
              <li key={`${m.document}-${m.section}-${m.title}`} className="termos-mudanca">
                <p className="termos-mudanca-doc">{secaoDaMudanca(m)}</p>
                <h3>{m.title}</h3>
                <dl>
                  <div>
                    <dt>Como é hoje</dt>
                    <dd>{m.today}</dd>
                  </div>
                  <div>
                    <dt>Como fica</dt>
                    <dd>{m.becomes}</dd>
                  </div>
                </dl>
              </li>
            ))}
          </ol>
          <p className="termos-nota-fraca">Nada muda para trás: o que já foi feito segue as regras de quando foi feito.</p>
          <div className="termos-textos">
            <h3>Os textos inteiros</h3>
            <div className="termos-textos-links">
              {versao.documents.map((d) => (
                <a key={d.document} href={d.url} target="_blank" rel="noopener noreferrer">
                  <Icone nome="external" />
                  {NOME_DO_DOCUMENTO[d.document]}, a versão nova
                </a>
              ))}
              <a href={hoje.termos} target="_blank" rel="noopener noreferrer">
                <Icone nome="external" />
                Os Termos de hoje
              </a>
              <a href={hoje.privacidade} target="_blank" rel="noopener noreferrer">
                <Icone nome="external" />A Política de hoje
              </a>
            </div>
          </div>
          {aceitoEm ? (
            <p className="termos-aceito">
              <Icone nome="check-circle" />
              <span>Você aceitou em {aceitoEm}.</span>
            </p>
          ) : (
            !leitura && (
              <p className="dialogo-nota">
                <Icone nome="info" />
                <span>{naoConcorda(versao, dono, noDia)}</span>
              </p>
            )
          )}
          {erro && (
            <p className="dialogo-erro" role="alert">
              {erro}
            </p>
          )}
        </div>
        <div className="dialogo-acoes">
          {podeAceitar ? (
            <>
              <p className="termos-frase-do-aceite">{fraseDoAceite(versao, noDia)}</p>
              <button className="btn" type="button" onClick={fechar} disabled={ocupado}>
                {noDia ? 'Voltar' : 'Depois'}
              </button>
              <button className="btn btn--primary" type="submit" disabled={ocupado} aria-busy={ocupado}>
                {ocupado ? 'Aceitando…' : 'Aceitar os Termos novos'}
              </button>
            </>
          ) : (
            <button className="btn" type="button" onClick={fechar}>
              Fechar
            </button>
          )}
        </div>
      </form>
    </dialog>
  );
}
