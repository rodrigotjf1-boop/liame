'use client';

import type { AdPieceResponse, BrandPhoto, NewCampaignObjective, NewCampaignOptionsResponse, NewCampaignResponse } from '@liame/contracts';
import Link from 'next/link';
import { type FormEvent, useId, useRef, useState } from 'react';
import { Icone } from '@/components/ui/icone';
import { useDialogo } from '@/components/ui/use-dialogo';
import { microsDeReais } from '@/components/links/cupons-textos';
import { api, chamar } from '@/lib/api';
import { disparar } from '@/lib/disparar';
import { reaisDeMicros } from '@/lib/formato';
import {
  type CamposDaCampanha,
  type CampoComErro,
  conferirCampanha,
  destinoDoObjetivo,
  dicaDoObjetivo,
  dicaDoRaio,
  duracaoCurta,
  efeitoDaCampanha,
  ehVideo,
  erroDoPedido,
  type ErrosDaCampanha,
  OBJETIVOS,
  raiosDaLoja,
  temCapa,
} from './campanha-nova-textos';

// A gaveta "Campanha nova, pausada" (A4, X5, parte 5; protótipo P42 aprovado em 11/11/2026, D-A4-42 a D-A4-46): a peça
// de texto aprovada com a foto ou o vídeo de Fotos, o objetivo, o raio em volta da loja, a verba e o fim, quem assina e
// para onde leva, e a prévia ao lado. "Pedir a criação" grava o pedido, que espera o código do app em Aprovações.

interface Props {
  brandId: string;
  peca: AdPieceResponse;
  opcoes: NewCampaignOptionsResponse;
  /** As fotos e os vídeos prontos de Fotos; nulo quando Fotos não abriu ou está desligada. */
  midias: BrandPhoto[] | null;
  /** Hoje no fuso da empresa (`AAAA-MM-DD`): o fim precisa ser depois. */
  hoje: string;
  aoFechar: () => void;
  aoCriado: (c: NewCampaignResponse) => void;
}

