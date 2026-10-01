'use client';

import type { CouponCampaign, CouponRequestResponse, CouponStore } from '@liame/contracts';
import { type FormEvent, type RefObject, useId, useRef, useState } from 'react';
import { Icone } from '@/components/ui/icone';
import { useDialogo } from '@/components/ui/use-dialogo';
import { api, chamar } from '@/lib/api';
import { disparar } from '@/lib/disparar';
import { CampoCampanha } from './campo-campanha';
import { type CamposCriar, corpoDoPedido, type ErrosCriar, erroDoPedido, errosCriar, hojeNoFuso, nomeDaLoja, type TipoDesconto } from './cupons-textos';

// "Criar cupom no Regem" (protótipo P3, aprovado): o código, o desconto, a validade em dias do fuso da loja, a
// campanha e se o cupom é exclusivo dela. Nada é criado aqui: o pedido vai para aprovação de quem pode
// aprovar, e só depois o Liame cria o cupom no Regem, já ligado à campanha.

type Props = {
  loja: CouponStore & { unit: NonNullable<CouponStore['unit']> };
  campanhas: CouponCampaign[];
  /** Códigos que a loja já tem (do Regem e informados). */
  existentes: string[];
  /** Códigos com pedido de criação em andamento. */
  pedidos: string[];
  agora: Date;
  reserva: RefObject<HTMLElement | null>;
  aoEnviado: (r: CouponRequestResponse) => void;
  aoFechar: () => void;
};

const TIPOS: { valor: TipoDesconto; rotulo: string }[] = [
  { valor: 'percentual', rotulo: 'Percentual' },
  { valor: 'valor', rotulo: 'Valor fixo' },
  { valor: 'frete_gratis', rotulo: 'Entrega grátis' },
];

/** Trinta dias depois de um dia AAAA-MM-DD (conta de calendário, sem fuso). */
function maisTrintaDias(dia: string): string {
  return new Date(Date.parse(`${dia}T12:00:00Z`) + 30 * 86_400_000).toISOString().slice(0, 10);
}

