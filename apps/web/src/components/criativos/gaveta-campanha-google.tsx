'use client';

import type { AdPieceResponse, BrandPhoto, GoogleCampaignOptionsResponse, GoogleCampaignResponse, GoogleCampaignTextsResponse } from '@liame/contracts';
import Link from 'next/link';
import { type FormEvent, type RefObject, useEffect, useId, useRef, useState } from 'react';
import { Icone } from '@/components/ui/icone';
import { useDialogo } from '@/components/ui/use-dialogo';
import { microsDeReais } from '@/components/links/cupons-textos';
import { api, chamar } from '@/lib/api';
import { disparar } from '@/lib/disparar';
import { reaisDeMicros } from '@/lib/formato';
import {
  type CampoDoGoogle,
  type CamposDoGoogle,
  conferirCampanhaGoogle,
  erroDoPedidoGoogle,
  type ErrosDoGoogle,
  LIMITES_DO_GOOGLE,
  recortesDaFoto,
  textosDaPeca,
} from './campanha-google-textos';
import { dicaDoRaio, efeitoDaCampanha, raiosDaLoja } from './campanha-nova-textos';

// A gaveta "Campanha nova no Google, pausada" (A5, Y9, parte 5b; protótipo P45 pré-aprovado em 12/11/2026, D-A5-21 a
// D-A5-32): a peça aprovada em Criativos vira uma Performance Max, com os textos nos tamanhos do Google (os da peça, que a
// pessoa ajusta, ou a proposta do Criativo), uma foto de Fotos com os recortes que o Liame faz, o nome e a logo de Minha
// marca, a loja e o raio, a verba e o fim, e a prévia ao lado. "Pedir a criação" grava o pedido, que espera o código do
// app em Aprovações.

interface Props {
  brandId: string;
  peca: AdPieceResponse;
  /** As fotos e os vídeos de Fotos (nulo quando Fotos não abriu); só as fotos servem no Google. */
  midias: BrandPhoto[] | null;
  opcoes: GoogleCampaignOptionsResponse;
  /** Hoje no fuso da empresa (`AAAA-MM-DD`): o fim precisa ser depois. */
  hoje: string;
  reserva?: RefObject<HTMLElement | null>;
  aoFechar: () => void;
  aoCriado: (c: GoogleCampaignResponse) => void;
}

type Proposta = NonNullable<GoogleCampaignTextsResponse['texts']> & { dropped: number };

