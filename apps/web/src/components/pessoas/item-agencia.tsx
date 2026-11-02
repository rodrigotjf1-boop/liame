'use client';

import type { MemberResponse, PartnerResponse } from '@liame/contracts';
import { dataCompleta, iniciais } from '@/lib/formato';
import { NIVEIS } from '@/lib/niveis';
import { ItemPessoa } from './item-pessoa';
import { cnpjTxt, daAgencia, detalheDaAgencia } from './parceiros';

// A agência com acesso, na lista "Com acesso" (P27 aprovado; D-A7-48): o máximo que o Dono deu, desde quando, e o time
// dela na empresa, cada pessoa pelo nome. O Dono muda o que a agência pode e desfaz o vínculo; quem remove pessoas tira
// uma pessoa só, como hoje.

type Props = {
  parceiro: PartnerResponse;
  time: MemberResponse[];
  nomeEmpresa: string;
  meuId: string;
  souDono: boolean;
  podeRemover: boolean;
  aoMudar: () => void;
  aoDesfazer: () => void;
  aoRemoverPessoa: (p: MemberResponse) => Promise<boolean>;
};

export function ItemAgencia({ parceiro: p, time, nomeEmpresa, meuId, souDono, podeRemover, aoMudar, aoDesfazer, aoRemoverPessoa }: Props) {
  const nome = p.agency.name;
  return (
    <li className="pessoa">
      <span className="pessoa-av pessoa-av--ag" aria-hidden="true">
        {iniciais(nome)}
      </span>
      <div className="pessoa-txt">
        <p className="pessoa-nome">
          {nome}
          <span className="nivel-chip nivel-chip--ag">Agência</span>
        </p>
        <p className="pessoa-email">
          {p.accepted_by_name ? `Aceita por ${p.accepted_by_name}` : 'Parceira'}
          {p.agency.cnpj ? ` · CNPJ ${cnpjTxt(p.agency.cnpj)}` : ''}
        </p>
        <p className="pessoa-det">{detalheDaAgencia(p)}</p>
        <p className="pessoa-meta">
          <span>Parceira desde {dataCompleta(p.since)}</span>
          <span>
            {time.length} {time.length === 1 ? 'pessoa' : 'pessoas'}
          </span>
        </p>
      </div>
      {(souDono || podeRemover) && (
        <div className="pessoa-acoes">
          {souDono && (
            <button className="btn btn--sm" type="button" aria-haspopup="dialog" onClick={aoMudar}>
              Mudar o que a agência pode
            </button>
          )}
          {podeRemover && (
            <button className="btn btn--sm btn--perigo" type="button" aria-haspopup="dialog" onClick={aoDesfazer}>
              Desfazer o vínculo
            </button>
          )}
        </div>
      )}
      {time.length ? (
        <ul className="ag-time" aria-label={`O time ${daAgencia(nome)} na ${nomeEmpresa}`}>
          {time.map((m) => (
            <ItemPessoa
              key={m.id}
              pessoa={m}
              voce={m.user_id === meuId}
              souDono={souDono}
              podeAlterar={false}
              podeRemover={podeRemover}
              aoAlterar={() => undefined}
              aoRemover={() => aoRemoverPessoa(m)}
            />
          ))}
        </ul>
      ) : (
        <p className="ag-time-vazio">
          Ninguém da agência entrou ainda. {nome} escolhe quem do time entra, até {NIVEIS[p.max_role].nome}, e você recebe um aviso de
          cada pessoa.
        </p>
      )}
    </li>
  );
}
