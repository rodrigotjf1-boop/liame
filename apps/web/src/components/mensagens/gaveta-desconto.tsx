'use client';

import type { MessageDiscountResponse } from '@liame/contracts';
import Link from 'next/link';
import { type FormEvent, type RefObject, useEffect, useMemo, useRef, useState } from 'react';
import { Icone } from '@/components/ui/icone';
import { useDialogo } from '@/components/ui/use-dialogo';
import { api, chamar } from '@/lib/api';
import { disparar } from '@/lib/disparar';
import {
  type CampoDoDesconto,
  erroAoSalvarDesconto,
  exemploDoCupom,
  type FormularioDoDesconto,
  formularioInicial,
  lerFormulario,
  lojasQueCriam,
  TIPOS_DO_DESCONTO,
} from './desconto-textos';
import { centavos } from './textos';

// Gaveta "O desconto do cupom das mensagens" (protótipo P15, parte D): o tipo, quanto, o pedido mínimo, por quantos dias
// vale e, com mais de uma loja do Regem que cria cupom, em qual. Mostra como o cupom vai aparecer no pedido. A tela
// confere antes de enviar; quem decide é o servidor (`PUT /v1/messaging/discount`). `<dialog>` nativo: foco preso, Esc
// fecha, o foco volta a quem abriu.

type Props = {
  resposta: MessageDiscountResponse;
  agora: Date;
  reserva: RefObject<HTMLElement | null>;
  aoSalvar: (r: MessageDiscountResponse) => void;
  aoFechar: () => void;
};

const ID_DO_CAMPO: Record<CampoDoDesconto, string> = { quanto: 'dc-quanto', minimo: 'dc-minimo', dias: 'dc-dias', loja: 'dc-loja' };

