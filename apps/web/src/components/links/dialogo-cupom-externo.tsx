'use client';

import type { CouponCampaign, CouponResponse, ExternalCouponPlatform } from '@liame/contracts';
import { type FormEvent, type RefObject, useId, useRef, useState } from 'react';
import { Icone } from '@/components/ui/icone';
import { useDialogo } from '@/components/ui/use-dialogo';
import { api, chamar, mensagemDe } from '@/lib/api';
import { disparar } from '@/lib/disparar';
import { CampoCampanha } from './campo-campanha';
import { CampoExclusivo } from './campo-exclusivo';
import { type ErrosExterno, errosExterno, infoPlataforma } from './cupons-textos';

// "Informar cupom do Anota AI" (protótipo P3 com a plataforma de pedidos): o cupom é criado na plataforma;
// aqui a empresa informa o código, a campanha e se ele é exclusivo. O Liame reconhece o cupom nos pedidos
// que chegam ao Regem pela plataforma e não cria nem muda nada nela.

type Props = {
  unidade: string;
  plataforma: ExternalCouponPlatform;
  campanhas: CouponCampaign[];
  /** Campanha já escolhida (quando vem da lista de campanhas sem cupom). */
  campanhaInicial?: string;
  /** Códigos que a loja já tem (do Regem e informados). */
  existentes: string[];
  reserva: RefObject<HTMLElement | null>;
  aoInformado: (r: CouponResponse) => void;
  aoFechar: () => void;
};

export function DialogoCupomExterno({ unidade, plataforma, campanhas, campanhaInicial, existentes, reserva, aoInformado, aoFechar }: Props) {
  const ids = useId();
  const campoCodigo = useRef<HTMLInputElement>(null);
  const campoCampanha = useRef<HTMLSelectElement>(null);
  const campoExclusivo = useRef<HTMLInputElement>(null);
  const { ref, fechar, devolverFoco } = useDialogo({ focoInicial: campoCodigo, reserva });
  const info = infoPlataforma(plataforma);
  const [codigo, setCodigo] = useState('');
  const [campanha, setCampanha] = useState(campanhaInicial && campanhas.some((c) => c.id === campanhaInicial) ? campanhaInicial : '');
  const [exclusivo, setExclusivo] = useState<'' | 'sim' | 'nao'>('');
  const [erros, setErros] = useState<ErrosExterno>({});
  const [erro, setErro] = useState('');
  const [enviando, setEnviando] = useState(false);

  async function salvar(e: FormEvent) {
    e.preventDefault();
    setErro('');
    const achados = errosExterno({ codigo, campanha, exclusivo, existentes });
    setErros(achados);
    if (achados.codigo) return campoCodigo.current?.focus();
    if (achados.campanha) return campoCampanha.current?.focus();
    if (achados.exclusivo) return campoExclusivo.current?.focus();
    setEnviando(true);
    const r = await chamar(() =>
      api.POST('/v1/coupons/external', {
        body: { unit_id: unidade, platform: plataforma, code: codigo.trim(), campaign_id: campanha, exclusive: exclusivo === 'sim' },
      }),
    );
    setEnviando(false);
    if (!r.ok) {
      if (r.problema.code === 'cupom-ja-existe') {
        setErros({ codigo: 'Esse código já está na lista.' });
        return campoCodigo.current?.focus();
      }
      return setErro(mensagemDe(r.problema));
    }
    aoInformado(r.data);
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
      <form className="dialogo-form" onSubmit={(e) => disparar(salvar(e))} noValidate>
        <div className="dialogo-cab">
          <h2 id={`${ids}-t`}>Informar cupom {info.de}</h2>
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
          <p className="dialogo-nota">
            <span>
              Crie o cupom no {info.nome} primeiro. Aqui você só informa o código: o Liame reconhece o cupom nos pedidos que chegam ao Regem pelo {info.nome}. O
              Liame não cria nem muda nada no {info.nome}.
            </span>
          </p>
          <div className="campo">
            <label htmlFor={`${ids}-cod`}>Código do cupom</label>
            <input
              ref={campoCodigo}
              className="input mono"
              id={`${ids}-cod`}
              autoComplete="off"
              spellCheck={false}
              maxLength={60}
              placeholder="Ex.: SEXTA10"
              value={codigo}
              onChange={(e) => {
                setCodigo(e.target.value.replace(/\s/g, ''));
                setErros((x) => ({ ...x, codigo: undefined }));
              }}
              aria-invalid={!!erros.codigo}
              aria-describedby={`${ids}-cod-dica${erros.codigo ? ` ${ids}-cod-erro` : ''}`}
            />
            <p className="campo-dica" id={`${ids}-cod-dica`}>
              Exatamente como está na plataforma, sem espaço.
            </p>
            {erros.codigo && (
              <p className="campo-erro" id={`${ids}-cod-erro`}>
                {erros.codigo}
              </p>
            )}
          </div>
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
          <CampoExclusivo
            nome={`${ids}-excl`}
            valor={exclusivo}
            textoSim="Todo pedido com o cupom conta para a campanha."
            erro={erros.exclusivo}
            primeiroRef={campoExclusivo}
            aoMudar={(v) => {
              setExclusivo(v);
              setErros((x) => ({ ...x, exclusivo: undefined }));
            }}
          />
        </div>
        <div className="dialogo-acoes">
          <button className="btn" type="button" onClick={fechar} disabled={enviando}>
            Cancelar
          </button>
          <button className="btn btn--primary" type="submit" disabled={enviando || !campanhas.length} aria-busy={enviando}>
            {enviando ? 'Salvando…' : 'Salvar cupom'}
          </button>
        </div>
      </form>
    </dialog>
  );
}
