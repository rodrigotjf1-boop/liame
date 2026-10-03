'use client';

import type { BrandDossierResponse, BrandDossierSuggestion } from '@liame/contracts';
import { type RefObject, useId, useRef, useState } from 'react';
import { useAvisar } from '@/components/ui/avisos';
import { Icone } from '@/components/ui/icone';
import { useDialogo } from '@/components/ui/use-dialogo';
import { api, chamar, mensagemDe } from '@/lib/api';
import { disparar } from '@/lib/disparar';
import { quandoComHora } from '@/lib/formato';
import { quemSugeriu, SECAO, sinalDe, textoDoItem } from './textos';

// Conferir uma sugestão (protótipo P6): a pessoa marca o que vale; nada entra no dossiê antes disso. As sugestões
// do sistema saem das vendas e dos cupons, sem IA; as da LIA e do Pesquisador levam "Feito com IA".

type Props = {
  sugestao: BrandDossierSuggestion;
  /** A versão que a pessoa está vendo (0 sem versão). */
  versaoBase: number;
  agora: Date;
  reserva: RefObject<HTMLElement | null>;
  aoUsar: (dossie: BrandDossierResponse) => void;
  aoDescartar: () => void;
  /** "Editar antes": abre o editor da parte com os itens marcados já aplicados. */
  aoEditarAntes: (marcados: number[]) => void;
  aoFechar: () => void;
};

const SINAL: Record<ReturnType<typeof sinalDe>, { classe: string; texto: string }> = {
  mais: { classe: 'sinal sinal--mais', texto: '+' },
  menos: { classe: 'sinal sinal--menos', texto: '−' },
  muda: { classe: 'sinal sinal--muda', texto: '~' },
};

export function GavetaSugestao({ sugestao, versaoBase, agora, reserva, aoUsar, aoDescartar, aoEditarAntes, aoFechar }: Props) {
  const ids = useId();
  const avisar = useAvisar();
  const primeiro = useRef<HTMLInputElement>(null);
  const { ref, fechar, devolverFoco } = useDialogo({ focoInicial: primeiro, reserva });
  const [marcados, setMarcados] = useState<number[]>(() => sugestao.items.map((_, i) => i));
  const [confirmando, setConfirmando] = useState(false);
  const [erro, setErro] = useState('');
  const [enviando, setEnviando] = useState(false);
  const quem = quemSugeriu(sugestao.source);
  const titulo = SECAO[sugestao.section].titulo;

  const alternar = (i: number) => setMarcados((m) => (m.includes(i) ? m.filter((x) => x !== i) : [...m, i].sort((a, b) => a - b)));

  async function usar() {
    if (!marcados.length) return avisar('Marque pelo menos uma mudança, ou descarte a sugestão.', { tipo: 'perigo' });
    setErro('');
    setEnviando(true);
    const r = await chamar(() => api.POST('/v1/brand-dossier/suggestions/{id}/use', { params: { path: { id: sugestao.id } }, body: { base_version: versaoBase, items: marcados } }));
    setEnviando(false);
    if (!r.ok) return setErro(mensagemDe(r.problema));
    aoUsar(r.data);
    fechar();
  }

  async function descartar() {
    setErro('');
    setEnviando(true);
    const r = await chamar(() => api.POST('/v1/brand-dossier/suggestions/{id}/discard', { params: { path: { id: sugestao.id } } }));
    setEnviando(false);
    if (!r.ok) {
      setConfirmando(false);
      return setErro(mensagemDe(r.problema));
    }
    aoDescartar();
    fechar();
  }

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
        if (e.target === ref.current && !enviando) fechar();
      }}
    >
      <div className="dialogo-form">
        <div className="dialogo-cab">
          <div className="dlg-titulo">
            <p className="rotulo-marca">{quem.comIa ? `Sugestão ${quem.nome === 'LIA' ? 'da LIA' : 'do Pesquisador'}` : 'Sugestão do Liame'}</p>
            <h2 id={`${ids}-t`}>{titulo}</h2>
          </div>
          <button className="btn btn--icon btn--ghost" type="button" onClick={fechar} aria-label="Fechar" disabled={enviando}>
            <Icone nome="x" />
          </button>
        </div>
        <div className="dialogo-corpo">
          {erro && (
            <p className="dialogo-erro" role="alert">
              <Icone nome="alert" pequeno />
              <span>{erro}</span>
            </p>
          )}
          <div className="mk-sug">
            <p className="mk-sug-cab">
              <span className="av-func" aria-hidden="true">
                <Icone nome={quem.comIa ? 'sparkles' : 'chart'} />
              </span>
              <b>{quem.nome}</b>
              {quem.comIa ? (
                <span className="st st--ia">
                  <Icone nome="sparkles" />
                  Feito com IA
                </span>
              ) : (
                <span className="st st--espera">Sem IA</span>
              )}
              <span>{quandoComHora(sugestao.created_at, agora)}</span>
            </p>
            <p>
              {quem.comIa
                ? `${quem.nome === 'LIA' ? 'A LIA' : 'O Pesquisador'} sugere estas mudanças em ${titulo}. Marque o que vale; nada muda antes de você confirmar.`
                : `O Liame olhou as vendas e os cupons e sugere estas mudanças em ${titulo}. Marque o que vale; nada muda antes de você confirmar.`}
            </p>
            <ul className="mk-mudancas">
              {sugestao.items.map((item, i) => {
                const sinal = SINAL[sinalDe(item.op)];
                return (
                  <li key={i}>
                    <label className="mk-mudanca">
                      <input ref={i === 0 ? primeiro : undefined} type="checkbox" checked={marcados.includes(i)} onChange={() => alternar(i)} />
                      <span className={sinal.classe} aria-hidden="true">
                        {sinal.texto}
                      </span>
                      <span>
                        <b>{textoDoItem(item)}</b>
                        {item.why ? <small>{item.why}</small> : null}
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          </div>
          <p className="explica-nota">
            {quem.comIa ? 'Sugestão feita por um assistente de IA. Os números são do sistema; a decisão é sua.' : 'Sugestão calculada pelo Liame a partir das vendas e dos cupons, sem IA. A decisão é sua.'}
          </p>
        </div>
        {confirmando ? (
          // As chaves fazem a troca montar botões novos (o foco vai para a confirmação, como nas outras telas).
          <div className="dialogo-acoes mk-confirma" key="confirma" role="group" aria-label="Confirmar o descarte">
            <p className="confirma-txt">Descartar? O Liame não sugere de novo o que você descartou por 30 dias.</p>
            <button className="btn btn--perigo-cheio" type="button" onClick={() => disparar(descartar())} disabled={enviando} aria-busy={enviando} autoFocus>
              {enviando ? 'Descartando…' : 'Descartar'}
            </button>
            <button className="btn" type="button" onClick={() => setConfirmando(false)} disabled={enviando}>
              Manter
            </button>
          </div>
        ) : (
          <div className="dialogo-acoes" key="acoes">
            <button className="btn" type="button" onClick={() => setConfirmando(true)} disabled={enviando}>
              Descartar
            </button>
            <button
              className="btn"
              type="button"
              disabled={enviando}
              onClick={() => {
                if (!marcados.length) return avisar('Marque pelo menos uma mudança para editar antes.', { tipo: 'perigo' });
                aoEditarAntes(marcados);
              }}
            >
              Editar antes
            </button>
            <button className="btn btn--primary" type="button" onClick={() => disparar(usar())} disabled={enviando}>
              {enviando ? 'Salvando…' : 'Usar as marcadas'}
            </button>
          </div>
        )}
      </div>
    </dialog>
  );
}
