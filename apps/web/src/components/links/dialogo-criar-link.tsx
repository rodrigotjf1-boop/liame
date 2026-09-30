'use client';

import type { CreatedTrackingLinkResponse, LinkOptionsResponse } from '@liame/contracts';
import Link from 'next/link';
import { type FormEvent, type RefObject, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Icone } from '@/components/ui/icone';
import { useDialogo } from '@/components/ui/use-dialogo';
import { api, chamar, mensagemDe, type Problema } from '@/lib/api';
import { disparar } from '@/lib/disparar';
import { campanhaAceitaLink, conferidoEm, type ErrosDoLink, errosDoLink, gruposDeCampanhas, motivoCampanhaSemLink, motivoDestino, rotuloDestino } from './textos';

// "Criar link de campanha" (protótipo P3): nome, campanha (Meta ou Google Ads), anúncio opcional e o
// cardápio da loja como destino. O servidor monta o link, os parâmetros e o código; criar o mesmo link de
// novo devolve o que já existe.

type Carga = { tipo: 'carregando' } | { tipo: 'ok'; opcoes: LinkOptionsResponse } | { tipo: 'erro'; problema: Problema };

type Props = {
  marca: string;
  /** Campanha e anúncio já escolhidos (quando vem de um anúncio sem rastreio). */
  inicial?: { campanha: string; anuncio?: string };
  podeVerContas: boolean;
  reserva: RefObject<HTMLElement | null>;
  aoCriado: (link: CreatedTrackingLinkResponse) => void;
  aoFechar: () => void;
};