/** Por que o Criativo não propôs, em palavras para a pessoa. */
function semProposta(r: GoogleCampaignTextsResponse): string {
  switch (r.reason) {
    case 'sem-rota':
      return 'O Criativo ainda não escreve os textos do Google: escreva os seus a partir da peça.';
    case 'ia_desligada':
      return 'A IA está desligada para esta empresa: escreva os textos.';
    case 'funcionario_desligado':
      return 'O Criativo está desligado em Sua equipe: escreva os textos, ou ligue o Criativo lá.';
    case 'teto':
      return `A IA chegou ao teto de custo do mês${r.retry_at ? ` e volta em ${new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', timeZone: 'America/Sao_Paulo' }).format(new Date(r.retry_at))}` : ''}: escreva os textos.`;
    case 'limite-usuario':
      return 'Você pediu muitas vezes seguidas: espere um pouco e peça de novo.';
    case 'barrado':
    case 'formato':
      return 'O que o Criativo escreveu não passou na conferência: escreva os textos ou peça de novo.';
    case 'recusa':
      return 'O Criativo não escreve sobre o assunto desta peça (bebida alcoólica, política ou produto proibido).';
    default:
      return 'O Criativo não respondeu agora: tente de novo em instantes, ou escreva os textos.';
  }
}

/** A contagem de caracteres de um texto, em vermelho quando passa do limite do Google. */
function Conta({ texto, max, id }: { texto: string; max: number; id: string }) {
  const n = [...texto].length;
  return (
    <span className="cg-conta" id={id} data-passou={n > max ? '' : undefined}>
      {n}/{max}
    </span>
  );
}

export function GavetaCampanhaGoogle({ brandId, peca, midias, opcoes, hoje, reserva, aoFechar, aoCriado }: Props) {
  const ids = useId();
  const titulo = useRef<HTMLHeadingElement>(null);
  const aviso = useRef<HTMLDivElement>(null);
  const tituloDaProposta = useRef<HTMLHeadingElement>(null);
  const { ref, fechar, devolverFoco } = useDialogo({ focoInicial: titulo, reserva });
  const fotos = (midias ?? []).filter((m) => m.kind !== 'video');
  const lojas = opcoes.units;
  const lojaInicial = lojas.find((u) => u.has_address && u.menu_available) ?? lojas.find((u) => u.has_address) ?? lojas[0] ?? null;
  const [campos, setCampos] = useState<CamposDoGoogle>(() => ({
    ...textosDaPeca(peca.current),
    foto: null,
    loja: lojaInicial?.id ?? null,
    nome: `${peca.current.title} · Google · ${new Intl.DateTimeFormat('pt-BR', { month: 'long', timeZone: 'UTC' }).format(new Date(`${hoje}T12:00:00Z`))}`.slice(0, 80),
    raio: 5,
    verba: '30,00',
    fim: '',
  }));
  const [aba, setAba] = useState<'busca' | 'display'>('busca');
  const [erros, setErros] = useState<ErrosDoGoogle>({});
  const [erroGeral, setErroGeral] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);
  const [criado, setCriado] = useState<GoogleCampaignResponse | null>(null);
  const [proposta, setProposta] = useState<Proposta | null>(null);
  const [pedindo, setPedindo] = useState(false);
  const [semIa, setSemIa] = useState<string | null>(null);
  const [logo, setLogo] = useState<string | null>(null);
  const [focoEm, setFocoEm] = useState<CampoDoGoogle | 'mais-titulos' | 'mais-descricoes' | 'criativo' | null>(null);

  // A logo de Minha marca, para a prévia (sem ela, a prévia mostra o lugar vazio).
  useEffect(() => {
    if (!opcoes.logo) return;
    let vivo = true;
    disparar(
      (async () => {
        const r = await chamar(() => api.GET('/v1/brands/{id}/logo', { params: { path: { id: brandId } } }));
        if (vivo && r.ok) setLogo(r.data.logo?.url ?? null);
      })(),
    );
    return () => {
      vivo = false;
    };
  }, [brandId, opcoes.logo]);
  useEffect(() => {
    if (!focoEm || enviando) return;
    ref.current?.querySelector<HTMLElement>(`[data-campo="${focoEm}"]`)?.focus();
    setFocoEm(null);
  }, [focoEm, enviando, ref]);
  useEffect(() => {
    if (criado) titulo.current?.focus();
  }, [criado]);
  useEffect(() => {
    if (proposta) tituloDaProposta.current?.focus({ preventScroll: true });
  }, [proposta]);

  const loja = lojas.find((u) => u.id === campos.loja) ?? null;
  const foto = fotos.find((m) => m.id === campos.foto) ?? null;
  const recortes = foto ? recortesDaFoto(foto.width, foto.height) : [];
  const bloqueio = opcoes.blocks[0] ?? null;
  const semEndereco = loja !== null && !loja.has_address;
  const raios = raiosDaLoja(loja);
  const L = LIMITES_DO_GOOGLE;

  function mudar(p: Partial<CamposDoGoogle>, campo?: CampoDoGoogle) {
    setCampos((c) => ({ ...c, ...p }));
    if (campo) setErros((e) => ({ ...e, [campo]: undefined }));
    setErroGeral(null);
  }
  function mudarItem(lista: 'titulos' | 'descricoes', i: number, texto: string) {
    setCampos((c) => ({ ...c, [lista]: c[lista].map((t, j) => (j === i ? texto : t)) }));
    setErros((e) => ({ ...e, [lista]: undefined }));
    setErroGeral(null);
  }

  async function pedirAoCriativo() {
    if (pedindo) return;
    setPedindo(true);
    setSemIa(null);
    const r = await chamar(() => api.POST('/v1/google-campaigns/texts', { body: { brand_id: brandId, piece_id: peca.id } }));
    setPedindo(false);
    if (!r.ok) return setSemIa(r.problema.detail ?? r.problema.title ?? 'O Criativo não respondeu agora.');
    if (r.data.origin === 'ia' && r.data.texts) return setProposta({ ...r.data.texts, dropped: r.data.dropped });
    setSemIa(semProposta(r.data));
  }

  function usarProposta() {
    if (!proposta) return;
    mudar({ titulos: [...proposta.headlines], longo: proposta.long_headlines[0] ?? campos.longo, descricoes: [...proposta.descriptions] });
    setErros((e) => ({ ...e, titulos: undefined, longo: undefined, descricoes: undefined }));
    setProposta(null);
    setFocoEm('titulos');
  }

  function focar(e: ErrosDoGoogle) {
    const ordem: CampoDoGoogle[] = ['titulos', 'longo', 'descricoes', 'foto', 'loja', 'nome', 'verba', 'fim'];
    const primeiro = ordem.find((c) => e[c]);
    if (primeiro) setFocoEm(primeiro);
  }

  async function mandar(ev: FormEvent) {
    ev.preventDefault();
    if (enviando) return;
    if (bloqueio || semEndereco) return aviso.current?.focus();
    const e = conferirCampanhaGoogle(campos, opcoes, fotos, hoje);
    setErros(e);
    if (Object.values(e).some(Boolean)) return focar(e);
    setEnviando(true);
    const r = await chamar(() =>
      api.POST('/v1/google-campaigns', {
        body: {
          brand_id: brandId,
          piece_id: peca.id,
          media_id: campos.foto!,
          unit_id: campos.loja!,
          name: campos.nome.trim(),
          headlines: campos.titulos.map((t) => t.trim()),
          long_headlines: [campos.longo.trim()],
          descriptions: campos.descricoes.map((t) => t.trim()),
          business_name: opcoes.business_name,
          radius_km: campos.raio,
          daily_budget_micros: Number(microsDeReais(campos.verba)),
          ...(campos.fim ? { end_date: campos.fim } : {}),
        },
      }),
    );
    setEnviando(false);
    if (!r.ok) {
      const { campo, texto } = erroDoPedidoGoogle(r.problema);
      if (campo) {
        setErros({ [campo]: texto });
        return focar({ [campo]: texto });
      }
      return setErroGeral(texto);
    }
    setCriado(r.data);
    aoCriado(r.data);
  }

  const erroDe = (c: CampoDoGoogle) =>
    erros[c] ? (
      <span className="campo-erro" id={`${ids}-${c}-erro`} role="alert">
        {erros[c]}
      </span>
    ) : null;
  const descrito = (c: CampoDoGoogle, dica?: string) => [dica, erros[c] ? `${ids}-${c}-erro` : null].filter(Boolean).join(' ') || undefined;

  /** Uma lista de textos (os títulos ou as descrições): cada um com a contagem, o "tirar" acima do mínimo e o "mais" até o máximo. */
  const lista = (nome: 'titulos' | 'descricoes', rotulo: string, max: number, faixa: readonly [number, number]) => {
    const itens = campos[nome];
    return (
      <>
        <ol className="cg-lista">
          {itens.map((t, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: os textos não têm id; a posição é a identidade na lista
            <li key={i}>
              <label className="sr-only" htmlFor={`${ids}-${nome}-${i}`}>
                {rotulo} {i + 1}
              </label>
              <input
                className="input"
                id={`${ids}-${nome}-${i}`}
                data-campo={i === 0 ? nome : undefined}
                autoComplete="off"
                maxLength={max * 2}
                value={t}
                aria-describedby={[`${ids}-${nome}-${i}-n`, erros[nome] ? `${ids}-${nome}-erro` : null].filter(Boolean).join(' ')}
                aria-invalid={erros[nome] && [...t].length > max ? true : undefined}
                onChange={(e) => mudarItem(nome, i, e.target.value)}
                disabled={enviando}
              />
              <Conta texto={t} max={max} id={`${ids}-${nome}-${i}-n`} />
              {i >= faixa[0] ? (
                <button
                  className="btn btn--icon btn--ghost btn--sm"
                  type="button"
                  aria-label={`Tirar ${rotulo.toLowerCase()} ${i + 1}`}
                  onClick={() => {
                    setCampos((c) => ({ ...c, [nome]: c[nome].filter((_, j) => j !== i) }));
                    setFocoEm(nome === 'titulos' ? 'mais-titulos' : 'mais-descricoes');
                  }}
                  disabled={enviando}
                >
                  <Icone nome="x" pequeno />
                </button>
              ) : (
                <span aria-hidden="true" />
              )}
            </li>
          ))}
        </ol>
        {itens.length < faixa[1] && (
          <button
            className="btn btn--sm cg-mais"
            type="button"
            data-campo={nome === 'titulos' ? 'mais-titulos' : 'mais-descricoes'}
            onClick={() => {
              setCampos((c) => ({ ...c, [nome]: [...c[nome], ''] }));
              setTimeout(() => document.getElementById(`${ids}-${nome}-${itens.length}`)?.focus(), 0);
            }}
            disabled={enviando}
          >
            <Icone nome="plus" pequeno />
            Mais {nome === 'titulos' ? 'títulos' : 'descrições'}
          </button>
        )}
        {erroDe(nome)}
      </>
    );
  };

  const cab = (
    <div className="dialogo-cab">
      <div className="dlg-titulo">
        <p className="rotulo-marca">Campanha nova no Google, pausada</p>
        <h2 id={`${ids}-t`} ref={titulo} tabIndex={-1}>
          {criado ? 'Pedido criado' : peca.current.title}
        </h2>
      </div>
      <button className="btn btn--icon btn--ghost" type="button" onClick={fechar} aria-label="Fechar" disabled={enviando}>
        <Icone nome="x" />
      </button>
    </div>
  );
  const deitada = recortes.find((r) => r.id === 'deitada');

  return (
    <dialog
      ref={ref}
      className="dialogo dialogo--lado cn-gaveta"
      aria-labelledby={`${ids}-t`}
      onClose={() => {
        aoFechar();
        devolverFoco();
      }}
      onClick={(e) => {
        if (e.target === ref.current && !enviando) fechar();
      }}
    >
      {criado ? (
        <div className="dialogo-form">
          {cab}
          <div className="dialogo-corpo">
            <div className="pd-feito">
              <span className="vazio-ic vazio-ic--ok" aria-hidden="true">
                <Icone nome="check" />
              </span>
              <p>
                <b>Criar a campanha “{criado.name}” no Google, pausada.</b> Ele espera a aprovação com o código do app. Nada é criado no Google antes disso.
              </p>
            </div>
          </div>
          <div className="dialogo-acoes">
            <button className="btn" type="button" onClick={fechar}>
              Fechar
            </button>
            {criado.action_id && (
              <Link className="btn btn--primary" href={`/aprovacoes?pedido=${criado.action_id}`}>
                Ver em Aprovações
              </Link>
            )}
          </div>
        </div>
      ) : (
        <form className="dialogo-form" onSubmit={(e) => disparar(mandar(e))} noValidate>
          {cab}
          <div className="dialogo-corpo">
            {bloqueio && (
              <div className="pd-aviso pd-aviso--perigo cn-bloqueio" role="alert" ref={aviso} tabIndex={-1}>
                <Icone nome="alert-circle" />
                <div>
                  <b>{bloqueio.title}</b>
                  <span id={`${ids}-bloqueio`}>{bloqueio.detail}</span>
                  {bloqueio.code === 'sem-logo' ? (
                    <Link className="btn btn--primary btn--sm" href="/marca">
                      Enviar a logo em Minha marca
                    </Link>
                  ) : (
                    bloqueio.code !== 'funcao-desligada' && (
                      <Link className="btn btn--sm" href="/contas">
                        Abrir Contas conectadas
                      </Link>
                    )
                  )}
                </div>
              </div>
            )}
            {!bloqueio && semEndereco && (
              <div className="pd-aviso pd-aviso--perigo cn-bloqueio" role="alert" ref={aviso} tabIndex={-1}>
                <Icone nome="alert-circle" />
                <div>
                  <b>Falta o endereço da loja</b>
                  <span id={`${ids}-bloqueio`}>A campanha mostra o anúncio em volta da loja, e o ponto dela ainda não está no endereço. Ajuste o endereço da loja em Minha marca antes.</span>
                  <Link className="btn btn--primary btn--sm" href="/marca">
                    Ajustar o endereço em Minha marca
                  </Link>
                </div>
              </div>
            )}
            {erroGeral && (
              <p className="dialogo-erro" role="alert">
                <Icone nome="alert" pequeno />
                <span>{erroGeral}</span>
              </p>
            )}
            <p className="cn-origem">
              <Icone nome="megaphone" pequeno />
              <span>
                A mesma peça aprovada em Criativos, nos tamanhos do Google: <b>Performance Max</b> mostra o anúncio na Pesquisa, no YouTube, no Display, no Gmail, no Maps e no Discover, combinando os textos e as imagens.
              </span>
            </p>
            <div className="cn-grade">
              <div className="cn-f1">
                <div className="pd-bloco">
                  <p className="rotulo-marca">Os textos do Google</p>
                  <div className="cg-acoes">
                    <button className="btn btn--sm" type="button" data-campo="criativo" aria-busy={pedindo || undefined} onClick={() => disparar(pedirAoCriativo())} disabled={enviando || pedindo}>
                      <Icone nome="sparkles" pequeno />
                      {pedindo ? 'Pedindo ao Criativo…' : 'Pedir ao Criativo'}
                    </button>
                  </div>
                  {semIa && (
                    <p className="pd-nota" role="status">
                      <Icone nome="info" pequeno />
                      <span>{semIa}</span>
                    </p>
                  )}
                  {proposta && (
                    <div className="cg-proposta" aria-labelledby={`${ids}-proposta-t`}>
                      <h3 id={`${ids}-proposta-t`} ref={tituloDaProposta} tabIndex={-1}>
                        O que o Criativo propõe
                      </h3>
                      <p className="campo-dica">
                        Escrito a partir da peça aprovada, nos tamanhos do Google, e conferido pelo Compliance antes de chegar aqui.
                        {proposta.dropped > 0 ? ` ${proposta.dropped === 1 ? 'Um texto ficou' : `${proposta.dropped} textos ficaram`} de fora na conferência.` : ''}
                      </p>
                      <p className="rotulo">Títulos</p>
                      <ol>
                        {proposta.headlines.map((t) => (
                          <li key={t}>{t}</li>
                        ))}
                      </ol>
                      <p className="rotulo">Título longo</p>
                      <ul>
                        <li>{proposta.long_headlines[0]}</li>
                      </ul>
                      <p className="rotulo">Descrições</p>
                      <ol>
                        {proposta.descriptions.map((t) => (
                          <li key={t}>{t}</li>
                        ))}
                      </ol>
                      <div className="cg-acoes">
                        <button className="btn btn--primary btn--sm" type="button" onClick={usarProposta}>
                          Usar estes
                        </button>
                        <button
                          className="btn btn--sm"
                          type="button"
                          onClick={() => {
                            setProposta(null);
                            setFocoEm('criativo');
                          }}
                        >
                          Deixar como está
                        </button>
                      </div>
                    </div>
                  )}
                  <fieldset className="campo">
                    <legend>
                      Títulos{' '}
                      <span className="campo-dica">
                        de {L.titulos[0]} a {L.titulos[1]}, até {L.titulo} caracteres cada
                      </span>
                    </legend>
                    {lista('titulos', 'Título', L.titulo, L.titulos)}
                  </fieldset>
                  <div className="campo">
                    <label htmlFor={`${ids}-longo`}>
                      Título longo <span className="campo-dica">até {L.tituloLongo} caracteres</span>
                    </label>
                    <div className="cg-linha">
                      <input
                        className="input"
                        id={`${ids}-longo`}
                        data-campo="longo"
                        autoComplete="off"
                        maxLength={L.tituloLongo * 2}
                        value={campos.longo}
                        aria-describedby={descrito('longo', `${ids}-longo-n`)}
                        aria-invalid={erros.longo ? true : undefined}
                        onChange={(e) => mudar({ longo: e.target.value }, 'longo')}
                        disabled={enviando}
                      />
                      <Conta texto={campos.longo} max={L.tituloLongo} id={`${ids}-longo-n`} />
                    </div>
                    {erroDe('longo')}
                  </div>
                  <fieldset className="campo">
                    <legend>
                      Descrições{' '}
                      <span className="campo-dica">
                        de {L.descricoes[0]} a {L.descricoes[1]}, até {L.descricao} caracteres cada
                      </span>
                    </legend>
                    {lista('descricoes', 'Descrição', L.descricao, L.descricoes)}
                  </fieldset>
                </div>

                <div className="campo" role="group" aria-labelledby={`${ids}-foto-t`} aria-describedby={descrito('foto', `${ids}-foto-d`)}>
                  <span className="rotulo" id={`${ids}-foto-t`}>
                    A foto e os recortes
                  </span>
                  <span className="campo-dica" id={`${ids}-foto-d`}>
                    As fotos de verdade de Fotos. O Liame recorta pelo centro nas proporções que o Google pede; ele combina os recortes nos anúncios.
                  </span>
                  {fotos.length ? (
                    <ul className="po-fotos" aria-label="Fotos da marca">
                      {fotos.map((m, i) => (
                        <li key={m.id}>
                          <button
                            className="po-foto-op"
                            type="button"
                            data-campo={i === 0 ? 'foto' : undefined}
                            aria-pressed={campos.foto === m.id}
                            aria-label={`${m.product ?? 'Sem produto'}${m.description ? `: ${m.description}` : ''}, ${m.width} × ${m.height}`}
                            onClick={() => mudar({ foto: m.id }, 'foto')}
                            disabled={enviando}
                          >
                            <img src={m.thumbnail_url} alt="" referrerPolicy="no-referrer" />
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="pd-nota">
                      <Icone nome="camera" pequeno />
                      <span>
                        {midias === null
                          ? 'As Fotos não abriram agora, ou não estão ligadas para esta empresa: a campanha precisa de uma foto de lá.'
                          : 'Nenhuma foto pronta em Fotos desta marca. Envie em Fotos.'}
                      </span>
                    </p>
                  )}
                  {foto && (
                    <ul className="cg-recortes" aria-label="Os recortes da foto">
                      {recortes.map((r) => (
                        <li key={r.id}>
                          <figure>
                            <div className={`cg-quadro cg-quadro--${r.id}${r.ok ? '' : ' cg-quadro--ruim'}`}>
                              <img src={foto.thumbnail_url} alt="" referrerPolicy="no-referrer" />
                            </div>
                            <figcaption>
                              <b>{r.rotulo}</b>
                              {r.ok ? `${r.largura} × ${r.altura}` : <span className="cg-ruim">{r.obrigatorio ? `pequena: o Google pede ${r.minLargura} × ${r.minAltura}` : 'fica de fora: pequena'}</span>}
                              {r.obrigatorio ? '' : ' · opcional'}
                            </figcaption>
                          </figure>
                        </li>
                      ))}
                    </ul>
                  )}
                  {erroDe('foto')}
                </div>

                <div className="pd-bloco">
                  <p className="rotulo-marca">O nome e a logo da loja</p>
                  <div className="cg-logo">
                    <span className="cg-logo-img">{logo ? <img src={logo} alt={`A logo de ${opcoes.business_name}`} referrerPolicy="no-referrer" /> : <Icone nome="image" pequeno />}</span>
                    <span>
                      <b>{opcoes.business_name}</b>
                      <small className="campo-dica">
                        {opcoes.logo ? 'De Minha marca: o nome (até 25 caracteres) e a logo, que vai inteira num quadrado. O Google mostra os dois no anúncio.' : 'Sem a logo em Minha marca.'}
                      </small>
                    </span>
                  </div>
                </div>
              </div>

              <section className="cn-lado" aria-labelledby={`${ids}-previa-t`}>
                <h3 className="rotulo-marca" id={`${ids}-previa-t`}>
                  Como o anúncio pode aparecer
                </h3>
                <div className="seg" role="group" aria-label="Ver a prévia na">
                  {(['busca', 'display'] as const).map((a) => (
                    <button key={a} type="button" aria-pressed={aba === a} onClick={() => setAba(a)}>
                      {a === 'busca' ? 'Pesquisa' : 'Display'}
                    </button>
                  ))}
                </div>
                {aba === 'busca' ? (
                  <div className="cg-previa cg-busca">
                    <div className="cg-url">
                      <b>Patrocinado</b>
                      <span>{opcoes.business_name} · cardápio online</span>
                    </div>
                    <span className="cg-tit">
                      {campos.titulos
                        .filter((t) => t.trim())
                        .slice(0, 3)
                        .join(' | ')}
                    </span>
                    <p>{campos.descricoes.find((t) => t.trim()) ?? ''}</p>
                  </div>
                ) : (
                  <div className="cg-previa cg-display">
                    <div className={`cg-quadro cg-quadro--deitada${deitada && !deitada.ok ? ' cg-quadro--ruim' : ''}`}>{foto && <img src={foto.thumbnail_url} alt="" referrerPolicy="no-referrer" />}</div>
                    <div className="cg-display-txt">
                      <span className="cg-logo-img">{logo ? <img src={logo} alt="" referrerPolicy="no-referrer" /> : <Icone nome="image" pequeno />}</span>
                      <span>
                        <b>{campos.longo}</b>
                        <p>{campos.descricoes.find((t) => t.trim()) ?? ''}</p>
                      </span>
                    </div>
                  </div>
                )}
                <p className="pd-nota">
                  <Icone nome="info" pequeno />
                  <span>
                    É um desenho. Na Performance Max, o Google escolhe a combinação dos títulos, das descrições e dos recortes em cada lugar onde mostra o anúncio. Com a campanha criada, pausada, dá para ver as combinações no Google Ads antes de ativar.
                  </span>
                </p>
                <p className="pd-nota">
                  <Icone nome="sparkles" pequeno />
                  <span>O Liame desliga na criação os textos e as imagens que o Google faria sozinho: vai ao ar o que você aprovar.</span>
                </p>
              </section>

              <div className="cn-f2">
                {lojas.length > 1 && (
                  <div className="campo">
                    <label htmlFor={`${ids}-loja`}>A loja</label>
                    <select
                      className="input"
                      id={`${ids}-loja`}
                      data-campo="loja"
                      value={campos.loja ?? ''}
                      aria-describedby={descrito('loja')}
                      aria-invalid={erros.loja ? true : undefined}
                      onChange={(e) => mudar({ loja: e.target.value }, 'loja')}
                      disabled={enviando}
                    >
                      {lojas.map((u) => (
                        <option key={u.id} value={u.id}>
                          {u.name}
                          {u.has_address ? '' : ' (sem o endereço)'}
                          {u.has_address && !u.menu_available ? ' (sem o cardápio)' : ''}
                        </option>
                      ))}
                    </select>
                    {erroDe('loja')}
                  </div>
                )}
                {lojas.length <= 1 && erroDe('loja')}
                <div className="campo">
                  <label htmlFor={`${ids}-nome`}>Nome da campanha</label>
                  <input
                    className="input"
                    id={`${ids}-nome`}
                    data-campo="nome"
                    autoComplete="off"
                    maxLength={80}
                    value={campos.nome}
                    aria-describedby={descrito('nome', `${ids}-nome-d`)}
                    aria-invalid={erros.nome ? true : undefined}
                    onChange={(e) => mudar({ nome: e.target.value }, 'nome')}
                    disabled={enviando}
                  />
                  <span className="campo-dica" id={`${ids}-nome-d`}>
                    É o nome que aparece no Google Ads e em Resultados.
                  </span>
                  {erroDe('nome')}
                </div>
                <fieldset className="campo">
                  <legend>Quem vê</legend>
                  <div className="pd-escolha">
                    {raios.map((r) => (
                      <label key={r.rotulo} className="pd-opcao">
                        <input type="radio" name={`${ids}-raio`} value={r.km} checked={campos.raio === r.km} disabled={enviando || semEndereco} aria-describedby={`${ids}-raio-d`} onChange={() => mudar({ raio: r.km })} />
                        {r.rotulo}
                      </label>
                    ))}
                  </div>
                  {loja && (
                    <span className="campo-dica" id={`${ids}-raio-d`}>
                      {dicaDoRaio(campos.raio, loja)} No Google, o raio vale para quem está ou costuma estar ali.
                    </span>
                  )}
                </fieldset>
                <div className="campo">
                  <label htmlFor={`${ids}-verba`}>Verba diária</label>
                  <div className="pd-valor">
                    <span aria-hidden="true">R$</span>
                    <input
                      id={`${ids}-verba`}
                      data-campo="verba"
                      inputMode="decimal"
                      autoComplete="off"
                      maxLength={10}
                      value={campos.verba}
                      aria-describedby={descrito('verba', `${ids}-verba-d`)}
                      aria-invalid={erros.verba ? true : undefined}
                      onChange={(e) => mudar({ verba: e.target.value }, 'verba')}
                      disabled={enviando}
                    />
                  </div>
                  <span className="campo-dica" id={`${ids}-verba-d`}>
                    {opcoes.campaign_cap_micros === null ? 'A empresa ainda não definiu o teto por campanha.' : `Teto por campanha: ${reaisDeMicros(BigInt(opcoes.campaign_cap_micros))} por dia.`} Enquanto estiver pausada, ela não gasta.
                  </span>
                  {erroDe('verba')}
                </div>
                <div className="campo">
                  <label htmlFor={`${ids}-fim`}>
                    Termina em <span className="campo-dica">Opcional.</span>
                  </label>
                  <input
                    className="input"
                    type="date"
                    id={`${ids}-fim`}
                    data-campo="fim"
                    min={hoje}
                    value={campos.fim}
                    aria-describedby={descrito('fim', `${ids}-fim-d`)}
                    aria-invalid={erros.fim ? true : undefined}
                    onChange={(e) => mudar({ fim: e.target.value }, 'fim')}
                    disabled={enviando}
                  />
                  <span className="campo-dica" id={`${ids}-fim-d`}>
                    Em branco, não tem data de fim. Ela começa quando você ativar.
                  </span>
                  {erroDe('fim')}
                </div>
                <p className="pd-efeito" role="status">
                  {efeitoDaCampanha(campos.verba)}
                </p>
                <div className="pd-bloco">
                  <p className="rotulo-marca">Como o Google gasta</p>
                  <dl className="pd-agora cn-destino">
                    <dt>Lance</dt>
                    <dd>
                      Maximizar conversões
                      <small>o Google busca o máximo de pedidos dentro da verba diária, sem alvo de custo por pedido</small>
                    </dd>
                    <dt>Para onde leva</dt>
                    <dd>
                      O cardápio online{loja ? ` da ${loja.name}` : ''}
                      <small>no Google, este tipo de campanha não abre conversa no WhatsApp</small>
                    </dd>
                    <dt>Rastreio do Liame</dt>
                    <dd>
                      Vai junto, no sufixo do URL final
                      <small>os pedidos deste anúncio aparecem em Resultados</small>
                    </dd>
                  </dl>
                </div>
                {opcoes.campaign_cap_micros === null ? (
                  <div className="pd-aviso">
                    <Icone nome="alert" />
                    <div>
                      <b>A empresa ainda não definiu os limites</b>
                      <span>A campanha pode ser criada pausada. Para ativar, o Dono ou o Administrador define antes o teto do mês e o teto por campanha, em Verba do mês.</span>
                    </div>
                  </div>
                ) : (
                  <div className="pd-bloco">
                    <p className="rotulo-marca">Limites da empresa</p>
                    <ul className="pd-limites">
                      <li>
                        <span>Teto por campanha</span>
                        <b>{reaisDeMicros(BigInt(opcoes.campaign_cap_micros))} por dia</b>
                      </li>
                      <li>
                        <span>Verba do mês</span>
                        <b>conferida ao ativar</b>
                      </li>
                    </ul>
                  </div>
                )}
                <p className="pd-nota">
                  <Icone nome="shield" pequeno />
                  <span>
                    O pedido vai para Aprovações, com a prévia. Depois da aprovação com o código do app, o Liame confere com o Google e cria tudo numa requisição só: o orçamento, a campanha, o raio e o grupo de recursos com os textos, os recortes, o nome e a logo, pausados. Se o Google recusar, nada é criado.
                  </span>
                </p>
              </div>
            </div>
          </div>
          <div className="dialogo-acoes">
            <button className="btn" type="button" onClick={fechar} disabled={enviando}>
              Cancelar
            </button>
            <button className="btn btn--primary" type="submit" aria-disabled={bloqueio || semEndereco ? true : undefined} aria-describedby={bloqueio || semEndereco ? `${ids}-bloqueio` : undefined} aria-busy={enviando || undefined}>
              {enviando ? 'Pedindo…' : 'Pedir a criação'}
            </button>
          </div>
        </form>
      )}
    </dialog>
  );
}
