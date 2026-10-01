'use client';

import type { BrandResponse } from '@liame/contracts';
import { type RefObject, useId, useRef, useState } from 'react';
import { Icone } from '@/components/ui/icone';
import { useDialogo } from '@/components/ui/use-dialogo';
import { api, chamar, mensagemDe } from '@/lib/api';
import { disparar } from '@/lib/disparar';
import { type Autorizador, enderecoSeguro } from './textos';

// "Conectar plataforma" (protótipo aprovado): a marca e a plataforma (Meta, ou Google com Ads e Analytics
// numa autorização só). O navegador vai para a página da plataforma; nenhum token passa por aqui. O Regem
// (protótipo P2) aparece quando a API diz que dá para conectar, e abre o diálogo dele, que explica antes de ir.

type Props = {
  marcas: BrandResponse[];
  marcaInicial: string | null;
  reserva: RefObject<HTMLElement | null>;
  aoFechar: () => void;
  /** Leva o navegador para a plataforma (injetável para a tela; padrão: window.location.assign). */
  irPara?: (url: string) => void;
  aoIr: (a: Autorizador) => void;
  /** A API diz que dá para conectar o Regem: a opção aparece e leva ao diálogo dele, com a marca escolhida. */
  aoRegem?: ((marca: string) => void) | null;
};

export function DialogoConectar({ marcas, marcaInicial, reserva, aoFechar, aoIr, aoRegem = null, irPara = (url) => window.location.assign(url) }: Props) {
  const campoMarca = useRef<HTMLSelectElement>(null);
  const { ref, fechar, devolverFoco } = useDialogo({ focoInicial: campoMarca, reserva });
  const ids = useId();
  const [marca, setMarca] = useState(marcaInicial ?? marcas[0]?.id ?? '');
  const [indo, setIndo] = useState<Autorizador | null>(null);
  const [erro, setErro] = useState('');

  async function conectar(provider: Exclude<Autorizador, 'regem'>) {
    setErro('');
    if (!marca) return setErro('Escolha a marca que vai receber as contas.');
    setIndo(provider);
    const r = await chamar(() => api.POST('/v1/connections', { body: { provider, brand_id: marca } }));
    if (!r.ok) {
      setIndo(null);
      return setErro(mensagemDe(r.problema));
    }
    const destino = enderecoSeguro(r.data.authorize_url);
    if (!destino) {
      setIndo(null);
      return setErro('A plataforma devolveu um endereço inválido. Tente de novo; se continuar, fale com o suporte.');
    }
    aoIr(provider);
    irPara(destino);
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
        if (e.target === ref.current && !indo) fechar();
      }}
    >
      <div className="dialogo-form">
        <div className="dialogo-cab">
          <h2 id={`${ids}-t`}>Conectar plataforma</h2>
          <button className="btn btn--ghost btn--icon" type="button" onClick={fechar} aria-label="Fechar" disabled={indo !== null}>
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
            <label htmlFor={`${ids}-marca`}>Marca</label>
            <select ref={campoMarca} className="input" id={`${ids}-marca`} value={marca} onChange={(e) => setMarca(e.target.value)} disabled={indo !== null}>
              {marcas.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </div>
          <div className="plataformas" role="group" aria-label="Plataforma">
            <button className="plataforma" type="button" onClick={() => disparar(conectar('meta'))} disabled={indo !== null} aria-busy={indo === 'meta'}>
              <span className="plat plat--meta">Meta</span>
              <b>{indo === 'meta' ? 'Indo para a Meta…' : 'Meta Ads'}</b>
              <span>Facebook e Instagram. Você escolhe as contas de anúncio na tela da Meta.</span>
            </button>
            <button className="plataforma" type="button" onClick={() => disparar(conectar('google'))} disabled={indo !== null} aria-busy={indo === 'google'}>
              <span className="plat plat--google">Google</span>
              <b>{indo === 'google' ? 'Indo para o Google…' : 'Google Ads e Google Analytics'}</b>
              <span>Uma autorização só para os dois. Somente leitura.</span>
            </button>
            {aoRegem && (
              <button
                className="plataforma"
                type="button"
                disabled={indo !== null}
                onClick={() => {
                  if (!marca) return setErro('Escolha a marca que vai receber as lojas.');
                  aoRegem(marca);
                }}
              >
                <span className="plat plat--regem">Regem</span>
                <b>Regem · vendas da loja</b>
                <span>Pedidos, custos e cupons confirmados no caixa. Você escolhe as lojas no Regem.</span>
              </button>
            )}
          </div>
          <p className="dialogo-nota">
            <Icone nome="shield" pequeno />
            <span>
              {aoRegem
                ? 'Você vai para a página da plataforma, confirma lá e volta para cá. Na Meta e no Google, o Liame só lê: não cria, não muda e não gasta nada. No Regem, a única escrita possível é o cupom de campanha, sempre com aprovação.'
                : 'Você vai para a página da plataforma, confirma lá e volta para cá. O Liame só lê: não cria, não muda e não gasta nada.'}
            </span>
          </p>
        </div>
      </div>
    </dialog>
  );
}
