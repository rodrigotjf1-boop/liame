'use client';

import type { ResearchListResponse, ResearchResponse } from '@liame/contracts';
import { type FormEvent, type RefObject, useEffect, useId, useRef, useState } from 'react';
import { Faixa } from '@/components/ui/faixa';
import { Icone } from '@/components/ui/icone';
import { useDialogo } from '@/components/ui/use-dialogo';
import { api, chamar, mensagemDe } from '@/lib/api';
import { disparar } from '@/lib/disparar';
import { conferirEndereco, limiteDoDia, linhaDoLimite, quandoRecomeca, TIPOS_DE_PAGINA, type TipoDePagina } from './pesquisador';

// Pedir a leitura de uma página (mockups/prototipo-pesquisador.html, P25 aprovado em 21/10/2026): o tipo da página, o
// endereço e o que o Liame faz e não faz. A rota confere o endereço (422 `endereco-recusado`, com o porquê), o
// Pesquisador ligado (409 `pesquisador-desligado`) e o limite do dia (429); o mesmo endereço já na fila devolve o
// pedido que está lá (`marca/pesquisa.service.ts`).

type Props = {
  marcaId: string;
  rascunho: { kind: TipoDePagina; url: string } | null;
  daily: ResearchListResponse['daily'];
  agora: Date;
  reserva: RefObject<HTMLElement | null>;
  aoPedido: (pedido: ResearchResponse) => void;
  /** O Pesquisador foi desligado enquanto a gaveta estava aberta: a tela lê a lista de novo e diz por quê. */
  aoDesligado: (mensagem: string) => void;
  /** A rota recusou pelo limite do dia (a conta da tela estava velha: outra pessoa pediu): a lista é lida de novo ao fechar. */
  aoLimite: () => void;
  aoFechar: () => void;
};

