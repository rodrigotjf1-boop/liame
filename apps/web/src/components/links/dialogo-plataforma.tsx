'use client';

import type { CouponListResponse, CouponStore, OrderPlatform } from '@liame/contracts';
import { type FormEvent, type RefObject, useId, useRef, useState } from 'react';
import { Icone } from '@/components/ui/icone';
import { useDialogo } from '@/components/ui/use-dialogo';
import { api, chamar, mensagemDe } from '@/lib/api';
import { disparar } from '@/lib/disparar';
import { erroEnderecoPlataforma, nomeDaLoja, notaSugestao, OPCOES_PLATAFORMA } from './cupons-textos';

// "Onde a loja recebe pedidos online" (protótipo P3 com a plataforma de pedidos): a empresa confirma ou
// troca a plataforma; com "outra", informa o endereço do cardápio. Nada muda na plataforma.

type Props = {
  loja: CouponStore & { unit: { id: string; name: string } };
  atual: OrderPlatform;
  sugerida: CouponListResponse['detected_platform'];
  reserva: RefObject<HTMLElement | null>;
  aoSalvo: (loja: CouponStore) => void;
  aoFechar: () => void;
};

export function DialogoPlataforma({ loja, atual, sugerida, reserva, aoSalvo, aoFechar }: Props) {
  const ids = useId();
  const primeira = useRef<HTMLInputElement>(null);
  const campoUrl = useRef<HTMLInputElement>(null);
  const { ref, fechar, devolverFoco } = useDialogo({ focoInicial: primeira, reserva });
  const [escolha, setEscolha] = useState<OrderPlatform>(atual);
  const [url, setUrl] = useState(loja.order_platform_url ?? '');
  const [erroUrl, setErroUrl] = useState('');
  const [erro, setErro] = useState('');
  const [enviando, setEnviando] = useState(false);
  const nota = notaSugestao(sugerida);

  async function salvar(e: FormEvent) {
    e.preventDefault();
    setErro('');
    if (escolha === 'outra') {
      const problema = erroEnderecoPlataforma(url);
      setErroUrl(problema ?? '');
      if (problema) return campoUrl.current?.focus();
    }
    setEnviando(true);
    const r = await chamar(() =>
      api.PUT('/v1/units/{id}/order-platform', {
        params: { path: { id: loja.unit.id } },
        body: { platform: escolha, ...(escolha === 'outra' ? { url: url.trim() } : {}) },
      }),
    );
    setEnviando(false);
    if (!r.ok) return setErro(mensagemDe(r.problema));
    aoSalvo(r.data.store);
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
          <h2 id={`${ids}-t`}>Onde a loja recebe pedidos online</h2>
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
          <p className="campo-dica">O Liame usa isso para conferir os anúncios e para dizer como medir as vendas de cada campanha. Nada muda na plataforma.</p>
          <fieldset className="campo">
            <legend>Plataforma de pedidos da {nomeDaLoja(loja)}</legend>
            <div className="opcoes">
              {OPCOES_PLATAFORMA.map((o) => (
                <label className="opcao" key={o.valor}>
                  <input
                    ref={o.valor === atual ? primeira : undefined}
                    type="radio"
                    name={`${ids}-pf`}
                    value={o.valor}
                    checked={escolha === o.valor}
                    onChange={() => setEscolha(o.valor)}
                  />
                  <span className="opcao-txt">
                    <b>{o.titulo}</b>
                    <span>{o.texto}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          {escolha === 'outra' && (
            <div className="campo">
              <label htmlFor={`${ids}-url`}>Endereço do cardápio</label>
              <input
                ref={campoUrl}
                className="input"
                id={`${ids}-url`}
                autoComplete="off"
                inputMode="url"
                placeholder="https://"
                maxLength={1024}
                value={url}
                onChange={(e) => {
                  setUrl(e.target.value);
                  setErroUrl('');
                }}
                aria-invalid={!!erroUrl}
                aria-describedby={erroUrl ? `${ids}-url-erro` : undefined}
              />
              {erroUrl && (
                <p className="campo-erro" id={`${ids}-url-erro`}>
                  {erroUrl}
                </p>
              )}
            </div>
          )}
          {nota && (
            <p className="dialogo-nota">
              <span>{nota}</span>
            </p>
          )}
        </div>
        <div className="dialogo-acoes">
          <button className="btn" type="button" onClick={fechar} disabled={enviando}>
            Cancelar
          </button>
          <button className="btn btn--primary" type="submit" disabled={enviando} aria-busy={enviando}>
            {enviando ? 'Salvando…' : 'Salvar'}
          </button>
        </div>
      </form>
    </dialog>
  );
}
