'use client';

import type { BrandDossierContent, BrandDossierResponse, BrandDossierVersionMeta, BrandDossierVersionResponse } from '@liame/contracts';
import { type RefObject, useCallback, useEffect, useId, useRef, useState } from 'react';
import { Icone } from '@/components/ui/icone';
import { useDialogo } from '@/components/ui/use-dialogo';
import { api, chamar, mensagemDe } from '@/lib/api';
import { disparar } from '@/lib/disparar';
import { mudancasEntre, origemDaVersao, quemConfirmou } from './textos';

// As versões da marca (protótipo P6): cada mudança confirmada vira uma versão; a mais nova é a que os funcionários
// de IA usam. Abrir uma versão antiga mostra o que mudou dela para a que está em uso; voltar a ela cria uma versão
// nova, igual (nada é apagado).

type Props = {
  marca: { id: string; nome: string };
  /** A versão em uso (a que a pessoa está vendo na página). */
  atual: { versao: number; conteudo: BrandDossierContent };
  podeEditar: boolean;
  agora: Date;
  reserva: RefObject<HTMLElement | null>;
  aoRestaurar: (dossie: BrandDossierResponse, deVersao: number) => void;
  aoFechar: () => void;
};

type Lista = { tipo: 'carregando' } | { tipo: 'ok'; itens: BrandDossierVersionMeta[] } | { tipo: 'erro'; mensagem: string };
type Aberta = { tipo: 'carregando'; n: number } | { tipo: 'ok'; v: BrandDossierVersionResponse } | { tipo: 'erro'; n: number; mensagem: string };

