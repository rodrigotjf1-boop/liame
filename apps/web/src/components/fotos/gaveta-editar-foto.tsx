'use client';

import {
  type BrandPhoto,
  type BrandPhotoEditPreview,
  type DmsGraphQuota,
  FOTO_EDICAO_PEDIDO_MAX,
  type FotoEdicaoOpcoes,
  problemaDoPedidoDaFoto,
} from '@liame/contracts';
import { type CSSProperties, type RefObject, useId, useRef, useState } from 'react';
import { Icone } from '@/components/ui/icone';
import { useDialogo } from '@/components/ui/use-dialogo';
import { api, chamar, mensagemDe } from '@/lib/api';
import { disparar } from '@/lib/disparar';
import { ENQUADRAMENTOS, oQueMudou } from './edicao';

// Editar a foto pelo DMS Graph (F4; protótipo aprovado em 22/11/2026): luz, fundo, enquadramento e um pedido opcional. O
// resultado é uma prévia: só vira foto nova com a pessoa conferindo que o produto continua igual. A original não muda.

type Props = {
  foto: BrandPhoto;
  quota: DmsGraphQuota | null;
  reserva: RefObject<HTMLElement | null>;
  aoGuardar: (nova: BrandPhoto, quota: DmsGraphQuota | null) => void;
  aoFechar: () => void;
  /** A franquia mudou (a edição contou, mesmo se a pessoa descartar). */
  aoMudarFranquia: (quota: DmsGraphQuota) => void;
};