export function GavetaPagina({ marcaId, rascunho, daily, agora, reserva, aoPedido, aoDesligado, aoLimite, aoFechar }: Props) {
  const ids = useId();
  const campo = useRef<HTMLInputElement>(null);
  const fecharBt = useRef<HTMLButtonElement>(null);
  const pedirBt = useRef<HTMLButtonElement>(null);
  const noLimite = daily.used >= daily.limit;
  const { ref, fechar, devolverFoco } = useDialogo({ focoInicial: noLimite ? fecharBt : campo, reserva });
  const [kind, setKind] = useState<TipoDePagina>(rascunho?.kind ?? 'cardapio');
  const [url, setUrl] = useState(rascunho?.url ?? '');
  const [erroDoCampo, setErroDoCampo] = useState('');
  const [erro, setErro] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [vezDoErro, setVezDoErro] = useState(0);
  const [vezDoAviso, setVezDoAviso] = useState(0);

  // O foco vai para o campo com erro depois de o erro aparecer (V86).
  useEffect(() => {
    if (vezDoErro) ref.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [vezDoErro, ref]);
  // O erro que não é do campo (limite, rede): o botão de pedir, que ficou desabilitado durante o pedido, volta a ter o
  // foco (V82), e o aviso é lido pelo `role="alert"`.
  useEffect(() => {
    if (vezDoAviso) pedirBt.current?.focus();
  }, [vezDoAviso]);

  async function pedir(e: FormEvent) {
    e.preventDefault();
    if (noLimite || enviando) return;
    setErro('');
    const problema = conferirEndereco(url);
    if (problema) {
      setErroDoCampo(problema);
      setVezDoErro((v) => v + 1);
      return;
    }
    setErroDoCampo('');
    setEnviando(true);
    const r = await chamar(() => api.POST('/v1/brand-dossier/research', { body: { brand_id: marcaId, kind, url: url.trim() } }));
    setEnviando(false);
    if (r.ok) {
      aoPedido(r.data);
      fechar();
      return;
    }
    if (r.problema.code === 'endereco-recusado') {
      setErroDoCampo(r.problema.detail ?? 'Confira o endereço da página.');
      setVezDoErro((v) => v + 1);
      return;
    }
    if (r.problema.code === 'pesquisador-desligado') {
      aoDesligado(mensagemDe(r.problema));
      fechar();
      return;
    }
    if (r.problema.status === 429) aoLimite();
    setErro(r.problema.status === 429 ? `${limiteDoDia(daily)}. A conta recomeça ${quandoRecomeca(daily.resets_at, agora)}.` : mensagemDe(r.problema));
    setVezDoAviso((v) => v + 1);
  }

  return (
    <dialog
      ref={ref}
      className="dialogo dialogo--lado pq-gaveta"
      aria-labelledby={`${ids}-t`}
      onClose={() => {
        aoFechar();
        devolverFoco();
      }}
      onClick={(e) => {
        if (e.target === ref.current && !enviando) fechar();
      }}
    >
      <form className="dialogo-form" noValidate onSubmit={(e) => disparar(pedir(e))}>
        <div className="dialogo-cab">
          <div className="dlg-titulo">
            <p className="rotulo-marca">Minha marca · Pesquisador</p>
            <h2 id={`${ids}-t`}>Ler uma página</h2>
          </div>
          <button className="btn btn--icon btn--ghost" type="button" onClick={fechar} aria-label="Fechar" disabled={enviando}>
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
          {noLimite && (
            <Faixa
              icone={<Icone nome="clock" />}
              titulo={limiteDoDia(daily)}
              texto={`A conta recomeça ${quandoRecomeca(daily.resets_at, agora)}. As que estão na fila continuam.`}
            />
          )}
          <fieldset className="campo">
            <legend>Que página é</legend>
            <div className="opcoes">
              {TIPOS_DE_PAGINA.map((t) => (
                <label className="opcao" key={t.id}>
                  <input type="radio" name={`${ids}-kind`} value={t.id} checked={kind === t.id} onChange={() => setKind(t.id)} disabled={noLimite} />
                  <span className="opcao-txt">
                    <b>{t.opcao}</b>
                    <span className="campo-dica">{t.dica}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          <div className="campo">
            <label htmlFor={`${ids}-url`}>
              Endereço da página <span className="campo-dica">Copie da barra do navegador. Só página pública, começando com https://</span>
            </label>
            <input
              ref={campo}
              id={`${ids}-url`}
              className="input"
              type="url"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              maxLength={2048}
              placeholder="https://"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              disabled={noLimite}
              aria-invalid={erroDoCampo ? true : undefined}
              aria-describedby={erroDoCampo ? `${ids}-url-erro` : undefined}
            />
            <p className="campo-erro" id={`${ids}-url-erro`} hidden={!erroDoCampo}>
              {erroDoCampo}
            </p>
          </div>
          <div className="pq-o-que">
            <b>O que o Liame faz</b>
            <ul>
              <li>Lê a página uma vez, na fila, e respeita o robots.txt do site.</li>
              <li>Tira dela só produtos e preços, ofertas e diferenciais, e confere cada item contra o texto da página.</li>
              <li>O que servir vira sugestão em Minha marca. Nada muda antes de você conferir.</li>
              <li>A página não fica guardada: ficam só o pedido (quem pediu e o endereço) e o que passou na conferência.</li>
            </ul>
          </div>
          {!noLimite && <p className="pq-conta">{linhaDoLimite(daily, agora)}</p>}
        </div>
        <div className="dialogo-acoes">
          {noLimite ? (
            <button ref={fecharBt} className="btn btn--primary" type="button" onClick={fechar}>
              Fechar
            </button>
          ) : (
            <>
              <button className="btn" type="button" onClick={fechar} disabled={enviando}>
                Cancelar
              </button>
              <button ref={pedirBt} className="btn btn--primary" type="submit" disabled={enviando} aria-busy={enviando}>
                <Icone nome="search" pequeno />
                {enviando ? 'Pedindo…' : 'Pedir a leitura'}
              </button>
            </>
          )}
        </div>
      </form>
    </dialog>
  );
}