export function GavetaVersoes({ marca, atual, podeEditar, agora, reserva, aoRestaurar, aoFechar }: Props) {
  const ids = useId();
  const fecharBt = useRef<HTMLButtonElement>(null);
  const tituloVersao = useRef<HTMLHeadingElement>(null);
  const lista1 = useRef<HTMLOListElement>(null);
  const { ref, fechar, devolverFoco } = useDialogo({ focoInicial: fecharBt, reserva });
  const [lista, setLista] = useState<Lista>({ tipo: 'carregando' });
  const [aberta, setAberta] = useState<Aberta | null>(null);
  const [confirmando, setConfirmando] = useState(false);
  const [erro, setErro] = useState('');
  const [enviando, setEnviando] = useState(false);

  const carregar = useCallback(async () => {
    setLista({ tipo: 'carregando' });
    const r = await chamar(() => api.GET('/v1/brand-dossier/versions', { params: { query: { brand_id: marca.id } } }));
    setLista(r.ok ? { tipo: 'ok', itens: r.data.items } : { tipo: 'erro', mensagem: mensagemDe(r.problema) });
  }, [marca.id]);

  useEffect(() => {
    disparar(carregar());
  }, [carregar]);

  async function abrir(n: number) {
    setErro('');
    setConfirmando(false);
    setAberta({ tipo: 'carregando', n });
    const r = await chamar(() => api.GET('/v1/brand-dossier/versions/{version}', { params: { path: { version: n }, query: { brand_id: marca.id } } }));
    setAberta(r.ok ? { tipo: 'ok', v: r.data } : { tipo: 'erro', n, mensagem: mensagemDe(r.problema) });
  }

  // Ao abrir uma versão, o foco vai para o título dela; ao voltar para a lista, para o primeiro botão da lista.
  useEffect(() => {
    if (aberta?.tipo === 'ok') tituloVersao.current?.focus();
  }, [aberta]);

  function voltarParaLista() {
    setAberta(null);
    setConfirmando(false);
    setErro('');
    // A lista volta a existir no próximo desenho.
    setTimeout(() => (lista1.current?.querySelector<HTMLElement>('button') ?? fecharBt.current)?.focus(), 0);
  }

  async function restaurar(n: number) {
    setErro('');
    setEnviando(true);
    const r = await chamar(() => api.POST('/v1/brand-dossier/restore', { body: { brand_id: marca.id, version: n, base_version: atual.versao } }));
    setEnviando(false);
    if (!r.ok) {
      setConfirmando(false);
      return setErro(mensagemDe(r.problema));
    }
    aoRestaurar(r.data, n);
    fechar();
  }

  let corpo;
  if (aberta) {
    if (aberta.tipo === 'carregando') {
      corpo = (
        <div className="mk-versao-ver" aria-busy="true">
          <p className="sr-only">Carregando a versão {aberta.n}…</p>
          <span className="esqueleto esqueleto--curto" aria-hidden="true" />
          <span className="esqueleto" aria-hidden="true" />
        </div>
      );
    } else if (aberta.tipo === 'erro') {
      corpo = (
        <div className="mk-versao-ver">
          <button className="btn btn--sm btn--ghost" type="button" onClick={voltarParaLista}>
            <Icone nome="chevron-left" pequeno />
            Todas as versões
          </button>
          <p className="dialogo-erro" role="alert">
            <Icone nome="alert" pequeno />
            <span>{aberta.mensagem}</span>
          </p>
          <div className="mk-versao-acoes">
            <button className="btn btn--sm" type="button" onClick={() => disparar(abrir(aberta.n))}>
              <Icone nome="refresh" pequeno />
              Tentar de novo
            </button>
          </div>
        </div>
      );
    } else {
      const { meta, content } = aberta.v;
      const dif = mudancasEntre(content, atual.conteudo);
      corpo = (
        <div className="mk-versao-ver">
          <button className="btn btn--sm btn--ghost" type="button" onClick={voltarParaLista}>
            <Icone nome="chevron-left" pequeno />
            Todas as versões
          </button>
          <div>
            <h3 tabIndex={-1} ref={tituloVersao}>
              Versão {meta.version}
            </h3>
            <p className="card-sub">Confirmada por {quemConfirmou(meta, agora)}.</p>
          </div>
          <div className="mk-info">
            <Icone nome="info" pequeno />
            <span>
              Da versão {meta.version} para a versão em uso ({atual.versao}), mudou:
            </span>
          </div>
          <ul className="mk-dif">
            {dif.length ? (
              dif.map((m) => (
                <li key={m}>
                  <Icone nome="arrow-right" pequeno />
                  <span>{m}</span>
                </li>
              ))
            ) : (
              <li>Nada: o conteúdo é o mesmo.</li>
            )}
          </ul>
          {podeEditar && dif.length > 0 && (
            <>
              {confirmando ? (
                <div className="mk-versao-acoes mk-confirma" key="confirma" role="group" aria-label="Confirmar a volta">
                  <p>
                    Isso cria a versão {atual.versao + 1}, igual à {meta.version}. Nada é apagado.
                  </p>
                  <button className="btn btn--sm btn--primary" type="button" onClick={() => disparar(restaurar(meta.version))} disabled={enviando} aria-busy={enviando} autoFocus>
                    {enviando ? 'Voltando…' : `Voltar para a versão ${meta.version}`}
                  </button>
                  <button className="btn btn--sm" type="button" onClick={() => setConfirmando(false)} disabled={enviando}>
                    Cancelar
                  </button>
                </div>
              ) : (
                <div className="mk-versao-acoes" key="acoes">
                  <button className="btn btn--primary" type="button" onClick={() => setConfirmando(true)}>
                    <Icone nome="undo" pequeno />
                    Voltar para esta versão
                  </button>
                </div>
              )}
              <p className="explica-nota">Voltar cria uma versão nova, igual à {meta.version}. Nenhuma versão é apagada.</p>
            </>
          )}
        </div>
      );
    }
  } else if (lista.tipo === 'carregando') {
    corpo = (
      <div aria-busy="true">
        <p className="sr-only">Carregando as versões…</p>
        <span className="esqueleto esqueleto--curto" aria-hidden="true" />
        <span className="esqueleto" aria-hidden="true" />
        <span className="esqueleto esqueleto--medio" aria-hidden="true" />
      </div>
    );
  } else if (lista.tipo === 'erro') {
    corpo = (
      <>
        <p className="dialogo-erro" role="alert">
          <Icone nome="alert" pequeno />
          <span>{lista.mensagem}</span>
        </p>
        <div className="mk-versao-acoes">
          <button className="btn btn--sm" type="button" onClick={() => disparar(carregar())}>
            <Icone nome="refresh" pequeno />
            Tentar de novo
          </button>
        </div>
      </>
    );
  } else {
    corpo = (
      <>
        <p className="card-sub">Cada mudança confirmada vira uma versão. Os funcionários de IA usam a mais nova, e cada texto que eles fazem guarda a versão que leu.</p>
        <ol className="mk-versoes" ref={lista1}>
          {lista.itens.map((v) => {
            const emUso = v.version === atual.versao;
            const origem = origemDaVersao(v);
            return (
              <li className="mk-versao" key={v.version} aria-current={emUso ? 'true' : undefined}>
                <div className="mk-versao-cab">
                  <b>Versão {v.version}</b>
                  {emUso && <span className="st st--concluido">Em uso</span>}
                  <span>
                    {quemConfirmou(v, agora)}
                    {origem ? ` · ${origem}` : ''}
                  </span>
                </div>
                <ul>
                  {v.changes.length ? v.changes.map((m) => <li key={m}>{m}</li>) : <li>Sem mudança registrada.</li>}
                </ul>
                {!emUso && (
                  <div className="mk-versao-acoes">
                    <button className="btn btn--sm" type="button" onClick={() => disparar(abrir(v.version))}>
                      Ver esta versão
                      <span className="sr-only"> ({v.version})</span>
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      </>
    );
  }

  return (
    <dialog
      ref={ref}
      className="dialogo dialogo--lado"
      aria-labelledby={`${ids}-t`}
      onClose={() => {
        aoFechar();
        devolverFoco();
      }}
      onClick={(e) => {
        if (e.target === ref.current && !enviando) fechar();
      }}
    >
      <div className="dialogo-form">
        <div className="dialogo-cab">
          <div className="dlg-titulo">
            <p className="rotulo-marca">Minha marca</p>
            <h2 id={`${ids}-t`}>Versões</h2>
          </div>
          <button ref={fecharBt} className="btn btn--icon btn--ghost" type="button" onClick={fechar} aria-label="Fechar" disabled={enviando}>
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
          {corpo}
        </div>
      </div>
    </dialog>
  );
}
