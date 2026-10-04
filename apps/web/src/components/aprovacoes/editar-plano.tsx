'use client';

import type { BrandPhraseHit, PlanContent } from '@liame/contracts';
import { type FormEvent, useEffect, useId, useRef, useState } from 'react';
import { Icone } from '@/components/ui/icone';
import { api, chamar } from '@/lib/api';
import { disparar } from '@/lib/disparar';
import type { Decisao } from './barra-da-decisao';
import { comDias, comOferta, comVerba, diaDaPauta, erroDaOferta, erroDaPauta, erroDaVerba, mesmoConteudo, totalDaVerba } from './planos-textos';

// "Editar o plano" (protótipo P8): a pessoa muda o que é do tipo do plano (a verba proposta, o item de cada dia ou a
// oferta, o horário e o texto do anúncio) e salva como uma versão nova, com outro hash. A aprovação passa a valer só
// para ela. O texto do anúncio é conferido pelas regras da Liame e da marca enquanto a pessoa escreve; quem decide
// se a versão serve é o servidor, ao salvar.

/** O texto do anúncio nas regras da Liame e da marca, um pouco depois de a pessoa parar de escrever. */
function useConferencia(texto: string, marca: string, ativa: boolean): BrandPhraseHit[] {
  const [hits, setHits] = useState<BrandPhraseHit[]>([]);
  useEffect(() => {
    const t = texto.trim();
    if (!ativa || t.length < 3) {
      setHits([]);
      return;
    }
    let vivo = true;
    const espera = setTimeout(() => {
      disparar(
        chamar(() => api.POST('/v1/brand-dossier/check', { body: { brand_id: marca, text: t } })).then((r) => {
          // Sem resposta, o aviso some: quem garante é a conferência do servidor ao salvar.
          if (vivo) setHits(r.ok ? r.data.hits : []);
        }),
      );
    }, 600);
    return () => {
      vivo = false;
      clearTimeout(espera);
    };
  }, [texto, marca, ativa]);
  return hits;
}

const inteiroDe = (v: string) => (v.trim() === '' ? 0 : Number(v));

