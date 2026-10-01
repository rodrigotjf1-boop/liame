'use client';

import type { ConnectionResponse, UnitSummary } from '@liame/contracts';
import { type FormEvent, type RefObject, useEffect, useId, useRef, useState } from 'react';
import { Icone } from '@/components/ui/icone';
import { useDialogo } from '@/components/ui/use-dialogo';
import { api, chamar, mensagemDe } from '@/lib/api';
import { dataCompleta } from '@/lib/formato';
import { disparar } from '@/lib/disparar';
import { type ContaExistente, chipsDoRegem, escolhiveis, lojaSugerida, lojasRepetidas } from './textos';

// "Ligar as lojas do Regem" (protótipo P2, aprovado em 29/09/2026): depois da volta do Regem, cada loja
// autorizada vai para uma loja do Liame (a de mesmo nome já vem escolhida; "Criar loja no Liame" deixa o
// servidor criar uma com o nome e o fuso dela). A loja que já estava ligada por outra autorização só troca
// de token e fica na loja em que estava.

type Props = {
  conexao: ConnectionResponse;
  /** Contas já ligadas na empresa (para reconhecer a loja que só troca de token). */
  existentes: ContaExistente[];
  reserva: RefObject<HTMLElement | null>;
  aoLigar: (texto: string) => void;
  aoFechar: () => void;
};

type Carga = { tipo: 'carregando' } | { tipo: 'erro'; texto: string } | { tipo: 'ok'; lojas: UnitSummary[] };

