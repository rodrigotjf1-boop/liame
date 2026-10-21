'use client';

import type { BrandPhoto } from '@liame/contracts';
import { type FormEvent, type RefObject, useEffect, useId, useRef, useState } from 'react';
import { Icone } from '@/components/ui/icone';
import { useDialogo } from '@/components/ui/use-dialogo';
import { api, chamar, mensagemDe, type Problema } from '@/lib/api';
import { disparar } from '@/lib/disparar';
import { DESCRICAO_MAX, medidas, mudancas, NOTA_DE_NITIDEZ, nomeDoProduto, notaDoRecorte, quemEnviou } from './textos';

// Uma foto (P20, gaveta à direita): a foto inteira, as notas para o Instagram, o produto (os de Minha marca, ou "Sem
// produto"), o que aparece nela (opcional), as medidas e quem enviou. Quem envia muda e apaga; quem só vê, vê.

type Props = {
  foto: BrandPhoto;
  produtos: string[];
  podeMudar: boolean;
  /** A confirmação de apagar está aberta (por cima da gaveta). */
  apagando: boolean;
  agora: Date;
  reserva: RefObject<HTMLElement | null>;
  aoSalvar: (foto: BrandPhoto, mudou: boolean) => void;
  aoPedirApagar: () => void;
  /** A foto saiu (apagada por outra pessoa) ou a função foi desligada: a tela lê a lista de novo. */
  aoMudarLa: (problema: Problema) => void;
  /** O produto saiu de Minha marca enquanto a gaveta estava aberta: a tela lê os produtos de novo. */
  aoProdutosMudarem: () => void;
  /** A foto inteira não carregou (o endereço de 5 minutos venceu): a tela pede endereços novos. */
  aoFalharImagem: () => void;
  aoFechar: () => void;
};