export function GavetaDesconto({ resposta: r, agora, reserva, aoSalvar, aoFechar }: Props) {
  // O foco ao abrir: o aviso sem loja, o "quanto" ou, na entrega grátis, o pedido mínimo (o primeiro campo que existe).
  const primeiro = useRef<HTMLElement | null>(null);
  const guardarPrimeiro = (el: HTMLElement | null) => {
    if (el) primeiro.current = el;
  };
  const { ref, fechar, devolverFoco } = useDialogo({ focoInicial: primeiro, reserva });
  const [g, setG] = useState<FormularioDoDesconto>(() => formularioInicial(r));
  const [erro, setErro] = useState<{ texto: string; campo: CampoDoDesconto | null } | null>(null);
  const [semLoja, setSemLoja] = useState(() => lojasQueCriam(r).length === 0);
  const [ocupado, setOcupado] = useState(false);
  /** O envio foi recusado num campo: depois do desenho, o foco vai para ele (V86). */
  const focarOErro = useRef(false);
  const L = r.limits;
  const lojas = lojasQueCriam(r);
  const exemplo = useMemo(() => exemploDoCupom(g, r, agora), [g, r, agora]);

  // O servidor disse que nenhuma loja cria cupom: a gaveta troca para o aviso, e o foco vai para ele (V80).
  const focarOAviso = useRef(false);
  useEffect(() => {
    if (!semLoja || !focarOAviso.current) return;
    focarOAviso.current = false;
    document.getElementById('dc-falha')?.focus({ preventScroll: true });
  }, [semLoja]);

  useEffect(() => {
    if (!erro || !focarOErro.current) return;
    focarOErro.current = false;
    const alvo = erro.campo ? document.getElementById(ID_DO_CAMPO[erro.campo]) : null;
    (alvo ?? ref.current?.querySelector<HTMLElement>('[aria-invalid="true"]'))?.focus({ preventScroll: true });
  }, [erro, ref]);

  function mudar(campo: keyof FormularioDoDesconto, valor: string) {
    setG((atual) => ({ ...atual, [campo]: valor }));
    setErro(null);
  }

  function recusar(texto: string, campo: CampoDoDesconto | null) {
    focarOErro.current = campo !== null;
    setErro({ texto, campo });
  }

  async function salvar(e: FormEvent) {
    e.preventDefault();
    if (ocupado) return;
    const lido = lerFormulario(g, r);
    if (!lido.ok) return recusar(lido.erro, lido.campo);
    setOcupado(true);
    const res = await chamar(() => api.PUT('/v1/messaging/discount', { body: lido.corpo }));
    setOcupado(false);
    if (!res.ok) {
      const x = erroAoSalvarDesconto(res.problema);
      if (x.semLoja) {
        focarOAviso.current = true;
        return setSemLoja(true);
      }
      return recusar(x.erro, x.campo);
    }
    aoSalvar(res.data);
    fechar();
  }

  const invalido = (c: CampoDoDesconto) => (erro?.campo === c ? true : undefined);
  const descrito = (c: CampoDoDesconto, dica: string) => (erro?.campo === c ? `${dica} dc-erro` : dica);

  const cab = (
    <div className="dialogo-cab">
      <div className="dlg-titulo">
        <p className="rotulo-marca">Mensagens</p>
        <h2 id="dlg-desconto-t">O desconto do cupom das mensagens</h2>
      </div>
      <button className="btn btn--ghost btn--icon" type="button" onClick={fechar} aria-label="Fechar" disabled={ocupado}>
        <Icone nome="x" />
      </button>
    </div>
  );
  const intro = (
    <p className="card-sub">
      Cada mensagem de WhatsApp leva um cupom só dela: é por ele que o Liame conta, no caixa, os pedidos que ela trouxe. O desconto é o mesmo em todas, e é o que você definir aqui. O
      funcionário não inventa oferta nem preço.
    </p>
  );

  return (
    <dialog
      ref={ref}
      id="dlg-desconto"
      className="dialogo dialogo--lado"
      aria-labelledby="dlg-desconto-t"
      onClose={() => {
        aoFechar();
        devolverFoco();
      }}
      onClick={(e) => {
        if (e.target === ref.current && !ocupado) fechar();
      }}
    >
      {semLoja ? (
        <div className="dialogo-form">
          {cab}
          <div className="dialogo-corpo">
            {intro}
            <div className="pd-aviso" role="alert">
              <Icone nome="plug" />
              <div>
                <b id="dc-falha" tabIndex={-1} ref={guardarPrimeiro}>
                  Nenhuma loja do Regem deixa o Liame criar cupom
                </b>
                <span>
                  O cupom de cada mensagem nasce no Regem. Para isso, o dono da loja autoriza o Liame de novo no Regem com a chave “Criar cupom de campanha” ligada, em Contas conectadas.
                </span>
                <Link className="btn btn--sm" href="/contas">
                  Abrir Contas conectadas
                </Link>
              </div>
            </div>
          </div>
          <div className="dialogo-acoes">
            <button className="btn" type="button" onClick={fechar}>
              Fechar
            </button>
          </div>
        </div>
      ) : (
        <form className="dialogo-form" noValidate onSubmit={(e) => disparar(salvar(e))}>
          {cab}
          <div className="dialogo-corpo" id="desconto-corpo">
            {intro}
            <fieldset className="campo">
              <legend>Que desconto o cupom dá?</legend>
              <div className="pd-escolha">
                {TIPOS_DO_DESCONTO.map((t) => (
                  <label className="pd-opcao" key={t.tipo}>
                    <input
                      type="radio"
                      name="dc-tipo"
                      value={t.tipo}
                      checked={g.tipo === t.tipo}
                      disabled={ocupado}
                      // Trocar o tipo troca o campo do valor: o que estava escrito para o outro tipo não serve.
                      onChange={() => {
                        setG((atual) => ({ ...atual, tipo: t.tipo, quanto: '' }));
                        setErro(null);
                      }}
                    />
                    {t.rotulo}
                  </label>
                ))}
              </div>
            </fieldset>
            {g.tipo !== 'frete_gratis' && (
              <div className="campo">
                <label htmlFor="dc-quanto">Quanto de desconto</label>
                <div className={g.tipo === 'percentual' ? 'pd-valor desc-fim' : 'pd-valor'}>
                  {g.tipo === 'valor' && <span aria-hidden="true">R$</span>}
                  <input
                    id="dc-quanto"
                    ref={guardarPrimeiro}
                    inputMode={g.tipo === 'percentual' ? 'numeric' : 'decimal'}
                    autoComplete="off"
                    maxLength={g.tipo === 'percentual' ? 2 : 7}
                    value={g.quanto}
                    disabled={ocupado}
                    aria-invalid={invalido('quanto')}
                    aria-describedby={descrito('quanto', 'dc-quanto-dica')}
                    onChange={(e) => mudar('quanto', e.target.value)}
                  />
                  {g.tipo === 'percentual' && <span aria-hidden="true">%</span>}
                </div>
                <p className="campo-dica" id="dc-quanto-dica">
                  {g.tipo === 'percentual' ? `De 1% a ${L.percent_max}%, sem casas decimais.` : `De ${centavos(100)} a ${centavos(L.value_cents_max)}.`}
                </p>
              </div>
            )}
            <div className="campo">
              <label htmlFor="dc-minimo">
                Pedido mínimo{g.tipo !== 'valor' && <span className="campo-dica"> Opcional</span>}
              </label>
              <div className="pd-valor">
                <span aria-hidden="true">R$</span>
                <input
                  id="dc-minimo"
                  ref={g.tipo === 'frete_gratis' ? guardarPrimeiro : undefined}
                  inputMode="decimal"
                  autoComplete="off"
                  maxLength={8}
                  value={g.minimo}
                  disabled={ocupado}
                  aria-invalid={invalido('minimo')}
                  aria-describedby={descrito('minimo', 'dc-minimo-dica')}
                  onChange={(e) => mudar('minimo', e.target.value)}
                />
              </div>
              <p className="campo-dica" id="dc-minimo-dica">
                {g.tipo === 'valor' ? 'Com desconto de valor fixo, o pedido mínimo é obrigatório e maior que o desconto.' : 'Em branco, o cupom vale para qualquer pedido.'}
              </p>
            </div>
            <div className="campo">
              <label htmlFor="dc-dias">Por quantos dias o cupom vale</label>
              <div className="pd-valor desc-fim">
                <input
                  id="dc-dias"
                  inputMode="numeric"
                  autoComplete="off"
                  maxLength={2}
                  value={g.dias}
                  disabled={ocupado}
                  aria-invalid={invalido('dias')}
                  aria-describedby={descrito('dias', 'dc-dias-dica')}
                  onChange={(e) => mudar('dias', e.target.value)}
                />
                <span aria-hidden="true">dias</span>
              </div>
              <p className="campo-dica" id="dc-dias-dica">
                De 1 a {L.valid_days_max} dias, contando o dia do envio.
              </p>
            </div>
            {lojas.length > 1 && (
              <div className="campo">
                <label htmlFor="dc-loja">Em qual loja o cupom vale</label>
                <select
                  className="input"
                  id="dc-loja"
                  value={g.loja}
                  disabled={ocupado}
                  aria-invalid={invalido('loja')}
                  aria-describedby={descrito('loja', 'dc-loja-dica')}
                  onChange={(e) => mudar('loja', e.target.value)}
                >
                  <option value="">Escolha a loja</option>
                  {lojas.map((l) => (
                    <option key={l.connected_account_id} value={l.connected_account_id}>
                      {l.name}
                    </option>
                  ))}
                </select>
                <p className="campo-dica" id="dc-loja-dica">
                  O cupom nasce no Regem, na loja escolhida. As outras lojas não o aceitam.
                </p>
              </div>
            )}
            {erro && (
              <p className="campo-erro" id="dc-erro" role="alert">
                {erro.texto}
              </p>
            )}
            <p className="pd-efeito" id="dc-efeito" role="status">
              {exemplo.intro} {exemplo.cupom && <b>{exemplo.cupom}</b>}
              {exemplo.cupom && '.'}
            </p>
            <p className="pd-nota">
              <Icone nome="shield" pequeno />
              <span>Vale para as próximas propostas. A mensagem que já está em Aprovações, ou que já foi enviada, segue com o desconto que tinha. A mudança fica registrada, com quem fez.</span>
            </p>
          </div>
          <div className="dialogo-acoes">
            <button className="btn" type="button" onClick={fechar} disabled={ocupado}>
              Cancelar
            </button>
            <button className="btn btn--primary" type="submit" disabled={ocupado} aria-busy={ocupado}>
              {ocupado ? 'Salvando…' : 'Salvar desconto'}
            </button>
          </div>
        </form>
      )}
    </dialog>
  );
}