export function DialogoCriarLink({ marca, inicial, podeVerContas, reserva, aoCriado, aoFechar }: Props) {
  const campoNome = useRef<HTMLInputElement>(null);
  const campoCampanha = useRef<HTMLSelectElement>(null);
  const campoDestino = useRef<HTMLSelectElement>(null);
  const { ref, fechar, devolverFoco } = useDialogo({ focoInicial: campoNome, reserva });
  const ids = useId();
  const [carga, setCarga] = useState<Carga>({ tipo: 'carregando' });
  const [tentativa, setTentativa] = useState(0);
  const [nome, setNome] = useState('');
  const [campanha, setCampanha] = useState(inicial?.campanha ?? '');
  const [anuncio, setAnuncio] = useState(inicial?.anuncio ?? '');
  const [destino, setDestino] = useState('');
  const [erros, setErros] = useState<ErrosDoLink>({});
  const [erro, setErro] = useState('');
  const [enviando, setEnviando] = useState(false);

  useEffect(() => {
    let vivo = true;
    setCarga({ tipo: 'carregando' });
    disparar(
      chamar(() => api.GET('/v1/links/options', { params: { query: { brand_id: marca } } })).then((r) => {
        if (!vivo) return;
        if (!r.ok) return setCarga({ tipo: 'erro', problema: r.problema });
        setCarga({ tipo: 'ok', opcoes: r.data });
        // Um cardápio só (o caso comum): já vem escolhido.
        const usaveis = r.data.destinations.filter((d) => d.usable && d.unit);
        if (usaveis.length === 1) setDestino((d) => d || usaveis[0]!.unit!.id);
      }),
    );
    return () => {
      vivo = false;
    };
  }, [marca, tentativa]);

  const opcoes = carga.tipo === 'ok' ? carga.opcoes : null;
  const grupos = useMemo(() => (opcoes ? gruposDeCampanhas(opcoes.campaigns) : []), [opcoes]);
  const escolhida = opcoes?.campaigns.find((c) => c.id === campanha) ?? null;
  const lidas = opcoes ? conferidoEm(opcoes.sources, new Date()) : null;
  const semCampanha = !!opcoes && !opcoes.campaigns.some(campanhaAceitaLink);
  const semDestino = !!opcoes && !opcoes.destinations.some((d) => d.usable && d.unit);

  async function criar(e: FormEvent) {
    e.preventDefault();
    setErro('');
    const achados = errosDoLink({ nome, campanha, destino });
    setErros(achados);
    if (achados.nome) return campoNome.current?.focus();
    if (achados.campanha) return campoCampanha.current?.focus();
    if (achados.destino) return campoDestino.current?.focus();
    setEnviando(true);
    const r = await chamar(() =>
      api.POST('/v1/links', {
        body: { unit_id: destino, campaign_id: campanha, ...(anuncio ? { ad_id: anuncio } : {}), name: nome.trim() },
      }),
    );
    setEnviando(false);
    if (!r.ok) return setErro(mensagemDe(r.problema));
    aoCriado(r.data);
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
      <form className="dialogo-form" onSubmit={(e) => disparar(criar(e))} noValidate>
        <div className="dialogo-cab">
          <h2 id={`${ids}-t`}>Criar link de campanha</h2>
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
          {carga.tipo === 'erro' && (
            <p className="dialogo-erro" role="alert">
              <Icone nome="alert" pequeno />
              <span>
                Não deu para carregar as campanhas: {mensagemDe(carga.problema)}{' '}
                <button className="btn btn--sm" type="button" onClick={() => setTentativa((t) => t + 1)}>
                  Tentar de novo
                </button>
              </span>
            </p>
          )}

          <div className="campo">
            <label htmlFor={`${ids}-nome`}>Nome do link</label>
            <input
              ref={campoNome}
              className="input"
              id={`${ids}-nome`}
              autoComplete="off"
              maxLength={60}
              placeholder="Ex.: Combo sexta · stories"
              value={nome}
              onChange={(e) => setNome(e.target.value)}
              aria-invalid={!!erros.nome}
              aria-describedby={erros.nome ? `${ids}-nome-erro` : undefined}
            />
            {erros.nome && (
              <p className="campo-erro" id={`${ids}-nome-erro`}>
                {erros.nome}
              </p>
            )}
          </div>

          <div className="campo">
            <label htmlFor={`${ids}-camp`}>Campanha</label>
            <select
              ref={campoCampanha}
              className="input"
              id={`${ids}-camp`}
              value={campanha}
              disabled={!opcoes || semCampanha}
              onChange={(e) => {
                setCampanha(e.target.value);
                setAnuncio('');
              }}
              aria-invalid={!!erros.campanha}
              aria-describedby={`${ids}-camp-dica${erros.campanha ? ` ${ids}-camp-erro` : ''}`}
            >
              <option value="">{opcoes ? 'Escolha a campanha' : 'Carregando as campanhas…'}</option>
              {grupos.map((g) => (
                <optgroup key={g.provider} label={g.titulo}>
                  {g.campanhas.map((c) => {
                    const motivo = motivoCampanhaSemLink(c);
                    return (
                      <option key={c.id} value={c.id} disabled={!!motivo}>
                        {c.name}
                        {c.status === 'pausada' ? ' · pausada' : ''}
                        {motivo ? ` (${motivo})` : ''}
                      </option>
                    );
                  })}
                </optgroup>
              ))}
            </select>
            <p className="campo-dica" id={`${ids}-camp-dica`}>
              {semCampanha
                ? 'Nenhuma campanha ativa ou pausada da Meta ou do Google Ads leva a um site. Os links servem para anúncios que levam ao cardápio.'
                : lidas
                  ? `Campanhas ativas e pausadas, lidas ${lidas}.`
                  : 'Campanhas ativas e pausadas da Meta e do Google Ads.'}
            </p>
            {erros.campanha && (
              <p className="campo-erro" id={`${ids}-camp-erro`}>
                {erros.campanha}
              </p>
            )}
          </div>

          <div className="campo">
            <label htmlFor={`${ids}-anuncio`}>
              Anúncio <span className="campo-dica">(opcional)</span>
            </label>
            <select className="input" id={`${ids}-anuncio`} value={anuncio} disabled={!escolhida} onChange={(e) => setAnuncio(e.target.value)}>
              <option value="">Todos os anúncios da campanha</option>
              {escolhida?.ads.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                  {a.status === 'pausada' ? ' · pausado' : ''}
                </option>
              ))}
            </select>
          </div>

          <div className="campo">
            <label htmlFor={`${ids}-destino`}>Destino</label>
            <select
              ref={campoDestino}
              className="input"
              id={`${ids}-destino`}
              value={destino}
              disabled={!opcoes || semDestino}
              onChange={(e) => setDestino(e.target.value)}
              aria-invalid={!!erros.destino}
              aria-describedby={`${ids}-destino-dica${erros.destino ? ` ${ids}-destino-erro` : ''}`}
            >
              <option value="">{opcoes ? 'Escolha o cardápio' : 'Carregando os cardápios…'}</option>
              {opcoes?.destinations.map((d) => {
                const motivo = motivoDestino(d);
                return (
                  <option key={d.connected_account_id} value={d.unit?.id ?? ''} disabled={!!motivo || !d.unit}>
                    {rotuloDestino(d)}
                    {motivo ? ` (${motivo})` : ''}
                  </option>
                );
              })}
            </select>
            <p className="campo-dica" id={`${ids}-destino-dica`}>
              {semDestino ? (
                <>
                  Nenhum cardápio da loja pode ser destino agora: o Regem precisa estar conectado e a loja dele ligada a uma loja do Liame.{' '}
                  {podeVerContas && <Link href="/contas">Abrir Contas conectadas</Link>}
                </>
              ) : (
                'Só o cardápio da loja é aceito como destino.'
              )}
            </p>
            {erros.destino && (
              <p className="campo-erro" id={`${ids}-destino-erro`}>
                {erros.destino}
              </p>
            )}
          </div>
        </div>
        <div className="dialogo-acoes">
          <button className="btn" type="button" onClick={fechar} disabled={enviando}>
            Cancelar
          </button>
          <button className="btn btn--primary" type="submit" disabled={enviando || !opcoes || semCampanha || semDestino} aria-busy={enviando}>
            {enviando ? 'Criando…' : 'Criar link'}
          </button>
        </div>
      </form>
    </dialog>
  );
}