export function EditarPlano({
  content,
  versao,
  marca,
  podeConferirTexto,
  aoSalvar,
  aoCancelar,
  aoNadaMudou,
}: {
  content: PlanContent;
  versao: number;
  marca: string;
  /** A pessoa pode usar a conferência de frase da marca (`dossie.ver`). */
  podeConferirTexto: boolean;
  aoSalvar: (novo: PlanContent) => Promise<Decisao>;
  aoCancelar: () => void;
  aoNadaMudou: () => void;
}) {
  const ids = useId();
  const formulario = useRef<HTMLFormElement>(null);
  const [meta, setMeta] = useState(content.kind === 'noventa_dias' ? String(content.budget.proposal.meta) : '');
  const [google, setGoogle] = useState(content.kind === 'noventa_dias' ? String(content.budget.proposal.google) : '');
  const [dias, setDias] = useState(content.kind === 'pauta' ? content.days.map((d) => d.item) : []);
  const [oferta, setOferta] = useState(content.kind === 'oferta' ? { oferta: content.offer, inicio: content.starts_at, fim: content.ends_at, texto: content.ad_text } : { oferta: '', inicio: '', fim: '', texto: '' });
  /** `dosCampos`: veio da conferência da tela (marca os campos e leva o foco); senão, é a recusa do servidor. */
  const [erro, setErro] = useState<{ texto: string; dosCampos: boolean } | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const batidas = useConferencia(oferta.texto, marca, content.kind === 'oferta' && podeConferirTexto);

  /** A conferência local recusou o envio: depois do desenho, o foco vai para o primeiro campo marcado. */
  const focarOErro = useRef(false);

  // Ao abrir, o foco vai para o primeiro campo.
  useEffect(() => {
    formulario.current?.querySelector<HTMLElement>('input, textarea')?.focus({ preventScroll: true });
  }, []);

  // O campo com problema só fica marcado depois do desenho: é aí que o foco vai para ele.
  useEffect(() => {
    if (!erro?.dosCampos || !focarOErro.current) return;
    focarOErro.current = false;
    const f = formulario.current;
    (f?.querySelector<HTMLElement>('[aria-invalid="true"]') ?? f?.querySelector<HTMLElement>('input, textarea'))?.focus({ preventScroll: true });
  }, [erro]);

  async function salvar(e: FormEvent) {
    e.preventDefault();
    if (ocupado) return;
    let novo: PlanContent;
    let invalido: string | null;
    if (content.kind === 'noventa_dias') {
      const m = inteiroDe(meta);
      const g = inteiroDe(google);
      invalido = erroDaVerba(m, g);
      novo = invalido ? content : comVerba(content, m, g);
    } else if (content.kind === 'pauta') {
      invalido = erroDaPauta(dias);
      novo = comDias(content, dias);
    } else {
      invalido = erroDaOferta(oferta, batidas.length);
      novo = comOferta(content, oferta);
    }
    if (invalido) {
      focarOErro.current = true;
      setErro({ texto: invalido, dosCampos: true });
      return;
    }
    if (mesmoConteudo(content, novo)) return aoNadaMudou();
    setErro(null);
    setOcupado(true);
    const r = await aoSalvar(novo);
    setOcupado(false);
    if (!r.ok) setErro({ texto: r.texto, dosCampos: false });
  }

  const limpar = () => setErro(null);
  // Com o aviso na tela, cada campo que tem a ver com ele fica marcado (é para onde o foco vai).
  const marcado = (comProblema: boolean) => (erro?.dosCampos && comProblema ? true : undefined);

  return (
    <form ref={formulario} className="plano-editar" noValidate onSubmit={(e) => disparar(salvar(e))}>
      {content.kind === 'noventa_dias' && (
        <>
          <div className="datas">
            <label>
              Meta, por mês (R$)
              <input
                className="input"
                type="number"
                inputMode="numeric"
                min={0}
                step={10}
                value={meta}
                aria-invalid={marcado(true)}
                onChange={(e) => {
                  setMeta(e.target.value);
                  limpar();
                }}
              />
            </label>
            <label>
              Google, por mês (R$)
              <input
                className="input"
                type="number"
                inputMode="numeric"
                min={0}
                step={10}
                value={google}
                aria-invalid={marcado(true)}
                onChange={(e) => {
                  setGoogle(e.target.value);
                  limpar();
                }}
              />
            </label>
          </div>
          <p className="nota" aria-live="polite">
            <span>{totalDaVerba(Number.isFinite(inteiroDe(meta)) ? inteiroDe(meta) : 0, Number.isFinite(inteiroDe(google)) ? inteiroDe(google) : 0, content.budget.today)}</span>
          </p>
        </>
      )}
      {content.kind === 'pauta' &&
        content.days.map((d, i) => (
          <div className="campo" key={d.day}>
            <label htmlFor={`${ids}-dia-${i}`}>{diaDaPauta(d.day)}</label>
            <input
              className="input"
              id={`${ids}-dia-${i}`}
              maxLength={160}
              value={dias[i] ?? ''}
              aria-invalid={marcado(!(dias[i] ?? '').trim())}
              onChange={(e) => {
                setDias((atuais) => atuais.map((t, k) => (k === i ? e.target.value : t)));
                limpar();
              }}
            />
          </div>
        ))}
      {content.kind === 'oferta' && (
        <>
          <div className="campo">
            <label htmlFor={`${ids}-oferta`}>Oferta</label>
            <input
              className="input"
              id={`${ids}-oferta`}
              maxLength={120}
              value={oferta.oferta}
              aria-invalid={marcado(!oferta.oferta.trim())}
              onChange={(e) => {
                setOferta((o) => ({ ...o, oferta: e.target.value }));
                limpar();
              }}
            />
          </div>
          <div className="datas">
            <label>
              Começa às
              <input
                className="input"
                type="time"
                value={oferta.inicio}
                aria-invalid={marcado(!oferta.inicio)}
                onChange={(e) => {
                  setOferta((o) => ({ ...o, inicio: e.target.value }));
                  limpar();
                }}
              />
            </label>
            <label>
              Termina às
              <input
                className="input"
                type="time"
                value={oferta.fim}
                aria-invalid={marcado(!oferta.fim || oferta.fim <= oferta.inicio)}
                onChange={(e) => {
                  setOferta((o) => ({ ...o, fim: e.target.value }));
                  limpar();
                }}
              />
            </label>
          </div>
          <div className="campo">
            <label htmlFor={`${ids}-texto`}>
              Texto do anúncio <span className="campo-dica">{podeConferirTexto ? 'Conferido pelas regras da Liame e da marca enquanto você escreve.' : 'Conferido pelas regras da Liame e da marca ao salvar.'}</span>
            </label>
            <textarea
              className="area"
              id={`${ids}-texto`}
              maxLength={220}
              rows={2}
              value={oferta.texto}
              aria-invalid={batidas.length > 0 || marcado(!oferta.texto.trim()) ? true : undefined}
              aria-describedby={`${ids}-texto-aviso`}
              onChange={(e) => {
                setOferta((o) => ({ ...o, texto: e.target.value }));
                limpar();
              }}
            />
            <div id={`${ids}-texto-aviso`} aria-live="polite">
              {batidas.length > 0 && (
                <p className="campo-erro">Bate numa regra: {batidas.map((h) => `${h.owner === 'marca' ? `“${h.text}”` : h.text}${h.why ? ` (${h.why})` : ''}`).join('; ')}. O texto não passa assim.</p>
              )}
            </div>
          </div>
        </>
      )}
      <p className="nota">
        <Icone nome="info" />
        <span>
          Salvar cria a versão {versao + 1}, com outro hash. A aprovação passa a valer só para ela.
        </span>
      </p>
      {erro && (
        <p className="campo-erro" role="alert">
          {erro.texto}
        </p>
      )}
      <div className="plano-editar-acoes">
        <button className="btn btn--primary btn--sm" type="submit" disabled={ocupado} aria-busy={ocupado}>
          {ocupado ? 'Salvando…' : `Salvar como versão ${versao + 1}`}
        </button>
        <button className="btn btn--sm" type="button" onClick={aoCancelar} disabled={ocupado}>
          Cancelar
        </button>
      </div>
    </form>
  );
}