export function DialogoLojasRegem({ conexao, existentes, reserva, aoLigar, aoFechar }: Props) {
  const primeiro = useRef<HTMLSelectElement>(null);
  const { ref, fechar, devolverFoco } = useDialogo({ reserva });
  const ids = useId();
  const opcoes = escolhiveis(conexao, existentes);
  const [carga, setCarga] = useState<Carga>({ tipo: 'carregando' });
  const [escolha, setEscolha] = useState<Record<string, string>>({});
  const [repetidas, setRepetidas] = useState<Set<string>>(new Set());
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState('');
  const chips = chipsDoRegem(conexao.scopes, conexao.origin);
  const n = opcoes.length;

  useEffect(() => {
    let vivo = true;
    disparar(
      chamar(() => api.GET('/v1/units', { params: { query: { brand_id: conexao.brand_id } } })).then((r) => {
        if (!vivo) return;
        if (!r.ok) return setCarga({ tipo: 'erro', texto: mensagemDe(r.problema) });
        const lojas = r.data.items;
        setCarga({ tipo: 'ok', lojas });
        // A de mesmo nome já vem escolhida; a loja que só troca de token fica onde está (sem escolha).
        setEscolha(Object.fromEntries(opcoes.filter((o) => !o.reconectar).map((o) => [o.conta.external_id, lojaSugerida(o.conta.name, lojas)])));
      }),
    );
    return () => {
      vivo = false;
    };
    // Só ao abrir: a conexão do diálogo não muda enquanto ele está aberto.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conexao.id]);

  // As lojas chegam depois de o diálogo abrir: o foco vai para a primeira escolha quando ela aparece.
  const carregou = carga.tipo === 'ok';
  useEffect(() => {
    if (carregou) primeiro.current?.focus();
  }, [carregou]);

  async function ligar(e: FormEvent) {
    e.preventDefault();
    setErro('');
    const iguais = lojasRepetidas(escolha);
    setRepetidas(iguais);
    if (iguais.size) {
      const primeira = opcoes.find((o) => iguais.has(o.conta.external_id));
      if (primeira) document.getElementById(`${ids}-${primeira.conta.external_id}`)?.focus();
      return;
    }
    setEnviando(true);
    const r = await chamar(() =>
      api.POST('/v1/connections/{id}/accounts', {
        params: { path: { id: conexao.id } },
        body: {
          accounts: opcoes.map((o) => ({
            provider: 'regem' as const,
            external_id: o.conta.external_id,
            ...(escolha[o.conta.external_id] ? { unit_id: escolha[o.conta.external_id] } : {}),
          })),
        },
      }),
    );
    setEnviando(false);
    if (!r.ok) return setErro(mensagemDe(r.problema));
    const ligadas = r.data.linked.length;
    aoLigar(
      ligadas
        ? `${ligadas === 1 ? 'Loja ligada' : `${ligadas} lojas ligadas`}. A primeira leitura traz os pedidos dos últimos 90 dias e leva alguns minutos.`
        : 'Nada novo: as lojas já estavam ligadas.',
    );
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
      <form className="dialogo-form" onSubmit={(e) => disparar(ligar(e))} noValidate>
        <div className="dialogo-cab">
          <h2 id={`${ids}-t`}>Ligar as lojas do Regem</h2>
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
          <p className="aut-meta">
            Autorizado no Regem em {dataCompleta(conexao.completed_at ?? conexao.created_at)} · {n === 1 ? '1 loja' : `${n} lojas`}
          </p>
          {carga.tipo === 'carregando' && (
            <p className="aut-meta" role="status">
              Buscando as lojas do Liame…
            </p>
          )}
          {carga.tipo === 'erro' && (
            <p className="dialogo-erro" role="alert">
              <Icone nome="alert" pequeno />
              <span>{carga.texto}</span>
            </p>
          )}
          {carga.tipo === 'ok' &&
            opcoes.map((o, i) => {
              const k = o.conta.external_id;
              const campo = `${ids}-${k}`;
              return (
                <fieldset key={k} className="loja-ligar">
                  <legend>
                    {o.conta.name} <span className="plat plat--regem">Regem</span>
                  </legend>
                  {o.reconectar ? (
                    <p className="aut-meta">Já ligada ao Liame: só troca o token e continua na loja em que está.</p>
                  ) : (
                    <div className="campo">
                      <label htmlFor={campo}>Loja no Liame</label>
                      <select
                        ref={i === opcoes.findIndex((x) => !x.reconectar) ? primeiro : undefined}
                        className="input"
                        id={campo}
                        value={escolha[k] ?? ''}
                        aria-invalid={repetidas.has(k) || undefined}
                        aria-describedby={repetidas.size ? `${ids}-erro` : undefined}
                        disabled={enviando}
                        onChange={(e) => {
                          setEscolha((atual) => ({ ...atual, [k]: e.target.value }));
                          setRepetidas(new Set());
                        }}
                      >
                        {carga.lojas.map((u) => (
                          <option key={u.id} value={u.id}>
                            {u.name}
                          </option>
                        ))}
                        <option value="">＋ Criar loja no Liame</option>
                      </select>
                    </div>
                  )}
                  <ul className="escopos-chips" aria-label={`O que a ${o.conta.name} libera`}>
                    {chips.map((c) => (
                      <li key={c.cod} className={`st ${c.classe}`}>
                        {c.texto}
                      </li>
                    ))}
                  </ul>
                </fieldset>
              );
            })}
          {repetidas.size > 0 && (
            <p className="campo-erro" id={`${ids}-erro`} role="alert">
              Cada loja do Regem vai para uma loja do Liame diferente.
            </p>
          )}
          <p className="dialogo-nota">
            <Icone nome="info" pequeno />
            <span>A primeira leitura traz os pedidos dos últimos 90 dias e leva alguns minutos. Depois, os pedidos chegam ao longo do dia.</span>
          </p>
        </div>
        <div className="dialogo-acoes">
          <button className="btn" type="button" onClick={fechar} disabled={enviando}>
            Agora não
          </button>
          <button className="btn btn--primary" type="submit" disabled={enviando || carga.tipo !== 'ok' || !n} aria-busy={enviando}>
            {enviando ? 'Ligando…' : `Ligar ${n === 1 ? '1 loja' : `${n} lojas`}`}
          </button>
        </div>
      </form>
    </dialog>
  );
}
