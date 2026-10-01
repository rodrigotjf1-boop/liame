'use client';

import type { ActionResponse } from '@liame/contracts';
import Link from 'next/link';
import { type FormEvent, type RefObject, useEffect, useId, useRef, useState } from 'react';
import { Icone } from '@/components/ui/icone';
import { disparar } from '@/lib/disparar';
import {
  apresentar,
  aprovacaoParcial,
  cabecalhoDe,
  erroDoCodigo,
  type Grupo,
  identidadeDoPlano,
  MOTIVOS_DA_RECUSA,
  politicaDe,
  prazoDe,
  resultadoDe,
  riscoDe,
  ROTULO_RISCO,
} from './textos';

// O pedido aberto (protótipo aprovado): quem pediu e quando, o que muda, o risco e os limites, e a decisão.
// Aprovar pede o código do app autenticador agora (ADR-007) e vale só para o plano mostrado (o hash); recusar
// pede um motivo. No Lite, a frase do que acontece e "Ver detalhes"; no Pro, tudo aberto.

export type Decisao = { ok: true } | { ok: false; texto: string; noCodigo: boolean };

type Props = {
  acao: ActionResponse;
  grupo: Grupo | null;
  agora: Date;
  pro: boolean;
  /** Pode aprovar e recusar (`acoes.aprovar`). */
  podeDecidir: boolean;
  /** A conta de quem vê tem o app autenticador ativo (sem ele, o servidor não deixa aprovar). */
  temApp: boolean;
  titulo: RefObject<HTMLHeadingElement | null>;
  campoCodigo: RefObject<HTMLInputElement | null>;
  aoVoltar: () => void;
  aoAprovar: (acao: ActionResponse, codigo: string) => Promise<Decisao>;
  aoRecusar: (acao: ActionResponse, motivo: string) => Promise<Decisao>;
};

