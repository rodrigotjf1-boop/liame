'use client';

import type { BrandResponse } from '@liame/contracts';
import { type FormEvent, type RefObject, useId, useRef, useState } from 'react';
import { Icone } from '@/components/ui/icone';
import { useDialogo } from '@/components/ui/use-dialogo';
import { api, chamar, mensagemDe } from '@/lib/api';
import { disparar } from '@/lib/disparar';
import { enderecoSeguro, NUNCA_VEM_DO_REGEM, pedidosAoRegem } from './textos';

// "Conectar o Regem" (protótipo P2, aprovado em 29/09/2026): o que vai acontecer, antes de ir. A pessoa
// vai ao Regem, o presidente escolhe as lojas e o que libera, e volta para ligar cada loja do Regem a uma
// loja do Liame. Nenhum token passa pelo navegador: o Regem entrega o acesso direto ao servidor do Liame.

type Props = {
  marcas: BrandResponse[];
  marcaInicial: string | null;
  reserva: RefObject<HTMLElement | null>;
  aoFechar: () => void;
  /** Leva o navegador para o Regem (injetável para a tela; padrão: window.location.assign). */
  irPara?: (url: string) => void;
  aoIr: () => void;
};

export function DialogoConectarRegem({ marcas, marcaInicial, reserva, aoFechar, aoIr, irPara = (url) => window.location.assign(url) }: Props) {
  const ir = useRef<HTMLButtonElement>(null);
  const { ref, fechar, devolverFoco } = useDialogo({ focoInicial: ir, reserva });
  const ids = useId();
  const [marca, setMarca] = useState(marcaInicial ?? marcas[0]?.id ?? '');
  const [indo, setIndo] = useState(false);
  const [erro, setErro] = useState('');

  async function conectar(e: FormEvent) {
    e.preventDefault();
    setErro('');
    if (!marca) return setErro('Escolha a marca que vai receber as lojas.');
    setIndo(true);
    const r = await chamar(() => api.POST('/v1/connections', { body: { provider: 'regem', brand_id: marca } }));
    if (!r.ok) {
      setIndo(false);
      return setErro(mensagemDe(r.problema));
    }
    const destino = enderecoSeguro(r.data.authorize_url);
    if (!destino) {
      setIndo(false);
      return setErro('O Regem devolveu um endereço inválido. Tente de novo; se continuar, fale com o suporte.');
    }
    aoIr();
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
      <form className="dialogo-form" onSubmit={(e) => disparar(conectar(e))} noValidate>
        <div className="dialogo-cab">
          <h2 id={`${ids}-t`}>Conectar o Regem</h2>
          <button className="btn btn--ghost btn--icon" type="button" onClick={fechar} aria-label="Fechar" disabled={indo}>
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
          <p className="dlg-lead">Você vai ao Regem escolher as lojas; o Liame recebe só o que estiver marcado.</p>
          {marcas.length > 1 && (
            <div className="campo">
              <label htmlFor={`${ids}-marca`}>Marca</label>
              <select className="input" id={`${ids}-marca`} value={marca} onChange={(e) => setMarca(e.target.value)} disabled={indo}>
                {marcas.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          <ol className="passos-num">
            <li>
              <span>
                <b>Entre no Regem</b> com o perfil de presidente. O custo dos itens só sai com permissão financeira.
              </span>
            </li>
            <li>
              <span>
                <b>Escolha as lojas</b> e confira o que cada uma libera.
              </span>
            </li>
            <li>
              <span>
                <b>Volte para cá</b> e ligue cada loja do Regem a uma loja do Liame.
              </span>
            </li>
          </ol>
          <section className="bloco-dlg" aria-labelledby={`${ids}-pede`}>
            <h3 className="rotulo-marca" id={`${ids}-pede`}>
              O que o Liame pede
            </h3>
            <ul className="escopos">
              {pedidosAoRegem().map((e) => (
                <li key={e.cod} className={`escopo${e.opcional ? ' escopo--desligado' : ''}`}>
                  <Icone nome={e.opcional ? 'lock' : 'check'} pequeno />
                  <div>
                    <p className="escopo-cab">
                      <b>{e.rotulo}</b>
                      <code>{e.cod}</code>
                      {e.nota && <span className="st st--espera">{e.nota}</span>}
                    </p>
                    <p className="escopo-txt">{e.texto}</p>
                  </div>
                </li>
              ))}
            </ul>
          </section>
          <section className="bloco-dlg" aria-labelledby={`${ids}-nunca`}>
            <h3 className="rotulo-marca" id={`${ids}-nunca`}>
              O que o Liame nunca recebe
            </h3>
            <ul className="nao-vem">
              {NUNCA_VEM_DO_REGEM.map((t) => (
                <li key={t}>
                  <Icone nome="lock" pequeno />
                  <span>{t}</span>
                </li>
              ))}
            </ul>
          </section>
          <p className="dialogo-nota">
            <Icone nome="shield" pequeno />
            <span>
              Nenhuma senha ou token passa por você: o Regem entrega o acesso direto ao Liame, com um token para cada loja. Você revoga quando quiser, aqui ou no
              Regem.
            </span>
          </p>
        </div>
        <div className="dialogo-acoes">
          <button className="btn" type="button" onClick={fechar} disabled={indo}>
            Cancelar
          </button>
          <button ref={ir} className="btn btn--primary" type="submit" disabled={indo} aria-busy={indo}>
            {indo ? 'Indo para o Regem…' : 'Ir para o Regem'}
            <Icone nome="arrow-right" pequeno />
          </button>
        </div>
      </form>
    </dialog>
  );
}
