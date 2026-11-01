'use client';

import type { TeamModelPurposeState, TeamModelsResponse } from '@liame/contracts';
import { type ReactNode, useState } from 'react';
import { Icone } from '@/components/ui/icone';
import { atualDe, avisoDoRetirado, baseDaEstimativa, type CargaDosModelos, chaveDoModelo, estimativaDe, notaDe, quemUsaTexto, REGRAS_DO_CATALOGO, velocidadeDe } from './modelos-textos';
import { Avatar } from './pecas';
import { notaDaCotacao } from './textos';

// "Modelos de IA" em Sua equipe, só no Pro (mockups/prototipo-equipe.html, P7 aprovado em 03/10/2026; A3, I13;
// D-A3-12 e D-A3-25 a D-A3-28): o modelo de cada finalidade, dentro do catálogo do Liame. No Lite, tudo fica no
// automático. Desenhado só com o que chega por parâmetro (`/v1/team/models`).

export interface AcoesDosModelos {
  /** A finalidade que está salvando (`modelo-<finalidade>`), ou nula. */
  ocupado: string | null;
  /** A finalidade com o formulário aberto, ou nula. */
  editando: string | null;
  aoEditar: (finalidade: string | null) => void;
  aoSalvar: (finalidade: string, modelo: { provider: string; model: string } | null) => void;
  aoRecarregar: () => void;
}

function Finalidade({ p, m, acoes }: { p: TeamModelPurposeState; m: TeamModelsResponse; acoes: AcoesDosModelos }) {
  const atual = atualDe(p, m.usd_brl);
  const escolhaAtual = p.choice?.offered ? chaveDoModelo(p.choice) : 'auto';
  const [marcado, setMarcado] = useState(escolhaAtual);
  const editando = acoes.editando === p.purpose;
  const salvando = acoes.ocupado === `modelo-${p.purpose}`;
  const retirado = avisoDoRetirado(p);
  const nomeDoAutomatico = p.automatic?.label ?? 'o modelo de cada tarefa';
  return (
    <div className="eqp-bloco" id={`mdl-${p.purpose}`}>
      <div className="eqp-bloco-cab">
        <h3 id={`mdl-${p.purpose}-t`} tabIndex={-1}>
          {p.label}
        </h3>
        {p.members.length > 0 && <span className="eixo-nota">{quemUsaTexto(p.members)}</span>}
      </div>
      <p className="mdl-atual">
        <b>{atual.titulo}</b>
        <span className="eixo-nota">{atual.nota}</span>
      </p>
      {retirado && (
        <p className="mdl-aviso" role="status">
          {retirado}
        </p>
      )}
      <p className="card-sub">Base da estimativa: {baseDaEstimativa(p, m.window)}.</p>
      {p.options.length === 0 ? (
        <p className="card-sub">Por enquanto, só o automático: nenhum outro modelo passou no teste de todas as tarefas desta finalidade.</p>
      ) : !m.can_change ? (
        <p className="card-sub">Só o Dono e o Administrador trocam o modelo.</p>
      ) : editando ? (
        <form
          className="mdl-form"
          onSubmit={(e) => {
            e.preventDefault();
            const o = p.options.find((x) => chaveDoModelo(x) === marcado);
            acoes.aoSalvar(p.purpose, o ? { provider: o.provider, model: o.model } : null);
          }}
        >
          <fieldset className="mdl-opcoes" disabled={salvando}>
            <legend>Modelo para {p.label.toLowerCase()}</legend>
            <label className="mdl-op">
              <input type="radio" name={`mdl-${p.purpose}-op`} value="auto" checked={marcado === 'auto'} onChange={() => setMarcado('auto')} />
              <span className="mdl-op-nome">Automático (recomendado)</span>
              <span className="mdl-op-meta">O Liame escolhe pelo teste da finalidade; hoje, {nomeDoAutomatico}.</span>
            </label>
            {p.options.map((o) => (
              <label className="mdl-op" key={chaveDoModelo(o)}>
                <input type="radio" name={`mdl-${p.purpose}-op`} value={chaveDoModelo(o)} checked={marcado === chaveDoModelo(o)} onChange={() => setMarcado(chaveDoModelo(o))} />
                <span className="mdl-op-nome">{o.label}</span>
                <span className="mdl-op-meta">
                  {estimativaDe(o, m.usd_brl)} · {velocidadeDe(o.speed)} · {notaDe(o.eval_score)}
                </span>
              </label>
            ))}
          </fieldset>
          <div className="mdl-acoes">
            <button className="btn btn--primary btn--sm" type="submit" disabled={salvando || marcado === escolhaAtual} aria-busy={salvando}>
              {salvando ? 'Salvando…' : 'Salvar a troca'}
            </button>
            <button
              className="btn btn--sm"
              type="button"
              disabled={salvando}
              onClick={() => {
                setMarcado(escolhaAtual);
                acoes.aoEditar(null);
              }}
            >
              Cancelar
            </button>
          </div>
        </form>
      ) : (
        <div className="mdl-acoes">
          <button className="btn btn--sm" type="button" id={`mdl-${p.purpose}-trocar`} disabled={acoes.ocupado !== null} onClick={() => acoes.aoEditar(p.purpose)}>
            <Icone nome="sliders" pequeno />
            Trocar o modelo
          </button>
        </div>
      )}
    </div>
  );
}

export function DetalheDosModelos({ carga, acoes, voltar }: { carga: CargaDosModelos; acoes: AcoesDosModelos; voltar: ReactNode }) {
  const cab = (
    <div className="eqp-cab">
      <Avatar icone="sparkles" grande />
      <div className="eqp-cab-txt">
        <h2 id="eqp-det-t" tabIndex={-1}>
          Modelos de IA
        </h2>
        <p>O modelo de cada finalidade, dentro do catálogo do Liame</p>
      </div>
    </div>
  );
  if (carga.tipo === 'carregando') {
    return (
      <>
        {voltar}
        {cab}
        <div className="eqp-bloco" aria-busy="true">
          <span className="esqueleto" />
          <span className="esqueleto esqueleto--medio" />
        </div>
      </>
    );
  }
  if (carga.tipo === 'erro') {
    return (
      <>
        {voltar}
        {cab}
        <div className="eqp-bloco" role="status">
          <p>Não deu para carregar os modelos agora. Nada mudou: as respostas seguem com o modelo de antes.</p>
          <div className="mdl-acoes">
            <button className="btn btn--sm" type="button" onClick={acoes.aoRecarregar}>
              <Icone nome="refresh" pequeno />
              Tentar de novo
            </button>
          </div>
        </div>
      </>
    );
  }
  const m = carga.dados;
  const cotacao = notaDaCotacao(m.usd_brl);
  return (
    <>
      {voltar}
      {cab}
      <p className="eqp-resumo">
        No Lite, tudo fica no automático, que é o recomendado. Aqui você pode escolher o modelo de cada finalidade, vendo o custo estimado, a velocidade e a nota no teste do Liame. A troca vale a partir da próxima resposta, para todas as marcas da
        empresa.
      </p>
      {m.purposes.map((p) => (
        <Finalidade key={p.purpose} p={p} m={m} acoes={acoes} />
      ))}
      <div className="eqp-bloco">
        <div className="eqp-bloco-cab">
          <h3>Regras do catálogo</h3>
        </div>
        <ul className="eqp-lite">
          {REGRAS_DO_CATALOGO.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
        {cotacao && <p className="eixo-nota">{cotacao}</p>}
      </div>
    </>
  );
}