export function GavetaFoto({ foto, produtos, podeMudar, apagando, agora, reserva, aoSalvar, aoPedirApagar, aoMudarLa, aoProdutosMudarem, aoFalharImagem, aoFechar }: Props) {
  const ids = useId();
  const campo = useRef<HTMLSelectElement>(null);
  const fecharBt = useRef<HTMLButtonElement>(null);
  const corpo = useRef<HTMLDivElement>(null);
  const { ref, fechar, devolverFoco } = useDialogo({ focoInicial: podeMudar ? campo : fecharBt, reserva });
  const [produto, setProduto] = useState(foto.product ?? '');
  const [descricao, setDescricao] = useState(foto.description);
  const [erro, setErro] = useState<{ texto: string; produto: boolean } | null>(null);
  const [enviando, setEnviando] = useState(false);
  const nome = nomeDoProduto(foto.product);
  const recorte = notaDoRecorte(foto.instagram_crop);
  const foraDaMarca = foto.product !== null && !produtos.includes(foto.product);

  // O erro aparece no começo da gaveta: ela rola até ele.
  useEffect(() => {
    if (erro) corpo.current?.scrollTo({ top: 0 });
  }, [erro]);

  async function salvar(e: FormEvent) {
    e.preventDefault();
    const corpoDoPedido = mudancas(foto, produto, descricao);
    if (!corpoDoPedido) {
      aoSalvar(foto, false);
      return fechar();
    }
    setErro(null);
    setEnviando(true);
    const r = await chamar(() => api.PATCH('/v1/brand-photos/{id}', { params: { path: { id: foto.id } }, body: corpoDoPedido }));
    setEnviando(false);
    if (r.ok) {
      aoSalvar(r.data, true);
      return fechar();
    }
    if (r.problema.code === 'foto-nao-encontrada' || r.problema.code === 'funcao-desligada') return aoMudarLa(r.problema);
    if (r.problema.code === 'produto-fora-da-marca') {
      aoProdutosMudarem();
      setErro({ texto: 'Este produto saiu de Minha marca. Escolha outro, ou "Sem produto".', produto: true });
      campo.current?.focus();
      return;
    }
    setErro({ texto: mensagemDe(r.problema), produto: false });
  }

  const fatos: [string, string][] = [
    ...(podeMudar ? [] : ([['Produto', nome], ...(foto.description ? [['O que aparece', foto.description]] : [])] as [string, string][])),
    ['Medidas', medidas(foto)],
    ['Enviada', quemEnviou(foto, agora)],
  ];

  return (
    <dialog
      ref={ref}
      className="dialogo dialogo--lado ft-gaveta"
      aria-labelledby={`${ids}-t`}
      onClose={() => {
        aoFechar();
        devolverFoco();
      }}
      onClick={(e) => {
        if (e.target === ref.current && !enviando) fechar();
      }}
    >
      <form className="dialogo-form" onSubmit={(e) => disparar(salvar(e))} noValidate>
        <div className="dialogo-cab">
          <div className="dlg-titulo">
            <p className="rotulo-marca">Foto</p>
            <h2 id={`${ids}-t`}>{nome}</h2>
          </div>
          <button className="btn btn--icon btn--ghost" type="button" ref={fecharBt} onClick={fechar} aria-label="Fechar" disabled={enviando}>
            <Icone nome="x" />
          </button>
        </div>
        <div className="dialogo-corpo" ref={corpo}>
          {erro && (
            <p className="dialogo-erro" role="alert">
              <Icone nome="alert" pequeno />
              <span>{erro.texto}</span>
            </p>
          )}
          <img className="ft-ver" src={foto.url} alt={foto.description || `Foto do produto: ${nome}`} referrerPolicy="no-referrer" onError={aoFalharImagem} />
          {recorte && (
            <p className="ft-nota">
              <Icone nome="info" pequeno />
              <span>{recorte}</span>
            </p>
          )}
          {foto.narrow_for_instagram && (
            <p className="ft-nota ft-nota--aviso">
              <Icone nome="alert" pequeno />
              <span>{NOTA_DE_NITIDEZ}</span>
            </p>
          )}
          {podeMudar && (
            <>
              <div className="campo">
                <label htmlFor={`${ids}-produto`}>Produto</label>
                <select
                  className="input"
                  id={`${ids}-produto`}
                  ref={campo}
                  value={produto}
                  onChange={(e) => {
                    setProduto(e.target.value);
                    if (erro?.produto) setErro(null);
                  }}
                  aria-describedby={`${ids}-produto-dica`}
                  aria-invalid={erro?.produto ? true : undefined}
                  disabled={enviando}
                >
                  {foraDaMarca && <option value={foto.product ?? ''}>{`${foto.product} (saiu de Minha marca)`}</option>}
                  {produtos.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                  <option value="">Sem produto</option>
                </select>
                <span className="campo-dica" id={`${ids}-produto-dica`}>
                  Os produtos vêm de Minha marca.
                </span>
              </div>
              <div className="campo">
                <label htmlFor={`${ids}-desc`}>
                  O que aparece na foto <span className="campo-dica">(opcional)</span>
                </label>
                <textarea
                  className="input"
                  id={`${ids}-desc`}
                  rows={2}
                  maxLength={DESCRICAO_MAX}
                  value={descricao}
                  onChange={(e) => setDescricao(e.target.value)}
                  aria-describedby={`${ids}-desc-n`}
                  disabled={enviando}
                />
                <span className="ft-contador" id={`${ids}-desc-n`}>
                  {descricao.length} de {DESCRICAO_MAX}
                </span>
              </div>
            </>
          )}
          <dl className="ft-fatos">
            {fatos.map(([t, d]) => (
              <div key={t}>
                <dt>{t}</dt>
                <dd>{d}</dd>
              </div>
            ))}
          </dl>
        </div>
        <div className="dialogo-acoes">
          {podeMudar ? (
            <>
              <button className="btn btn--perigo" type="button" onClick={aoPedirApagar} aria-haspopup="dialog" aria-expanded={apagando} disabled={enviando}>
                <Icone nome="trash" />
                Apagar foto
              </button>
              <span className="spacer" />
              <button className="btn" type="button" onClick={fechar} disabled={enviando}>
                Cancelar
              </button>
              <button className="btn btn--primary" type="submit" disabled={enviando}>
                {enviando ? 'Salvando…' : 'Salvar'}
              </button>
            </>
          ) : (
            <button className="btn" type="button" onClick={fechar}>
              Fechar
            </button>
          )}
        </div>
      </form>
    </dialog>
  );
}
