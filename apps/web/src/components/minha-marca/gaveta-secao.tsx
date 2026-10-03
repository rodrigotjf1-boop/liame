'use client';

import type { BrandDossierContent, BrandDossierResponse, DossierSection, SystemProof } from '@liame/contracts';
import { type FormEvent, type RefObject, useEffect, useId, useRef, useState } from 'react';
import { Icone } from '@/components/ui/icone';
import { useDialogo } from '@/components/ui/use-dialogo';
import { api, chamar, mensagemDe } from '@/lib/api';
import { disparar } from '@/lib/disparar';
import { CamposDaSecao } from './campos';
import { comParte, copiar, juntar, partesQueMudaram, SECAO } from './textos';

// Editar uma parte da marca (protótipo P6): gaveta à direita com os campos da parte. Salvar cria a versão
// seguinte do dossiê inteiro. Se outra pessoa salvou enquanto esta editava (409), a gaveta busca a versão nova,
// põe por cima dela só as partes que esta pessoa mudou e diz o que aconteceu antes de salvar de novo.

type Props = {
  secao: DossierSection;
  marca: { id: string; nome: string };
  /** A versão que a pessoa abriu (0 quando o dossiê estava vazio) e o conteúdo dela. */
  base: { versao: number; conteudo: BrandDossierContent };
  /** O rascunho de partida, quando difere do conteúdo aberto (sugestão aplicada em "Editar antes"). */
  rascunhoInicial?: BrandDossierContent;
  provas: SystemProof[];
  reserva: RefObject<HTMLElement | null>;
  aoSalvar: (dossie: BrandDossierResponse, mudou: boolean) => void;
  aoFechar: () => void;
};

type Conflito = { versao: number; quem: string; partes: string[]; mesmas: string[] };

export function GavetaSecao({ secao, marca, base: baseInicial, rascunhoInicial, provas, reserva, aoSalvar, aoFechar }: Props) {
  const ids = useId();
  const s = SECAO[secao];
  const corpo = useRef<HTMLDivElement>(null);
  const { ref, fechar, devolverFoco } = useDialogo({ reserva });
  const [base, setBase] = useState(baseInicial);
  const [rascunho, setRascunho] = useState<BrandDossierContent>(() => copiar(rascunhoInicial ?? baseInicial.conteudo));
  const [conflito, setConflito] = useState<Conflito | null>(null);
  const [erro, setErro] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [anuncio, setAnuncio] = useState('');

  // O foco começa no primeiro campo da parte.
  useEffect(() => {
    corpo.current?.querySelector<HTMLElement>('textarea, input, button')?.focus();
  }, []);

  async function salvar(e: FormEvent) {
    e.preventDefault();
    setErro('');
    setEnviando(true);
    const r = await chamar(() => api.PUT('/v1/brand-dossier', { body: { brand_id: marca.id, base_version: base.versao, content: rascunho, ...(conflito ? { merged: true } : {}) } }));
    if (r.ok) {
      setEnviando(false);
      aoSalvar(r.data, (r.data.version?.version ?? 0) !== base.versao);
      return fechar();
    }
    if (r.problema.status === 409 && r.problema.code === 'versao-mudou') {
      // Outra pessoa salvou antes: a versão dela entra primeiro, e as partes que esta pessoa mudou vão por cima.
      const nova = await chamar(() => api.GET('/v1/brand-dossier', { params: { query: { brand_id: marca.id } } }));
      setEnviando(false);
      if (!nova.ok) return setErro(mensagemDe(nova.problema));
      const minhas = partesQueMudaram(base.conteudo, rascunho);
      const dela = partesQueMudaram(base.conteudo, nova.data.content);
      let junto = nova.data.content;
      for (const p of minhas) junto = comParte(p, junto, rascunho);
      setConflito({
        versao: nova.data.version?.version ?? 0,
        quem: nova.data.version?.created_by?.name ?? 'Outra pessoa',
        partes: dela.map((p) => SECAO[p].titulo),
        mesmas: dela.filter((p) => minhas.includes(p)).map((p) => SECAO[p].titulo),
      });
      setBase({ versao: nova.data.version?.version ?? 0, conteudo: nova.data.content });
      setRascunho(junto);
      setAnuncio('Outra pessoa salvou antes. Confira o aviso no começo da gaveta.');
      corpo.current?.scrollTo({ top: 0 });
      return;
    }
    setEnviando(false);
    setErro(mensagemDe(r.problema));
    corpo.current?.scrollTo({ top: 0 });
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
      <form className="dialogo-form" onSubmit={(e) => disparar(salvar(e))} noValidate>
        <div className="dialogo-cab">
          <div className="dlg-titulo">
            <p className="rotulo-marca">Minha marca</p>
            <h2 id={`${ids}-t`}>{s.titulo}</h2>
          </div>
          <button className="btn btn--icon btn--ghost" type="button" onClick={fechar} aria-label="Fechar" disabled={enviando}>
            <Icone nome="x" />
          </button>
        </div>
        <div className="dialogo-corpo" ref={corpo}>
          {erro && (
            <p className="dialogo-erro" role="alert">
              <Icone nome="alert" pequeno />
              <span>{erro}</span>
            </p>
          )}
          {conflito && (
            <div className="mk-info" role="status">
              <Icone nome="info" pequeno />
              <span>
                Enquanto você editava, {conflito.quem} confirmou a versão {conflito.versao}
                {conflito.partes.length ? `: mudou ${juntar(conflito.partes.map((p) => `“${p}”`))}` : ''}. A sua mudança entra junto, na versão {conflito.versao + 1}
                {conflito.mesmas.length
                  ? `. Atenção: ${juntar(conflito.mesmas.map((p) => `“${p}”`))} ${conflito.mesmas.length === 1 ? 'foi mudada' : 'foram mudadas'} pelas duas pessoas, e salvar agora deixa valendo o que você escreveu.`
                  : ', e nada do que foi feito se perde.'}
              </span>
            </div>
          )}
          <p className="mk-passo-ajuda">{s.ajuda}</p>
          <CamposDaSecao secao={secao} conteudo={rascunho} mudar={setRascunho} provas={provas} marca={marca} anunciar={setAnuncio} />
          <p className="sr-only" role="status" aria-live="polite">
            {anuncio}
          </p>
        </div>
        <div className="dialogo-acoes">
          <button className="btn" type="button" onClick={fechar} disabled={enviando}>
            Cancelar
          </button>
          <button className="btn btn--primary" type="submit" disabled={enviando}>
            {enviando ? 'Salvando…' : `Salvar como versão ${base.versao + 1}`}
          </button>
        </div>
      </form>
    </dialog>
  );
}