export function GavetaCampanhaNova({ brandId, peca, opcoes, midias, hoje, aoFechar, aoCriado }: Props) {
  const ids = useId();
  const titulo = useRef<HTMLHeadingElement>(null);
  const { ref, fechar, devolverFoco } = useDialogo({ focoInicial: titulo });
  // O vídeo sem capa aparece, marcado: escolhido, a conferência diz por que não serve.
  const prontas = midias ?? [];
  const lojas = opcoes.units;
  const lojaInicial = lojas.find((u) => u.has_address && u.menu_available) ?? lojas.find((u) => u.has_address) ?? lojas[0] ?? null;
  const [campos, setCampos] = useState<CamposDaCampanha>({
    midia: null,
    loja: lojaInicial?.id ?? null,
    nome: `${peca.current.title} · ${new Intl.DateTimeFormat('pt-BR', { month: 'long' }).format(new Date(`${hoje}T12:00:00`))}`.slice(0, 80),
    objetivo: lojaInicial && !lojaInicial.menu_available ? 'whatsapp' : 'cardapio',
    raio: 5,
    verba: '30,00',
    fim: '',
  });
  const [tipo, setTipo] = useState<'foto' | 'video'>('foto');
  const [aba, setAba] = useState<'instagram' | 'facebook'>('instagram');
  const [erros, setErros] = useState<ErrosDaCampanha>({});
  const [erroGeral, setErroGeral] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);
  const [criado, setCriado] = useState<NewCampaignResponse | null>(null);

  const loja = lojas.find((u) => u.id === campos.loja) ?? null;
  const midia = prontas.find((m) => m.id === campos.midia) ?? null;
  const lista = prontas.filter((m) => (tipo === 'video') === ehVideo(m));
  const pagina = opcoes.page?.name ?? null;
  const bloqueio = opcoes.blocks[0] ?? null;
  const semEndereco = loja !== null && !loja.has_address;
  const destino = destinoDoObjetivo(campos.objetivo, loja, pagina);
  const raios = raiosDaLoja(loja);

  function mudar(p: Partial<CamposDaCampanha>, campo?: CampoComErro) {
    setCampos((c) => ({ ...c, ...p }));
    if (campo) setErros((e) => ({ ...e, [campo]: undefined }));
    setErroGeral(null);
  }

  function focar(e: ErrosDaCampanha) {
    const ordem: CampoComErro[] = ['midia', 'loja', 'nome', 'objetivo', 'verba', 'fim'];
    const primeiro = ordem.find((c) => e[c]);
    if (primeiro) ref.current?.querySelector<HTMLElement>(`[data-campo="${primeiro}"]`)?.focus();
  }

  async function mandar(ev: FormEvent) {
    ev.preventDefault();
    if (enviando || bloqueio || semEndereco) return;
    const e = conferirCampanha(campos, opcoes, prontas, hoje);
    setErros(e);
    if (Object.values(e).some(Boolean)) return focar(e);
    setEnviando(true);
    const r = await chamar(() =>
      api.POST('/v1/new-campaigns', {
        body: {
          brand_id: brandId,
          piece_id: peca.id,
          media_id: campos.midia!,
          unit_id: campos.loja!,
          name: campos.nome.trim(),
          objective: campos.objetivo,
          radius_km: campos.raio,
          daily_budget_micros: Number(microsDeReais(campos.verba)),
          ...(campos.fim ? { end_date: campos.fim } : {}),
        },
      }),
    );
    setEnviando(false);
    if (!r.ok) {
      const { campo, texto } = erroDoPedido(r.problema);
      if (campo) {
        setErros({ [campo]: texto });
        return focar({ [campo]: texto });
      }
      return setErroGeral(texto);
    }
    setCriado(r.data);
    aoCriado(r.data);
  }

  const erroDe = (c: CampoComErro) =>
    erros[c] ? (
      <span className="campo-erro" id={`${ids}-${c}-erro`} role="alert">
        {erros[c]}
      </span>
    ) : null;
  const descrito = (c: CampoComErro, dica?: string) => [dica, erros[c] ? `${ids}-${c}-erro` : null].filter(Boolean).join(' ') || undefined;
  const cab = (
    <div className="dialogo-cab">
      <div className="dlg-titulo">
        <p className="rotulo-marca">Campanha nova, pausada</p>
        <h2 id={`${ids}-t`} ref={titulo} tabIndex={-1}>
          {criado ? 'Pedido criado' : peca.current.title}
        </h2>
      </div>
      <button className="btn btn--icon btn--ghost" type="button" onClick={fechar} aria-label="Fechar" disabled={enviando}>
        <Icone nome="x" />
      </button>
    </div>
  );

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
                <b>{criado.name}.</b> Ele espera a aprovação com o código do app. Nada é criado na Meta antes disso.
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
              <div className="pd-aviso pd-aviso--perigo" role="alert">
                <Icone nome="alert-circle" />
                <div>
                  <b>{bloqueio.title}</b>
                  <span>{bloqueio.detail}</span>
                  {bloqueio.code !== 'funcao-desligada' && (
                    <Link className="btn btn--sm" href="/contas">
                      Abrir Contas conectadas
                    </Link>
                  )}
                </div>
              </div>
            )}
            {!bloqueio && semEndereco && (
              <div className="pd-aviso pd-aviso--perigo" role="alert">
                <Icone nome="alert-circle" />
                <div>
                  <b>Falta o endereço da loja</b>
                  <span id={`${ids}-sem-endereco`}>
                    A campanha mostra o anúncio em volta da loja, e o ponto dela ainda não está no endereço. Ajuste o endereço da loja em Minha marca antes.
                  </span>
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
            <div className="cn-grade">
              <div className="cn-f1">
                <div className="pd-bloco">
                  <p className="rotulo-marca">A peça (o texto)</p>
                  <div className="cn-peca">
                    <b>{peca.current.title}</b>
                    <p>{peca.current.body}</p>
                    <small>Versão {peca.current.version} · aprovada em Criativos · texto feito com IA, conferido pelo Compliance</small>
                  </div>
                </div>
                <div className="campo" role="group" aria-labelledby={`${ids}-midia-t`} aria-describedby={descrito('midia', `${ids}-midia-d`)}>
                  <span className="rotulo" id={`${ids}-midia-t`}>
                    A foto ou o vídeo
                  </span>
                  <div className="seg cn-tipo" role="group" aria-label="Foto ou vídeo">
                    {(['foto', 'video'] as const).map((t) => (
                      <button key={t} type="button" aria-pressed={tipo === t} onClick={() => setTipo(t)} disabled={enviando}>
                        <Icone nome={t === 'foto' ? 'image' : 'video'} pequeno />
                        {t === 'foto' ? 'Foto' : 'Vídeo'}
                      </button>
                    ))}
                  </div>
                  <span className="campo-dica" id={`${ids}-midia-d`}>
                    {tipo === 'video'
                      ? 'Os vídeos de verdade da tela Fotos, como a loja gravou. O anúncio usa a capa que o vídeo tem lá.'
                      : 'As fotos de verdade da tela Fotos, como a loja enviou. A imagem feita por IA segue adiada.'}
                  </span>
                  {lista.length ? (
                    <ul className="po-fotos" aria-label={tipo === 'video' ? 'Vídeos da marca' : 'Fotos da marca'}>
                      {lista.map((m, i) => (
                        <li key={m.id}>
                          <button
                            className="po-foto-op cn-op"
                            type="button"
                            data-campo={i === 0 ? 'midia' : undefined}
                            aria-pressed={campos.midia === m.id}
                            aria-label={`${m.product ?? 'Sem produto'}${m.description ? `: ${m.description}` : ''}${ehVideo(m) && m.video ? `, ${duracaoCurta(m.video.duration_ms)}` : ''}${temCapa(m) ? '' : ', sem capa'}`}
                            onClick={() => mudar({ midia: m.id }, 'midia')}
                            disabled={enviando}
                          >
                            <img src={m.thumbnail_url} alt="" referrerPolicy="no-referrer" />
                            {ehVideo(m) && m.video && (
                              <span className="po-video-dur" aria-hidden="true">
                                {duracaoCurta(m.video.duration_ms)}
                              </span>
                            )}
                            {!temCapa(m) && (
                              <span className="cn-op-tag" aria-hidden="true">
                                sem capa
                              </span>
                            )}
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="pd-nota">
                      <Icone nome="camera" pequeno />
                      <span>
                        {midias === null
                          ? 'As Fotos não abriram agora, ou não estão ligadas para esta empresa: a campanha precisa de uma foto ou de um vídeo de lá.'
                          : `Nenhum${tipo === 'video' ? ' vídeo pronto' : 'a foto pronta'} em Fotos desta marca. Envie em Fotos.`}
                      </span>
                    </p>
                  )}
                  {erroDe('midia')}
                </div>
              </div>

              <section className="cn-lado" aria-labelledby={`${ids}-previa-t`}>
                <h3 className="rotulo-marca" id={`${ids}-previa-t`}>
                  Como o anúncio aparece
                </h3>
                <div className="seg" role="group" aria-label="Ver como sai em">
                  {(['instagram', 'facebook'] as const).map((a) => (
                    <button key={a} type="button" aria-pressed={aba === a} onClick={() => setAba(a)}>
                      {a === 'instagram' ? 'Instagram' : 'Facebook'}
                    </button>
                  ))}
                </div>
                <PreviaDoAnuncio peca={peca} midia={midia} objetivo={campos.objetivo} nome={aba === 'instagram' ? (opcoes.instagram?.name ?? pagina ?? '') : (pagina ?? '')} instagram={aba === 'instagram'} />
                <p className="pd-nota">
                  <Icone nome="info" pequeno />
                  <span>É um desenho do Feed. Na Meta, cada posição mostra de um jeito: com a campanha criada, pausada, dá para ver o anúncio de verdade no Gerenciador de Anúncios antes de ativar.</span>
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
                      onChange={(e) => {
                        const u = lojas.find((x) => x.id === e.target.value);
                        mudar({ loja: e.target.value, ...(u && !u.menu_available ? { objetivo: 'whatsapp' as NewCampaignObjective } : {}) }, 'loja');
                      }}
                      disabled={enviando}
                    >
                      {lojas.map((u) => (
                        <option key={u.id} value={u.id}>
                          {u.name}
                          {u.has_address ? '' : ' (sem o endereço)'}
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
                    É o nome que aparece na Meta e em Resultados.
                  </span>
                  {erroDe('nome')}
                </div>
                <fieldset className="campo">
                  <legend>O que você quer do anúncio</legend>
                  <div className="pd-escolha">
                    {(Object.keys(OBJETIVOS) as NewCampaignObjective[]).map((o, i) => (
                      <label key={o} className="pd-opcao">
                        <input
                          type="radio"
                          name={`${ids}-objetivo`}
                          value={o}
                          data-campo={i === 0 ? 'objetivo' : undefined}
                          checked={campos.objetivo === o}
                          disabled={enviando || (o === 'cardapio' && loja !== null && !loja.menu_available)}
                          aria-describedby={descrito('objetivo', `${ids}-obj-d`)}
                          onChange={() => mudar({ objetivo: o }, 'objetivo')}
                        />
                        <Icone nome={OBJETIVOS[o].icone} pequeno />
                        {OBJETIVOS[o].rotulo}
                      </label>
                    ))}
                  </div>
                  {loja && !loja.menu_available ? (
                    <p className="cn-aviso" id={`${ids}-obj-d`}>
                      <Icone nome="info" pequeno />
                      <span>
                        <b>Só o WhatsApp.</b> {loja.menu_block}
                      </span>
                    </p>
                  ) : (
                    <span className="campo-dica" id={`${ids}-obj-d`}>
                      {dicaDoObjetivo(campos.objetivo, loja, pagina)}
                    </span>
                  )}
                  {erroDe('objetivo')}
                </fieldset>
                <fieldset className="campo">
                  <legend>Quem vê</legend>
                  <div className="pd-escolha">
                    {raios.map((r) => (
                      <label key={r.rotulo} className="pd-opcao">
                        <input
                          type="radio"
                          name={`${ids}-raio`}
                          value={r.km}
                          checked={campos.raio === r.km}
                          disabled={enviando || semEndereco}
                          aria-describedby={`${ids}-raio-d`}
                          onChange={() => mudar({ raio: r.km })}
                        />
                        {r.rotulo}
                      </label>
                    ))}
                  </div>
                  {loja && (
                    <span className="campo-dica" id={`${ids}-raio-d`}>
                      {dicaDoRaio(campos.raio, loja)}
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
                    {opcoes.campaign_cap_micros === null
                      ? 'A empresa ainda não definiu o teto por campanha.'
                      : `Teto por campanha: ${reaisDeMicros(BigInt(opcoes.campaign_cap_micros))} por dia.`}{' '}
                    Enquanto estiver pausada, ela não gasta.
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
                  <p className="rotulo-marca">Quem assina o anúncio</p>
                  <dl className="pd-agora">
                    <dt>No Facebook</dt>
                    <dd>
                      {pagina ? `Página ${pagina}` : 'Falta a Página'}
                      <small>o nome e a foto dela aparecem no topo do anúncio</small>
                    </dd>
                    <dt>No Instagram</dt>
                    <dd>
                      {opcoes.instagram?.name ?? 'Sem o Instagram ligado à Página'}
                      <small>{opcoes.instagram ? 'a conta ligada à Página' : 'o anúncio sai no Instagram em nome da Página'}</small>
                    </dd>
                  </dl>
                </div>
                <div className="pd-bloco">
                  <p className="rotulo-marca">Para onde leva</p>
                  <dl className="pd-agora">
                    <dt>Destino</dt>
                    <dd>
                      {destino.leva}
                      <small>{destino.onde}</small>
                    </dd>
                    <dt>Botão do anúncio</dt>
                    <dd>
                      {OBJETIVOS[campos.objetivo].botao}
                      <small>acompanha o que você quer do anúncio</small>
                    </dd>
                    <dt>Rastreio do Liame</dt>
                    <dd>
                      {OBJETIVOS[campos.objetivo].rastreio}
                      <small>os pedidos deste anúncio aparecem em Resultados</small>
                    </dd>
                    <dt>Melhorias automáticas da Meta</dt>
                    <dd>
                      Desligadas
                      <small>o anúncio vai como a peça e a mídia que você escolheu</small>
                    </dd>
                  </dl>
                </div>
                <p className="pd-nota">
                  <Icone nome="shield" pequeno />
                  <span>
                    O pedido vai para Aprovações, com a prévia do anúncio. Depois da aprovação com o código do app, o Liame confere com a Meta e cria{' '}
                    {midia && ehVideo(midia) ? 'a campanha, o conjunto, o vídeo, o criativo e o anúncio' : 'a campanha, o conjunto, o criativo e o anúncio'}, tudo pausado.
                    {midia && ehVideo(midia) ? ' A Meta prepara o vídeo antes (até 15 minutos).' : ''}
                  </span>
                </p>
              </div>
            </div>
          </div>
          <div className="dialogo-acoes">
            <button className="btn" type="button" onClick={fechar} disabled={enviando}>
              Cancelar
            </button>
            <button
              className="btn btn--primary"
              type="submit"
              disabled={enviando}
              aria-disabled={bloqueio || semEndereco ? true : undefined}
              aria-describedby={semEndereco ? `${ids}-sem-endereco` : undefined}
            >
              {enviando ? 'Pedindo…' : 'Pedir a criação'}
            </button>
          </div>
        </form>
      )}
    </dialog>
  );
}

/** A prévia do anúncio no Feed: quem assina, a mídia da loja (a capa no vídeo), o botão e o texto da peça. */
export function PreviaDoAnuncio({
  peca,
  midia,
  objetivo,
  nome,
  instagram,
}: {
  peca: AdPieceResponse;
  midia: BrandPhoto | null;
  objetivo: NewCampaignObjective;
  nome: string;
  instagram: boolean;
}) {
  const forma = !midia ? 'vazia' : midia.height > midia.width * 1.05 ? 'alta' : midia.width > midia.height * 1.05 ? 'deitada' : 'quadrada';
  const iniciais = nome
    .replace('@', '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((x) => x.charAt(0).toLocaleUpperCase('pt-BR'))
    .join('');
  return (
    <div className="previa cn-previa" role="group" aria-label={`Prévia do anúncio no ${instagram ? 'Instagram' : 'Facebook'}`}>
      <div className="pv-cab">
        <span className="pv-av" aria-hidden="true">
          {iniciais || 'MB'}
        </span>
        <span className="pv-quem">
          <b>{nome || 'A Página da marca'}</b>
          <small>Patrocinado</small>
        </span>
      </div>
      {!instagram && <p className="pv-texto">{peca.current.body}</p>}
      <div className={`cn-midia cn-midia--${forma}`}>
        {midia ? (
          <>
            <img src={midia.thumbnail_url} alt={midia.description || `Foto: ${midia.product ?? 'sem produto'}`} referrerPolicy="no-referrer" />
            {ehVideo(midia) && (
              <span className="cn-play" aria-hidden="true">
                <Icone nome="play" />
              </span>
            )}
          </>
        ) : (
          <span>
            <Icone nome="image" />
            Escolha a foto ou o vídeo
          </span>
        )}
      </div>
      <div className="pv-pe">
        <span className="pv-pe-txt">
          <b>{peca.current.title}</b>
        </span>
        <span className="pv-bt">{OBJETIVOS[objetivo].botao}</span>
      </div>
      {instagram && (
        <p className="pv-texto">
          <b>{nome}</b> {peca.current.body}
        </p>
      )}
    </div>
  );
}
