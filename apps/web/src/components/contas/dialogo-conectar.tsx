'use client';

import type { BrandResponse } from '@liame/contracts';
import { type RefObject, useId, useRef, useState } from 'react';
import { Icone } from '@/components/ui/icone';
import { useDialogo } from '@/components/ui/use-dialogo';
import { api, chamar, mensagemDe } from '@/lib/api';
import { disparar } from '@/lib/disparar';
import { NOTA_DA_PERMISSAO_DO_PERFIL } from './perfil-google';
import { type Autorizador, descricaoDoGoogle, enderecoSeguro, notaDeConectar, tituloDoGoogle } from './textos';

// "Conectar plataforma" (protótipo aprovado): a marca e a plataforma (Meta, ou Google com Ads e Analytics
// numa autorização só). O navegador vai para a página da plataforma; nenhum token passa por aqui. O Regem
// (protótipo P2) aparece quando a API diz que dá para conectar, e abre o diálogo dele, que explica antes de ir. O
// RegemCast (autorização por clique, Hub DMS B1) também só aparece quando a API diz que dá, e vai direto para a
// página de lá, onde o dono da conta confere tudo e confirma com a senha.

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
  /** A API diz que dá para conectar o RegemCast por clique (`available`): a opção aparece e vai para a página de lá. */
  comRegemcast?: boolean;
  /**
   * As marcas com "vendas informadas ao Google" ligado (A5, Y1): a autorização do Google delas pede também a permissão
   * de informar vendas, e o diálogo diz isso antes de a pessoa ir.
   */
  vendasAoGoogle?: ReadonlySet<string>;
  /**
   * As plataformas de anúncio em que mudar campanhas está ligado para a empresa (`ads_write`; A5, Y3): o diálogo diz
   * o que o Liame faz com a autorização, em vez de "só lê".
   */
  mudaAnuncios?: readonly string[];
  /**
   * O perfil da empresa no Google ligado para a empresa (`business_profile`; A6, P17 parte B): a autorização do Google
   * pede também a permissão do perfil, e o diálogo diz isso logo abaixo da opção do Google.
   */
  comPerfil?: boolean;
};

export function DialogoConectar({
  marcas,
  marcaInicial,
  reserva,
  aoFechar,
  aoIr,
  aoRegem = null,
  comRegemcast = false,
  vendasAoGoogle,
  mudaAnuncios = [],
  comPerfil = false,
  irPara = (url) => window.location.assign(url),
}: Props) {
  const campoMarca = useRef<HTMLSelectElement>(null);
  const { ref, fechar, devolverFoco } = useDialogo({ focoInicial: campoMarca, reserva });
  const ids = useId();
  const [marca, setMarca] = useState(marcaInicial ?? marcas[0]?.id ?? '');
  const [indo, setIndo] = useState<Autorizador | null>(null);
  const [erro, setErro] = useState('');
  const informaVendas = Boolean(marca && vendasAoGoogle?.has(marca));

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
            <button
              className="plataforma"
              type="button"
              onClick={() => disparar(conectar('google'))}
              disabled={indo !== null}
              aria-busy={indo === 'google'}
              aria-describedby={comPerfil ? `${ids}-perfil` : undefined}
            >
              <span className="plat plat--google">Google</span>
              <b>{indo === 'google' ? 'Indo para o Google…' : tituloDoGoogle(comPerfil)}</b>
              <span>{descricaoDoGoogle(informaVendas, mudaAnuncios, comPerfil)}</span>
            </button>
            {comPerfil && (
              <p className="dialogo-nota" id={`${ids}-perfil`}>
                <Icone nome="info" pequeno />
                <span>
                  <b>{NOTA_DA_PERMISSAO_DO_PERFIL.destaque}</b> {NOTA_DA_PERMISSAO_DO_PERFIL.texto}
                </span>
              </p>
            )}
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
            {comRegemcast && (
              <button className="plataforma" type="button" onClick={() => disparar(conectar('regemcast'))} disabled={indo !== null} aria-busy={indo === 'regemcast'}>
                <span className="plat plat--regemcast">RegemCast</span>
                <b>{indo === 'regemcast' ? 'Indo para o RegemCast…' : 'RegemCast · mensagens no WhatsApp'}</b>
                <span>Conversas abertas pelos anúncios, campanhas de mensagem e orçamento, só leitura. O dono da conta confirma com a senha no RegemCast.</span>
              </button>
            )}
          </div>
          <p className="dialogo-nota">
            <Icone nome="shield" pequeno />
            <span>{notaDeConectar(aoRegem !== null, informaVendas, mudaAnuncios)}</span>
          </p>
        </div>
      </div>
    </dialog>
  );
}
