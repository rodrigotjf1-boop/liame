'use client';

import { useEffect, useRef, useState } from 'react';
import { disparar } from '@/lib/disparar';
import { idDaConta, plataforma, type SituacaoConta, ultimaLeitura } from './textos';

// Uma conta ligada (vira cartão no celular). "Desligar" confirma na própria linha; conta que a
// plataforma recusou oferece "Conectar de novo" (protótipo aprovado). Na loja do Regem a ação é "Revogar":
// o token daquela loja é revogado no Regem também (protótipo P2).

export type ContaDaTabela = {
  id: string;
  nome: string;
  provider: string;
  externalId: string | null;
  marca: string | null;
  /** Texto de baixo do nome no lugar do id (loja do Regem: "Loja no Liame: Centro · token próprio da loja"). */
  sub?: string;
  /** Loja do Regem: a ação da linha é "Revogar" (o token dela para de valer no Regem também). */
  revogar?: boolean;
  brandId: string;
  situacao: SituacaoConta;
};

type Props = {
  conta: ContaDaTabela;
  agora: Date;
  podeConectar: boolean;
  aoReconectar: () => void;
  aoDesligar: () => Promise<boolean>;
};

const TOM: Record<SituacaoConta['tom'], string> = { ok: 'st--concluido', atencao: 'st--aguardando', perigo: 'st--perigo', espera: 'st--espera', lendo: 'st--info' };

export function LinhaConta({ conta: c, agora, podeConectar, aoReconectar, aoDesligar }: Props) {
  const [confirmando, setConfirmando] = useState(false);
  const [desligando, setDesligando] = useState(false);
  const confirmar = useRef<HTMLButtonElement>(null);
  const desligar = useRef<HTMLButtonElement>(null);
  const perguntou = useRef(false);
  const plat = plataforma(c.provider);

  useEffect(() => {
    if (confirmando) {
      perguntou.current = true;
      confirmar.current?.focus();
    } else if (perguntou.current) {
      perguntou.current = false;
      desligar.current?.focus();
    }
  }, [confirmando]);

  async function desligarAgora() {
    setDesligando(true);
    const ok = await aoDesligar();
    if (!ok) {
      setDesligando(false);
      setConfirmando(false);
    }
  }

  const id = [c.externalId ? idDaConta(c.provider, c.externalId) : null, c.marca].filter(Boolean).join(' · ');
  return (
    <tr>
      <th scope="row">
        <span className="conta-nome">{c.nome}</span>
        {c.sub ? <span className="conta-id conta-id--txt">{c.sub}</span> : id && <span className="conta-id mono">{id}</span>}
      </th>
      <td>
        <span className={`plat plat--${plat.classe}`}>{plat.nome}</span>
      </td>
      <td>
        <span className={`st ${TOM[c.situacao.tom]}`}>
          {c.situacao.tom === 'lendo' ? <span className="girando" aria-hidden="true" /> : <span className="dot" aria-hidden="true" />}
          {c.situacao.rotulo}
        </span>
        {c.situacao.motivo && <span className="motivo">{c.situacao.motivo}</span>}
      </td>
      <td>
        <span className="quando">
          <span className="rotulo-celular">Última leitura: </span>
          {ultimaLeitura(c.situacao.ultimaLeituraEm, agora)}
        </span>
      </td>
      <td className="acoes">
        {podeConectar &&
          (c.situacao.reconectar ? (
            <button className="btn btn--sm btn--primary" type="button" onClick={aoReconectar} aria-label={`Conectar de novo: ${c.nome}`}>
              Conectar de novo
            </button>
          ) : confirmando ? (
            <div className="seg-acoes">
              <button
                ref={confirmar}
                className="btn btn--sm btn--perigo-cheio"
                type="button"
                onClick={() => disparar(desligarAgora())}
                disabled={desligando}
                aria-busy={desligando}
              >
                {c.revogar ? (desligando ? 'Revogando…' : 'Revogar agora') : desligando ? 'Desligando…' : 'Desligar agora'}
              </button>
              <button className="btn btn--sm" type="button" disabled={desligando} onClick={() => setConfirmando(false)}>
                Cancelar
              </button>
            </div>
          ) : (
            <button
              ref={desligar}
              className="btn btn--sm btn--ghost"
              type="button"
              onClick={() => setConfirmando(true)}
              aria-label={c.revogar ? `Revogar o acesso à loja ${c.nome}` : `Desligar ${c.nome}`}
            >
              {c.revogar ? 'Revogar' : 'Desligar'}
            </button>
          ))}
      </td>
    </tr>
  );
}