export function DialogoCriarCupom({ loja, campanhas, existentes, pedidos, agora, reserva, aoEnviado, aoFechar }: Props) {
  const ids = useId();
  const campoCodigo = useRef<HTMLInputElement>(null);
  const campoValor = useRef<HTMLInputElement>(null);
  const campoMinimo = useRef<HTMLInputElement>(null);
  const campoFim = useRef<HTMLInputElement>(null);
  const campoCampanha = useRef<HTMLSelectElement>(null);
  const { ref, fechar, devolverFoco } = useDialogo({ focoInicial: campoCodigo, reserva });
  const hoje = hojeNoFuso(loja.timezone, agora);
  const [campos, setCampos] = useState<CamposCriar>({ codigo: '', tipo: 'percentual', valor: '', minimo: '', inicio: hoje, fim: maisTrintaDias(hoje), campanha: '' });
  const [exclusivo, setExclusivo] = useState(true);
  const [erros, setErros] = useState<ErrosCriar>({});
  const [erro, setErro] = useState('');
  const [enviando, setEnviando] = useState(false);

  const alvoDe: Record<keyof ErrosCriar, RefObject<HTMLInputElement | HTMLSelectElement | null>> = {
    codigo: campoCodigo,
    valor: campoValor,
    minimo: campoMinimo,
    data: campoFim,
    campanha: campoCampanha,
  };
  const ORDEM: (keyof ErrosCriar)[] = ['codigo', 'valor', 'minimo', 'data', 'campanha'];

  function mudar<K extends keyof CamposCriar>(campo: K, valor: CamposCriar[K], limpa: keyof ErrosCriar) {
    setCampos((c) => ({ ...c, [campo]: valor }));
    setErros((x) => ({ ...x, [limpa]: undefined }));
  }

  async function enviar(e: FormEvent) {
    e.preventDefault();
    setErro('');
    const achados = errosCriar(campos, { hoje, existentes, pedidos });
    setErros(achados);
    const primeiro = ORDEM.find((k) => achados[k]);
    if (primeiro) return alvoDe[primeiro].current?.focus();
    setEnviando(true);
    const r = await chamar(() => api.POST('/v1/coupons/regem', { body: corpoDoPedido(campos, loja.unit.id, exclusivo) }));
    setEnviando(false);
    if (!r.ok) {
      const recusa = erroDoPedido(r.problema);
      if (!recusa.campo) return setErro(recusa.mensagem);
      setErros({ [recusa.campo]: recusa.mensagem });
      return alvoDe[recusa.campo].current?.focus();
    }
    aoEnviado(r.data);
    fechar();
  }

  const percentual = campos.tipo === 'percentual';
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
      <form className="dialogo-form" onSubmit={(e) => disparar(enviar(e))} noValidate>
        <div className="dialogo-cab">
          <h2 id={`${ids}-t`}>Criar cupom no Regem</h2>
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
          <div className="campo">
            <label htmlFor={`${ids}-cod`}>Código do cupom</label>
            <input
              ref={campoCodigo}
              className="input mono"
              id={`${ids}-cod`}
              autoComplete="off"
              spellCheck={false}
              maxLength={20}
              placeholder="Ex.: SEXTA15"
              value={campos.codigo}
              onChange={(e) => mudar('codigo', e.target.value.toUpperCase().replace(/\s/g, ''), 'codigo')}
              aria-invalid={!!erros.codigo}
              aria-describedby={`${ids}-cod-dica${erros.codigo ? ` ${ids}-cod-erro` : ''}`}
            />
            <p className="campo-dica" id={`${ids}-cod-dica`}>
              De 4 a 20 letras ou números, sem espaço. Único na empresa, no Regem.
            </p>
            {erros.codigo && (
              <p className="campo-erro" id={`${ids}-cod-erro`}>
                {erros.codigo}
              </p>
            )}
          </div>
          <fieldset className="campo">
            <legend>Desconto</legend>
            <div className="opcoes opcoes--linha">
              {TIPOS.map((t) => (
                <label key={t.valor} className="opcao">
                  <input
                    type="radio"
                    name={`${ids}-tipo`}
                    value={t.valor}
                    checked={campos.tipo === t.valor}
                    onChange={() => {
                      // Trocar o tipo limpa o valor: 15 (%) não vira R$ 15 sem a pessoa ver.
                      setCampos((c) => ({ ...c, tipo: t.valor, valor: '' }));
                      setErros((x) => ({ ...x, valor: undefined }));
                    }}
                  />
                  <span className="opcao-txt">
                    <b>{t.rotulo}</b>
                  </span>
                </label>
              ))}
            </div>
            <div className="valores">
              {campos.tipo !== 'frete_gratis' && (
                <label>
                  {percentual ? 'Desconto (%)' : 'Desconto (R$)'}
                  <input
                    ref={campoValor}
                    className="input num"
                    type="number"
                    min={percentual ? 1 : 0.01}
                    max={percentual ? 100 : undefined}
                    step={percentual ? 1 : 0.01}
                    inputMode={percentual ? 'numeric' : 'decimal'}
                    placeholder={percentual ? '15' : '10'}
                    value={campos.valor}
                    onChange={(e) => mudar('valor', e.target.value, 'valor')}
                    aria-invalid={!!erros.valor}
                    aria-describedby={erros.valor ? `${ids}-valor-erro` : undefined}
                  />
                </label>
              )}
              <label>
                Pedido mínimo (R$)
                <input
                  ref={campoMinimo}
                  className="input num"
                  type="number"
                  min={0}
                  step={0.01}
                  inputMode="decimal"
                  placeholder="Sem mínimo"
                  value={campos.minimo}
                  onChange={(e) => mudar('minimo', e.target.value, 'minimo')}
                  aria-invalid={!!erros.minimo}
                  aria-describedby={erros.minimo ? `${ids}-min-erro` : undefined}
                />
              </label>
            </div>
            {erros.valor && (
              <p className="campo-erro" id={`${ids}-valor-erro`}>
                {erros.valor}
              </p>
            )}
            {erros.minimo && (
              <p className="campo-erro" id={`${ids}-min-erro`}>
                {erros.minimo}
              </p>
            )}
          </fieldset>
          <fieldset className="campo">
            <legend>Validade</legend>
            <div className="datas">
              <label>
                Início
                <input className="input" type="date" min={hoje} value={campos.inicio} onChange={(e) => mudar('inicio', e.target.value, 'data')} />
              </label>
              <label>
                Fim
                <input
                  ref={campoFim}
                  className="input"
                  type="date"
                  min={campos.inicio || hoje}
                  value={campos.fim}
                  onChange={(e) => mudar('fim', e.target.value, 'data')}
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
          <CampoCampanha id={`${ids}-camp`} valor={campos.campanha} campanhas={campanhas} erro={erros.campanha} selectRef={campoCampanha} aoMudar={(v) => mudar('campanha', v, 'campanha')} />
          <label className="check check--topo">
            <input type="checkbox" checked={exclusivo} onChange={(e) => setExclusivo(e.target.checked)} />
            <span>
              <b>Exclusivo desta campanha.</b> Só cupom exclusivo prova de onde veio o pedido: use o código só nesta campanha.
            </span>
          </label>
          <div className="campo">
            <label htmlFor={`${ids}-loja`}>Loja</label>
            <input className="input" id={`${ids}-loja`} value={nomeDaLoja(loja)} readOnly />
          </div>
          <p className="dialogo-nota">
            <span>
              Vai para aprovação de quem pode aprovar; depois de aprovado, o Liame cria o cupom no Regem. Dá para desfazer: o cupom pode ser desativado depois, no Regem.
            </span>
          </p>
        </div>
        <div className="dialogo-acoes">
          <button className="btn" type="button" onClick={fechar} disabled={enviando}>
            Cancelar
          </button>
          <button className="btn btn--primary" type="submit" disabled={enviando || !campanhas.length} aria-busy={enviando}>
            {enviando ? 'Enviando…' : 'Enviar para aprovação'}
          </button>
        </div>
      </form>
    </dialog>
  );
}
