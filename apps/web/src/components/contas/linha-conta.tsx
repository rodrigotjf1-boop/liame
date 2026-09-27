'use client';

import { useEffect, useRef, useState } from 'react';
import { disparar } from '@/lib/disparar';
import { idDaConta, plataforma, type SituacaoConta, ultimaLeitura } from './textos';

// Uma conta ligada (vira cartão no celular). "Desligar" confirma na própria linha; conta que a
// plataforma recusou oferece "Conectar de novo" (protótipo aprovado).

export type ContaDaTabela = {
  id: string;
  nome: string;
  provider: string;
  externalId: string | null;
  marca: string | null;
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

const TOM: Record<SituacaoConta['tom'], string> = { ok: 'st--concluido', atencao: 'st--aguardando', perigo: 'st--perigo', espera: 'st--espera' };

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
        {id && <span className="conta-id mono">{id}</span>}
      </th>
      <td>
        <span className={`plat plat--${plat.classe}`}>{plat.nome}</span>
      </td>
      <td>
        <span className={`st ${TOM[c.situacao.tom]}`}>
          <span className="dot" aria-hidden="true" />
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
                {desligando ? 'Desligando…' : 'Desligar agora'}
              </button>
              <button className="btn btn--sm" type="button" disabled={desligando} onClick={() => setConfirmando(false)}>
                Cancelar
              </button>
            </div>
          ) : (
            <button ref={desligar} className="btn btn--sm btn--ghost" type="button" onClick={() => setConfirmando(true)} aria-label={`Desligar ${c.nome}`}>
              Desligar
            </button>
          ))}
      </td>
    </tr>
  );
}