export function GavetaEditarFoto({ foto, quota: quotaInicial, reserva, aoGuardar, aoFechar, aoMudarFranquia }: Props) {
  const ids = useId();
  const fecharBt = useRef<HTMLButtonElement>(null);
  const corpo = useRef<HTMLDivElement>(null);
  const { ref, fechar, devolverFoco } = useDialogo({ focoInicial: fecharBt, reserva });
  const [opcoes, setOpcoes] = useState<FotoEdicaoOpcoes>({ light: true, background: true, framing: 'original' });
  const [pedido, setPedido] = useState('');
  const [erroDoPedido, setErroDoPedido] = useState('');
  const [erro, setErro] = useState('');
  const [editando, setEditando] = useState(false);
  const [guardando, setGuardando] = useState(false);
  const [previa, setPrevia] = useState<BrandPhotoEditPreview | null>(null);
  const [confere, setConfere] = useState(false);
  const [posicao, setPosicao] = useState(50);
  const [quota, setQuota] = useState(quotaInicial);
  // Repetir depois de uma falha usa a MESMA chave (não gasta de novo); "Fazer outra versão" pede outra.
  const chave = useRef(crypto.randomUUID());
  const guardou = useRef(false);

  const sobra = quota ? Math.max(quota.total - quota.used, 0) : null;
  const semFranquia = quota !== null && quota.total === 0;
  const acabou = quota !== null && quota.total > 0 && quota.used >= quota.total;
  const temAlgo = opcoes.light || opcoes.background || opcoes.framing !== 'original' || pedido.trim() !== '';

  function mudarErro(texto: string) {
    setErro(texto);
    corpo.current?.scrollTo({ top: 0 });
  }

  async function editar() {
    const problema = pedido.trim() ? problemaDoPedidoDaFoto(pedido) : null;
    if (problema) {
      setErroDoPedido(problema.frase);
      return;
    }
    setErro('');
    setErroDoPedido('');
    setEditando(true);
    const r = await chamar(() =>
      api.POST('/v1/brand-photos/{id}/edits', {
        params: { path: { id: foto.id } },
        body: { ...opcoes, ...(pedido.trim() ? { prompt: pedido.trim() } : {}), key: chave.current },
      }),
    );
    setEditando(false);
    if (!r.ok) {
      if (r.problema.code?.startsWith('pedido-')) setErroDoPedido(r.problema.detail ?? 'Este pedido não pode ir.');
      else mudarErro(mensagemDe(r.problema));
      return;
    }
    setPrevia(r.data);
    setConfere(false);
    setPosicao(50);
    if (r.data.quota) {
      setQuota(r.data.quota);
      aoMudarFranquia(r.data.quota);
    }
  }

  function descartarPrevia(p: BrandPhotoEditPreview) {
    disparar(chamar(() => api.DELETE('/v1/brand-photos/edits/{id}', { params: { path: { id: p.id } } })));
  }

  function outraVersao() {
    if (previa) descartarPrevia(previa);
    setPrevia(null);
    chave.current = crypto.randomUUID();
    disparar(editar());
  }

  function descartar() {
    if (previa) descartarPrevia(previa);
    setPrevia(null);
    setConfere(false);
    chave.current = crypto.randomUUID();
  }

  async function guardar() {
    if (!previa) return;
    setErro('');
    setGuardando(true);
    const r = await chamar(() => api.POST('/v1/brand-photos/edits/{id}/save', { params: { path: { id: previa.id } }, body: { confirmed: true } }));
    setGuardando(false);
    if (!r.ok) {
      if (r.problema.code === 'edicao-vencida') {
        setPrevia(null);
        chave.current = crypto.randomUUID();
      }
      mudarErro(mensagemDe(r.problema));
      return;
    }
    guardou.current = true;
    aoGuardar(r.data, quota);
    fechar();
  }

  const ocupado = editando || guardando;
  const proporcao = previa ? `${previa.width} / ${previa.height}` : `${foto.width} / ${foto.height}`;

  return (
    <dialog
      ref={ref}
      className="dialogo dialogo--lado ft-gaveta"
      aria-labelledby={`${ids}-t`}
      onCancel={(e) => {
        if (ocupado) e.preventDefault();
      }}
      onClose={() => {
        // Fechar sem guardar não deixa a prévia parada (a rotina limparia depois).
        if (previa && !guardou.current) descartarPrevia(previa);
        aoFechar();
        devolverFoco();
      }}
      onClick={(e) => {
        if (e.target === ref.current && !ocupado) fechar();
      }}
    >
      <div className="dialogo-form">
        <div className="dialogo-cab">
          <div className="dlg-titulo">
            <p className="rotulo-marca">{previa ? 'Confira antes de guardar' : 'Editar foto'}</p>
            <h2 id={`${ids}-t`}>{foto.product ?? 'Sem produto'}</h2>
          </div>
          <button className="btn btn--icon btn--ghost" type="button" ref={fecharBt} onClick={fechar} aria-label="Fechar" disabled={ocupado}>
            <Icone nome="x" />
          </button>
        </div>
        <div className="dialogo-corpo" ref={corpo}>
          {erro && (
            <p className="dialogo-erro" role="alert">
              <Icone nome="alert" pequeno />
              <span>{erro}</span>
            </p>
          )}
          {previa ? (
            <>
              <div className="dg-compara" style={{ aspectRatio: proporcao, ['--p' as string]: `${posicao}%` } as CSSProperties}>
                <img src={foto.url} alt="Foto original" referrerPolicy="no-referrer" />
                <img className="dg-depois" src={previa.url} alt="Foto editada" referrerPolicy="no-referrer" />
                <span className="dg-divisor" aria-hidden="true" />
                <span className="dg-marca dg-marca--esq" aria-hidden="true">
                  Depois
                </span>
                <span className="dg-marca dg-marca--dir" aria-hidden="true">
                  Antes
                </span>
              </div>
              <div className="campo">
                <label htmlFor={`${ids}-cmp`}>Arraste para comparar</label>
                <input id={`${ids}-cmp`} type="range" min={0} max={100} value={posicao} onChange={(e) => setPosicao(Number(e.target.value))} />
              </div>
              <p className="ft-nota">
                <Icone nome="info" pequeno />
                <span>
                  Mudou: {oQueMudou(opcoes)}.{pedido.trim() ? ` Pedido: “${pedido.trim()}”.` : ''} A imagem leva a marca invisível do Google, e as redes podem mostrar que
                  ela foi editada com IA.
                </span>
              </p>
              <label className="dg-confere" htmlFor={`${ids}-conf`}>
                <input id={`${ids}-conf`} type="checkbox" checked={confere} onChange={(e) => setConfere(e.target.checked)} />
                <span>Conferi: o produto continua igual ao que a loja entrega.</span>
              </label>
              <p className="ft-nota">
                <Icone nome="info" pequeno />
                <span>Esta edição já contou na franquia, mesmo se você descartar.</span>
              </p>
            </>
          ) : (
            <>
              <img className="ft-ver" src={foto.url} alt={foto.description || 'A foto que vai ser editada'} referrerPolicy="no-referrer" />
              {semFranquia || acabou ? (
                <p className="ft-nota ft-nota--aviso">
                  <Icone nome="alert" pequeno />
                  <span>
                    {semFranquia
                      ? 'A edição de foto ainda não foi liberada: a empresa começa com franquia 0, e a DMS libera. A foto segue valendo como está.'
                      : `As ${quota?.total} edições deste mês acabaram. A franquia volta no dia 1º e é a mesma da empresa no Regem e no Liame. A foto segue valendo como está.`}
                  </span>
                </p>
              ) : (
                <>
                  <section aria-labelledby={`${ids}-melhorar`}>
                    <h3 className="rotulo-marca" id={`${ids}-melhorar`}>
                      O que melhorar
                    </h3>
                    {(
                      [
                        ['light', 'Melhorar a luz', 'Corrige a foto escura ou amarelada.'],
                        ['background', 'Limpar o fundo', 'Tira o que distrai atrás do produto.'],
                      ] as const
                    ).map(([campo, nome, dica]) => (
                      <div className="dg-opcao" key={campo}>
                        <span>
                          <b>{nome}</b>
                          <small>{dica}</small>
                        </span>
                        <button
                          type="button"
                          className="dg-chave"
                          role="switch"
                          aria-checked={opcoes[campo]}
                          aria-label={nome}
                          disabled={editando}
                          onClick={() => setOpcoes((o) => ({ ...o, [campo]: !o[campo] }))}
                        />
                      </div>
                    ))}
                  </section>
                  <section aria-labelledby={`${ids}-quadro`}>
                    <h3 className="rotulo-marca" id={`${ids}-quadro`}>
                      Enquadramento
                    </h3>
                    <div className="dg-quadros" role="group" aria-labelledby={`${ids}-quadro`}>
                      {ENQUADRAMENTOS.map((q) => (
                        <button
                          key={q.valor}
                          type="button"
                          className="dg-quadro"
                          aria-pressed={opcoes.framing === q.valor}
                          disabled={editando}
                          onClick={() => setOpcoes((o) => ({ ...o, framing: q.valor }))}
                        >
                          {q.rotulo}
                        </button>
                      ))}
                    </div>
                  </section>
                  <div className="campo">
                    <label htmlFor={`${ids}-pedido`}>
                      Pedido extra <span className="campo-dica">(opcional)</span>
                    </label>
                    <textarea
                      className="input"
                      id={`${ids}-pedido`}
                      rows={2}
                      maxLength={FOTO_EDICAO_PEDIDO_MAX}
                      value={pedido}
                      disabled={editando}
                      placeholder="Ex.: fundo de madeira clara, com luz de fim de tarde"
                      aria-describedby={`${ids}-pedido-dica`}
                      aria-invalid={erroDoPedido ? true : undefined}
                      onChange={(e) => {
                        setPedido(e.target.value);
                        setErroDoPedido('');
                        // O pedido mudou: é outra edição, com outra chave.
                        chave.current = crypto.randomUUID();
                      }}
                    />
                    <span className="dg-linha">
                      <span className="campo-dica" id={`${ids}-pedido-dica`}>
                        Fale de luz, fundo ou cenário. O produto não muda.
                      </span>
                      <span className="ft-contador">
                        {pedido.length} de {FOTO_EDICAO_PEDIDO_MAX}
                      </span>
                    </span>
                    {erroDoPedido && (
                      <p className="dialogo-erro" role="alert">
                        <Icone nome="alert" pequeno />
                        <span>
                          <b>Este pedido não pode ir.</b> {erroDoPedido} Nada foi gasto.
                        </span>
                      </p>
                    )}
                  </div>
                  <p className="ft-nota dg-nota-ia">
                    <Icone nome="info" pequeno />
                    <span>
                      <b>O produto não muda.</b> O Liame manda manter a comida, o tamanho e os ingredientes, mesmo com o seu pedido. Nada é escrito na foto.
                    </span>
                  </p>
                  <p className="ft-nota">
                    <Icone nome="info" pequeno />
                    <span>A foto vai ao Google para a edição, fora do Brasil. Use só fotos da empresa, sem pessoas que dê para reconhecer.</span>
                  </p>
                </>
              )}
              {quota && (
                <div className="dg-franquia">
                  <span className="dg-linha">
                    <span>Edições de foto neste mês</span>
                    <b>
                      {quota.used} de {quota.total}
                    </b>
                  </span>
                  <span className="dg-barra" aria-hidden="true">
                    <i style={{ width: `${quota.total ? Math.min(Math.round((quota.used / quota.total) * 100), 100) : 0}%` }} />
                  </span>
                </div>
              )}
              {editando && (
                <p className="dg-espera" role="status">
                  <span className="dg-gira" aria-hidden="true" />
                  <span>Editando a foto. Pode levar até 1 minuto.</span>
                </p>
              )}
            </>
          )}
        </div>
        <div className="dialogo-acoes">
          {previa ? (
            <>
              <button className="btn" type="button" onClick={descartar} disabled={guardando}>
                Descartar
              </button>
              <button className="btn" type="button" onClick={outraVersao} disabled={guardando || editando || semFranquia || acabou}>
                Fazer outra versão (usa 1)
              </button>
              <span className="spacer" />
              <button className="btn btn--primary" type="button" onClick={() => disparar(guardar())} disabled={!confere || guardando}>
                {guardando ? 'Guardando…' : 'Guardar como nova foto'}
              </button>
            </>
          ) : (
            <>
              <span className="spacer" />
              <button className="btn" type="button" onClick={fechar} disabled={editando}>
                Cancelar
              </button>
              {!semFranquia && !acabou && (
                <button className="btn btn--primary" type="button" onClick={() => disparar(editar())} disabled={!temAlgo || editando}>
                  {editando ? 'Editando…' : sobra !== null ? `Editar foto (usa 1 de ${sobra})` : 'Editar foto'}
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </dialog>
  );
}
