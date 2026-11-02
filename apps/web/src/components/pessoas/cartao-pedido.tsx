'use client';

import type { PartnerRequestResponse } from '@liame/contracts';
import { useEffect, useId, useRef, useState } from 'react';
import { ConfirmaNaLinha } from '@/components/ui/confirma-na-linha';
import { disparar } from '@/lib/disparar';
import { cnpjTxt, pedeTxt, recebidoTxt } from './parceiros';

// O pedido de uma agência no alto de Pessoas e acessos (P27 aprovado; só o Dono o vê): quem pede, a mensagem, o que a
// agência pede e o CNPJ informado; "Ver e decidir" abre a gaveta do aceite, e "Recusar" confirma na própria linha.

type Props = {
  pedido: PartnerRequestResponse;
  nomeEmpresa: string;
  agora: Date;
  aoDecidir: () => void;
  aoRecusar: () => Promise<boolean>;
};

export function CartaoPedido({ pedido: p, nomeEmpresa, agora, aoDecidir, aoRecusar }: Props) {
  const ids = useId();
  const [recusando, setRecusando] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const recusar = useRef<HTMLButtonElement>(null);
  const perguntou = useRef(false);

  // Quem desiste da recusa volta ao "Recusar" depois de ele voltar à tela (o foco no mesmo render não acha o botão).
  useEffect(() => {
    if (recusando) perguntou.current = true;
    else if (perguntou.current) {
      perguntou.current = false;
      recusar.current?.focus();
    }
  }, [recusando]);

  async function recusarAgora() {
    setEnviando(true);
    const ok = await aoRecusar();
    if (!ok) {
      setEnviando(false);
      setRecusando(false);
    }
  }

  return (
    <article className="card pedido anima" style={{ ['--i' as string]: 1 }} aria-labelledby={`${ids}-t`}>
      <div className="pedido-cab">
        <span className="st st--aguardando">
          <span className="dot" aria-hidden="true" />
          Pedido de agência
        </span>
        <span className="campo-dica">{recebidoTxt(p, agora)}</span>
      </div>
      <h2 id={`${ids}-t`}>
        {p.agency.name} pede para cuidar da conta da {nomeEmpresa}
      </h2>
      <p className="lite-frase">
        {p.requested_by_name} pediu em nome da agência. O time dela só entra com o seu aceite, até o nível e o limite que você escolher, e
        você desfaz quando quiser. <b>A conta continua sua.</b>
      </p>
      {p.message && <blockquote className="pedido-msg">“{p.message}”</blockquote>}
      <dl className="pedido-dados">
        <div>
          <dt>A agência pede</dt>
          <dd>{pedeTxt(p.requested_role)}</dd>
        </div>
        {p.agency.cnpj && (
          <div>
            <dt>CNPJ informado pela agência</dt>
            <dd className="campo-mono">{cnpjTxt(p.agency.cnpj)}</dd>
          </div>
        )}
      </dl>
      <div className="pedido-acoes">
        {recusando ? (
          <ConfirmaNaLinha
            texto="Recusar o pedido? A agência fica sabendo, sem o motivo."
            rotulo="Recusar o pedido"
            rotuloOcupado="Recusando…"
            voltar="Voltar"
            ocupado={enviando}
            aoConfirmar={() => disparar(recusarAgora())}
            aoCancelar={() => setRecusando(false)}
          />
        ) : (
          <>
            <button className="btn btn--primary" type="button" aria-haspopup="dialog" onClick={aoDecidir}>
              Ver e decidir
            </button>
            <button ref={recusar} className="btn btn--perigo" type="button" onClick={() => setRecusando(true)}>
              Recusar
            </button>
          </>
        )}
      </div>
    </article>
  );
}