export function DetalhePedido({ acao, grupo, agora, pro, podeDecidir, temApp, titulo, campoCodigo, aoVoltar, aoAprovar, aoRecusar }: Props) {
  const ids = useId();
  const primeiroMotivo = useRef<HTMLButtonElement>(null);
  const [aberto, setAberto] = useState(false);
  const [codigo, setCodigo] = useState('');
  const [erro, setErro] = useState<{ texto: string; noCodigo: boolean } | null>(null);
  const [recusando, setRecusando] = useState(false);
  const [ocupado, setOcupado] = useState<'aprovar' | 'recusar' | null>(null);
  const p = apresentar(acao);
  const cab = cabecalhoDe(acao, agora);
  const plano = identidadeDoPlano(acao);
  const risco = riscoDe(acao);
  const prazo = prazoDe(acao, agora);
  const detalhado = pro || aberto;

  // Outro pedido aberto: o código digitado, o erro e os detalhes abertos eram do anterior.
  useEffect(() => {
    setCodigo('');
    setErro(null);
    setRecusando(false);
    setAberto(false);
  }, [acao.id, acao.plan_hash]);

  useEffect(() => {
    if (recusando) primeiroMotivo.current?.focus();
  }, [recusando]);

  // Código recusado pelo servidor: o foco volta ao campo quando ele já está liberado de novo (durante o envio
  // o campo fica desativado, e campo desativado não recebe foco).
  useEffect(() => {
    if (erro?.noCodigo && ocupado === null) campoCodigo.current?.focus();
  }, [erro, ocupado, campoCodigo]);

  async function aprovar(e: FormEvent) {
    e.preventDefault();
    const invalido = erroDoCodigo(codigo);
    if (invalido) return setErro({ texto: invalido, noCodigo: true });
    setErro(null);
    setOcupado('aprovar');
    const r = await aoAprovar(acao, codigo.trim());
    setOcupado(null);
    if (r.ok) return;
    if (r.noCodigo) setCodigo('');
    setErro(r);
  }

  async function recusar(motivo: string) {
    setErro(null);
    setOcupado('recusar');
    const r = await aoRecusar(acao, motivo);
    setOcupado(null);
    if (!r.ok) setErro(r);
  }

  const voltar = (
    <button className="btn btn--ghost btn--sm voltar" type="button" onClick={aoVoltar}>
      <Icone nome="chevron-left" />
      Voltar para a lista
    </button>
  );
  const cabecalho = (
    <>
      <div className="det-cab">
        <span>
          <b>{cab.quem}</b> {cab.verbo}
        </span>
        <span>· {cab.quando}</span>
      </div>
      <h2 className="det-titulo" id="ap-det-titulo" ref={titulo} tabIndex={-1}>
        {p.titulo}
      </h2>
    </>
  );
  const mudancas = (
    <div className="secao">
      <p className="rotulo-marca">Antes e depois</p>
      <div className="table-wrap">
        <table className="tabela">
          <caption className="sr-only">O que muda se o pedido for aprovado</caption>
          <thead>
            <tr>
              <th scope="col">Item</th>
              <th scope="col">Agora</th>
              <th scope="col">Depois</th>
            </tr>
          </thead>
          <tbody>
            {p.mudancas.map(([item, antes, depois]) => (
              <tr key={item}>
                <th scope="row">{item}</th>
                <td className="ap-antes">{antes}</td>
                <td className="ap-depois">{depois}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );

  if (grupo !== 'pendente') {
    const resultado = resultadoDe(acao);
    return (
      <>
        {voltar}
        {cabecalho}
        <p className="plano-id">
          Plano {plano.plano} · hash <b>{plano.hash}</b>
        </p>
        <div className="secao">
          <div className="politica">
            <Icone nome={resultado.ok ? 'check' : 'x'} />
            <span>{resultado.texto}</span>
          </div>
        </div>
        {mudancas}
      </>
    );
  }

  const parcial = aprovacaoParcial(acao);
  return (
    <>
      {voltar}
      {cabecalho}
      {!pro && (
        <div className="secao secao--lite">
          <p className="lite-frase lite-frase--grande">{p.resumo}</p>
          <div className="lite-chips">
            <span className={`risco risco--${risco}`}>{ROTULO_RISCO[risco]}</span>
            <span className="lite-chip">Dá para desfazer</span>
            <span className="lite-chip">{prazo}</span>
          </div>
          <button className="detalhes-bt" type="button" aria-expanded={aberto} aria-controls={`${ids}-detalhes`} onClick={() => setAberto((x) => !x)}>
            {aberto ? 'Ocultar detalhes' : 'Ver detalhes'}
            <Icone nome="chevron-down" pequeno />
          </button>
        </div>
      )}
      <div id={`${ids}-detalhes`} hidden={!detalhado}>
        <p className="plano-id">
          Plano {plano.plano} · hash <b>{plano.hash}</b> · a aprovação vale só para este plano
        </p>
        {mudancas}
        <div className="secao">
          <p className="rotulo-marca">Risco e limites</p>
          <div className="politica">
            <Icone nome="shield" />
            <span>
              <b className={`risco risco--${risco}`}>{ROTULO_RISCO[risco]}.</b> {politicaDe(acao)}
            </span>
          </div>
          <p className="nota">
            <Icone nome="undo" />
            <span>{p.desfazer}</span>
          </p>
          <p className="nota">
            <Icone nome="clock" />
            <span>Prazo: {prazo}. Se ninguém decidir, o pedido expira e nada é feito.</span>
          </p>
        </div>
      </div>
      {parcial && (
        <p className="alerta-versao" role="status">
          <Icone nome="info" pequeno />
          <span>{parcial}</span>
        </p>
      )}
      {podeDecidir ? (
        <form className="acoes-plano" onSubmit={(e) => disparar(aprovar(e))} noValidate>
          {erro && (
            <p className="campo-erro ap-erro" id={`${ids}-erro`} role="alert">
              {erro.texto}
            </p>
          )}
          {temApp ? (
            <label className="ap-codigo">
              <span>Código do app</span>
              <input
                ref={campoCodigo}
                className="input mono"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                placeholder="000000"
                value={codigo}
                onChange={(e) => {
                  setCodigo(e.target.value.replace(/\D/g, ''));
                  setErro(null);
                }}
                disabled={ocupado !== null}
                aria-invalid={erro?.noCodigo ? true : undefined}
                aria-describedby={erro ? `${ids}-erro` : `${ids}-dica`}
              />
            </label>
          ) : (
            <p className="ap-sem-app">
              Para aprovar, ative o app autenticador em <Link href="/seguranca">Segurança da conta</Link>.
            </p>
          )}
          <button className="btn btn--primary ap-aprovar" type="submit" disabled={!temApp || ocupado !== null} aria-busy={ocupado === 'aprovar'}>
            <Icone nome="check" />
            {ocupado === 'aprovar' ? 'Aprovando…' : 'Aprovar'}
            <kbd className="kbd" aria-hidden="true">
              A
            </kbd>
          </button>
          <button className="btn" type="button" aria-expanded={recusando} aria-controls={`${ids}-motivos`} onClick={() => setRecusando((x) => !x)} disabled={ocupado !== null}>
            <Icone nome="x" />
            Recusar
          </button>
          {temApp && (
            <p className="ap-dica" id={`${ids}-dica`}>
              O código de 6 números que o app autenticador mostra agora. A aprovação vale só para este plano.
            </p>
          )}
          <div className="motivos" id={`${ids}-motivos`} hidden={!recusando} role="group" aria-label="Motivo da recusa">
            {MOTIVOS_DA_RECUSA.map((m, i) => (
              <button key={m} ref={i === 0 ? primeiroMotivo : undefined} className="chip-sug" type="button" onClick={() => disparar(recusar(m))} disabled={ocupado !== null}>
                {m}
              </button>
            ))}
          </div>
        </form>
      ) : (
        <p className="nota ap-so-leitura">
          <Icone nome="lock" />
          <span>Só quem pode aprovar decide este pedido. Você acompanha por aqui.</span>
        </p>
      )}
    </>
  );
}
