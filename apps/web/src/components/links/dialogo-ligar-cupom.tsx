'use client';

import type { CouponCampaign, CouponItem, CouponResponse, CouponStore } from '@liame/contracts';
import { type FormEvent, type RefObject, useId, useRef, useState } from 'react';
import { Icone } from '@/components/ui/icone';
import { useDialogo } from '@/components/ui/use-dialogo';
import { api, chamar, mensagemDe } from '@/lib/api';
import { disparar } from '@/lib/disparar';
import { CampoCampanha } from './campo-campanha';
import { CampoExclusivo } from './campo-exclusivo';
import { type ErrosLigar, errosLigar, hojeNoFuso, regraDoCupom, validadeDoCupom } from './cupons-textos';

// "Ligar cupom a uma campanha" (protótipo P3): a campanha, o período do vínculo em dias do fuso da loja
// (de hoje em diante) e se o cupom é exclusivo. O servidor refaz a atribuição dos pedidos com o código.

type Props = {
  cupom: CouponItem;
  loja: CouponStore;
  campanhas: CouponCampaign[];
  agora: Date;
  reserva: RefObject<HTMLElement | null>;
  aoLigado: (r: CouponResponse) => void;
  aoFechar: () => void;
};

export function DialogoLigarCupom({ cupom, loja, campanhas, agora, reserva, aoLigado, aoFechar }: Props) {
  const ids = useId();
  const campoCampanha = useRef<HTMLSelectElement>(null);
  const campoExclusivo = useRef<HTMLInputElement>(null);
  const campoFim = useRef<HTMLInputElement>(null);
  const { ref, fechar, devolverFoco } = useDialogo({ focoInicial: campoCampanha, reserva });
  const hoje = hojeNoFuso(loja.timezone, agora);
  const [campanha, setCampanha] = useState('');
  const [inicio, setInicio] = useState(hoje);
  const [fim, setFim] = useState('');
  const [exclusivo, setExclusivo] = useState<'' | 'sim' | 'nao'>('');
  const [erros, setErros] = useState<ErrosLigar>({});
  const [erro, setErro] = useState('');
  const [enviando, setEnviando] = useState(false);

  async function ligar(e: FormEvent) {
    e.preventDefault();
    setErro('');
    const achados = errosLigar({ campanha, exclusivo, inicio, fim, hoje });
    setErros(achados);
    if (achados.campanha) return campoCampanha.current?.focus();
    if (achados.exclusivo) return campoExclusivo.current?.focus();
    if (achados.data) return campoFim.current?.focus();
    setEnviando(true);
    const r = await chamar(() =>
      api.POST('/v1/coupons/{id}/link', {
        params: { path: { id: cupom.id } },
        body: { campaign_id: campanha, exclusive: exclusivo === 'sim', starts_on: inicio || hoje, ...(fim ? { ends_on: fim } : {}) },
      }),
    );
    setEnviando(false);
    if (!r.ok) return setErro(mensagemDe(r.problema));
    aoLigado(r.data);
    fechar();
  }

  return (
    <dialog
      ref={ref}
      className="dialogo"
      aria-labelledby={`${ids}-t`}
      onClose={() => {
        aoFechar();
        devolverFoco();
      }}
      onClick={(e) => {
        if (e.target === ref.current && !enviando) fechar();
      }}
    >
      <form className="dialogo-form" onSubmit={(e) => disparar(ligar(e))} noValidate>
        <div className="dialogo-cab">
          <h2 id={`${ids}-t`}>Ligar cupom a uma campanha</h2>
          <button className="btn btn--ghost btn--icon" type="button" onClick={fechar} aria-label="Fechar" disabled={enviando}>
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
          <p className="cupom-resumo">
            <span className="cupom-cod">{cupom.code}</span>
            <span>
              {regraDoCupom(cupom, agora)} · {validadeDoCupom(cupom, loja, agora)}
            </span>
          </p>
          <CampoCampanha
            id={`${ids}-camp`}
            valor={campanha}
            campanhas={campanhas}
            erro={erros.campanha}
            selectRef={campoCampanha}
            aoMudar={(v) => {
              setCampanha(v);
              setErros((x) => ({ ...x, campanha: undefined }));
            }}
          />
          <fieldset className="campo">
            <legend>Período do vínculo</legend>
            <div className="datas">
              <label>
                Início
                <input className="input" type="date" min={hoje} value={inicio} onChange={(e) => setInicio(e.target.value)} />
              </label>
              <label>
                Fim <span className="campo-dica">(opcional)</span>
                <input
                  ref={campoFim}
                  className="input"
                  type="date"
                  min={inicio || hoje}
                  value={fim}
                  onChange={(e) => setFim(e.target.value)}
                  aria-invalid={!!erros.data}
                  aria-describedby={erros.data ? `${ids}-data-erro` : undefined}
                />
              </label>
            </div>
            {erros.data && (
              <p className="campo-erro" id={`${ids}-data-erro`}>
                {erros.data}
              </p>
            )}
          </fieldset>
          <CampoExclusivo
            nome={`${ids}-excl`}
            valor={exclusivo}
            textoSim="Todo pedido com o cupom conta para a campanha, até no balcão e nas plataformas de pedidos que chegam ao Regem."
            erro={erros.exclusivo}
            primeiroRef={campoExclusivo}
            aoMudar={(v) => {
              setExclusivo(v);
              setErros((x) => ({ ...x, exclusivo: undefined }));
            }}
          />
          <p className="dialogo-nota">
            <span>
              <b>Só cupom exclusivo prova de onde veio o pedido.</b> Marque “sim” só se o código não aparece em nenhum outro lugar.
            </span>
          </p>
        </div>
        <div className="dialogo-acoes">
          <button className="btn" type="button" onClick={fechar} disabled={enviando}>
            Cancelar
          </button>
          <button className="btn btn--primary" type="submit" disabled={enviando || !campanhas.length} aria-busy={enviando}>
            {enviando ? 'Ligando…' : 'Ligar cupom'}
          </button>
        </div>
      </form>
    </dialog>
  );
}
