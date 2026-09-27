'use client';

import type { ConnectionResponse } from '@liame/contracts';
import { type FormEvent, type RefObject, useId, useRef, useState } from 'react';
import { Icone } from '@/components/ui/icone';
import { useDialogo } from '@/components/ui/use-dialogo';
import { api, chamar, mensagemDe } from '@/lib/api';
import { disparar } from '@/lib/disparar';
import { botaoLigar, type ContaExistente, escolhiveis, gruposDaEscolha, idDaConta } from './textos';

// "Escolher contas" depois da autorização (protótipo aprovado): as contas que ela alcança, agrupadas
// por plataforma; as que já estão ligadas aparecem marcadas e travadas, menos as que a plataforma
// recusou antes ("desconectada"), que esta autorização reconecta. Uma chamada liga todas.

type Props = {
  conexao: ConnectionResponse;
  /** Contas já ligadas na empresa (para reconhecer as que esta autorização reconecta). */
  existentes: ContaExistente[];
  marca: string;
  reserva: RefObject<HTMLElement | null>;
  aoLigar: (texto: string) => void;
  aoFechar: () => void;
};

const chave = (provider: string, externalId: string) => `${provider}:${externalId}`;

export function DialogoEscolher({ conexao, existentes, marca, reserva, aoLigar, aoFechar }: Props) {
  const primeira = useRef<HTMLInputElement>(null);
  const { ref, fechar, devolverFoco } = useDialogo({ focoInicial: primeira, reserva });
  const ids = useId();
  const opcoes = escolhiveis(conexao, existentes);
  const livres = opcoes.map((o) => o.conta);
  const reconectaveis = new Set(opcoes.filter((o) => o.reconectar).map((o) => chave(o.conta.provider, o.conta.external_id)));
  // Reconectar já vem marcado; uma conta nova só, também. Várias novas: a pessoa escolhe (nada ligado sem querer).
  const [marcadas, setMarcadas] = useState<Set<string>>(() => {
    const iniciais = new Set(reconectaveis);
    if (livres.length === 1) iniciais.add(chave(livres[0]!.provider, livres[0]!.external_id));
    return iniciais;
  });
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState('');
  const grupos = gruposDaEscolha(conexao.discovered);
  const primeiraLivre = livres[0] ? chave(livres[0].provider, livres[0].external_id) : null;

  function alternar(k: string, marcar: boolean) {
    setMarcadas((atual) => {
      const nova = new Set(atual);
      if (marcar) nova.add(k);
      else nova.delete(k);
      return nova;
    });
  }

  async function ligar(e: FormEvent) {
    e.preventDefault();
    setErro('');
    const contas = livres.filter((d) => marcadas.has(chave(d.provider, d.external_id)));
    if (!contas.length) return;
    setEnviando(true);
    const r = await chamar(() =>
      api.POST('/v1/connections/{id}/accounts', {
        params: { path: { id: conexao.id } },
        body: { accounts: contas.map((d) => ({ provider: d.provider as 'meta_ads' | 'google_ads' | 'ga4', external_id: d.external_id })) },
      }),
    );
    setEnviando(false);
    if (!r.ok) return setErro(mensagemDe(r.problema));
    const ja = r.data.already_linked.length;
    const novas = r.data.linked.length;
    aoLigar(
      !novas
        ? `Nada novo: ${ja === 1 ? 'a conta já estava ligada' : 'as contas já estavam ligadas'} a uma marca.`
        : `${novas === 1 ? 'Conta ligada' : 'Contas ligadas'}. A primeira leitura (90 dias) começou e leva alguns minutos.${
            ja ? ` ${ja === 1 ? '1 já estava ligada' : `${ja} já estavam ligadas`} a uma marca.` : ''
          }`,
    );
    fechar();
  }

  const n = marcadas.size;
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
      <form className="dialogo-form" onSubmit={(e) => disparar(ligar(e))} noValidate>
        <div className="dialogo-cab">
          <h2 id={`${ids}-t`}>Escolher contas para {marca}</h2>
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
          {grupos.map((g) => (
            <fieldset className="campo" key={g.provider}>
              <legend>{g.titulo}</legend>
              {g.contas.map((d) => {
                const k = chave(d.provider, d.external_id);
                const reconectar = reconectaveis.has(k);
                const travada = d.linked && !reconectar;
                return (
                  <label className={`escolha${travada ? ' escolha--ligada' : ''}`} key={k}>
                    <input
                      ref={k === primeiraLivre ? primeira : undefined}
                      type="checkbox"
                      checked={travada || marcadas.has(k)}
                      disabled={travada || enviando}
                      onChange={(e) => alternar(k, e.target.checked)}
                    />
                    <span>
                      <b>{d.name}</b>
                      <span className="mono">{idDaConta(d.provider, d.external_id)}</span>
                    </span>
                    {d.via && <span className="lite-chip">via {d.via}</span>}
                    {travada && <span className="lite-chip">já ligada</span>}
                    {reconectar && <span className="lite-chip lite-chip--perigo">desconectada: ligar de novo</span>}
                  </label>
                );
              })}
            </fieldset>
          ))}
          <p className="dialogo-nota">
            <Icone nome="clock" pequeno />
            <span>A primeira leitura traz os últimos 90 dias e leva alguns minutos. Depois, os números são atualizados todo dia.</span>
          </p>
        </div>
        <div className="dialogo-acoes">
          <button className="btn" type="button" onClick={fechar} disabled={enviando}>
            Agora não
          </button>
          <button className="btn btn--primary" type="submit" disabled={!n || enviando} aria-busy={enviando}>
            {enviando ? 'Ligando…' : botaoLigar(n)}
          </button>
        </div>
      </form>
    </dialog>
  );
}
