'use client';

import type { BrandDossierContent, BrandDossierResponse, BrandDossierSuggestion, BrandResponse, DossierSection } from '@liame/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAvisar } from '@/components/ui/avisos';
import { Estado } from '@/components/ui/estado';
import { Faixa } from '@/components/ui/faixa';
import { Icone } from '@/components/ui/icone';
import { useAgora } from '@/lib/agora';
import { api, chamar, mensagemDe, type Problema } from '@/lib/api';
import { disparar } from '@/lib/disparar';
import { quandoComHora } from '@/lib/formato';
import { useSessao } from '@/lib/sessao';
import { CartaoSecao } from './cartao-secao';
import { GavetaSecao } from './gaveta-secao';
import { GavetaSugestao } from './gaveta-sugestao';
import { GavetaVersoes } from './gaveta-versoes';
import { Guia } from './guia';
import { andamentoDo, aplicarSugestao, juntar, linhaDoAndamento, quemConfirmou, SECOES } from './textos';

// "Minha marca" (mockups/prototipo-marca.html, P6 aprovado em 03/10/2026): o dossiê que os funcionários de IA leem
// antes de escrever. Nove partes, cada mudança confirmada vira uma versão do dossiê inteiro, e sugestão só vale
// depois que alguém confere. Quem vê é quem tem `dossie.ver`; quem muda, o Dono e o Administrador (`dossie.editar`).

type Carga =
  | { tipo: 'carregando' }
  | { tipo: 'ok'; dossie: BrandDossierResponse; sugestoes: BrandDossierSuggestion[] }
  | { tipo: 'erro'; problema: Problema };

type Gaveta =
  | { tipo: 'secao'; secao: DossierSection; rascunho?: BrandDossierContent }
  | { tipo: 'sugestao'; id: string }
  | { tipo: 'versoes' }
  | null;

export function MarcaTela() {
  const { pode } = useSessao();
  const avisar = useAvisar();
  const podeVer = pode('dossie.ver');
  const titulo = useRef<HTMLHeadingElement>(null);
  const titulosDasPartes = useRef<Partial<Record<DossierSection, HTMLHeadingElement | null>>>({});
  const tituloDoFim = useRef<HTMLHeadingElement>(null);
  const [marcas, setMarcas] = useState<BrandResponse[] | null>(null);
  const [erroMarcas, setErroMarcas] = useState<Problema | null>(null);
  const [marca, setMarca] = useState<string | null>(null);
  const [carga, setCarga] = useState<Carga>({ tipo: 'carregando' });
  const [tentativa, setTentativa] = useState(0);
  const [gaveta, setGaveta] = useState<Gaveta>(null);
  const [guiado, setGuiado] = useState(false);
  const [sozinho, setSozinho] = useState(false);
  const [fim, setFim] = useState(false);
  const [restaurada, setRestaurada] = useState<{ de: number; nova: number; antes: number } | null>(null);
  const [anuncio, setAnuncio] = useState('');
  const focar = useRef<DossierSection | 'titulo' | 'fim' | null>(null);
  const seq = useRef(0);
  const agora = useAgora(60_000, carga);

  const carregarMarcas = useCallback(async () => {
    setErroMarcas(null);
    const r = await chamar(() => api.GET('/v1/brands'));
    if (!r.ok) return setErroMarcas(r.problema);
    const ativas = r.data.items.filter((b) => !b.archived_at);
    setMarcas(ativas);
    setMarca((m) => (m && ativas.some((b) => b.id === m) ? m : (ativas[0]?.id ?? null)));
  }, []);

  useEffect(() => {
    if (podeVer) disparar(carregarMarcas());
  }, [podeVer, carregarMarcas]);

  useEffect(() => {
    if (!marca) return;
    const id = ++seq.current;
    setCarga({ tipo: 'carregando' });
    setGaveta(null);
    setGuiado(false);
    setSozinho(false);
    setFim(false);
    setRestaurada(null);
    const query = { brand_id: marca };
    disparar(
      Promise.all([chamar(() => api.GET('/v1/brand-dossier', { params: { query } })), chamar(() => api.GET('/v1/brand-dossier/suggestions', { params: { query } }))]).then(([d, s]) => {
        if (id !== seq.current) return;
        // Sem a lista de sugestões, a página abre do mesmo jeito (a parte só não ganha o botão de conferir).
        setCarga(d.ok ? { tipo: 'ok', dossie: d.data, sugestoes: s.ok ? s.data.items : [] } : { tipo: 'erro', problema: d.problema });
      }),
    );
  }, [marca, tentativa]);

  // O foco depois de uma ação (salvar uma parte, voltar a uma versão, terminar o passo a passo) vai para o que mudou.
  useEffect(() => {
    const alvo = focar.current;
    if (!alvo || carga.tipo !== 'ok') return;
    focar.current = null;
    const el = alvo === 'titulo' ? titulo.current : alvo === 'fim' ? tituloDoFim.current : titulosDasPartes.current[alvo];
    el?.focus({ preventScroll: alvo !== 'titulo' && alvo !== 'fim' });
  });

  /** Depois de uma mudança: a página passa a mostrar o dossiê novo e as sugestões de agora. */
  const aplicar = useCallback(async (dossie: BrandDossierResponse) => {
    setCarga((c) => (c.tipo === 'ok' ? { ...c, dossie } : { tipo: 'ok', dossie, sugestoes: [] }));
    const s = await chamar(() => api.GET('/v1/brand-dossier/suggestions', { params: { query: { brand_id: dossie.brand_id } } }));
    if (s.ok) setCarga((c) => (c.tipo === 'ok' && c.dossie.brand_id === dossie.brand_id ? { ...c, sugestoes: s.data.items } : c));
  }, []);

  if (!podeVer) {
    return (
      <Estado icone="lock" titulo="Esta tela é de quem cuida da marca">
        O seu nível nesta empresa não mostra o dossiê da marca. Se precisar, peça ao dono da conta.
      </Estado>
    );
  }

  const dados = carga.tipo === 'ok' ? carga : null;
  const dossie = dados?.dossie ?? null;
  const nomeDaMarca = dossie?.brand_name ?? marcas?.find((m) => m.id === marca)?.name ?? 'sua marca';
  const versao = dossie?.version ?? null;
  const podeEditar = Boolean(dossie?.can_edit);

  function salvo(novo: BrandDossierResponse, mudou: boolean, parte: DossierSection) {
    setRestaurada(null);
    focar.current = parte;
    disparar(aplicar(novo));
    const n = novo.version?.version ?? 0;
    if (mudou) {
      avisar(`Versão ${n} confirmada. Os funcionários de IA já usam esta versão.`);
      setAnuncio(`Versão ${n} confirmada.`);
    } else avisar('Nada mudou: a versão continua a mesma.');
  }

  let corpo;
  if (erroMarcas || carga.tipo === 'erro') {
    const problema = erroMarcas ?? (carga.tipo === 'erro' ? carga.problema : null);
    corpo = (
      <div className="card">
        <Estado
          icone="alert-circle"
          perigo
          titulo="Não foi possível carregar a marca"
          acao={
            <div className="vazio-acoes">
              <button
                className="btn btn--primary"
                type="button"
                onClick={() => {
                  focar.current = 'titulo';
                  if (erroMarcas) disparar(carregarMarcas());
                  else setTentativa((t) => t + 1);
                }}
              >
                <Icone nome="refresh" />
                Tentar de novo
              </button>
            </div>
          }
        >
          {problema ? mensagemDe(problema) : 'Tente de novo em instantes.'} Nada foi perdido.
        </Estado>
      </div>
    );
  } else if (marcas && !marcas.length) {
    corpo = (
      <div className="card">
        <Estado icone="info" titulo="Nenhuma marca ativa nesta empresa">
          O dossiê é por marca: quando a empresa tiver uma marca ativa, ele aparece aqui.
        </Estado>
      </div>
    );
  } else if (!dados || !dossie) {
    corpo = <MarcaCarregando />;
  } else if (guiado) {
    corpo = (
      <Guia
        marca={{ id: dossie.brand_id, nome: nomeDaMarca }}
        base={{ versao: versao?.version ?? 0, conteudo: dossie.content }}
        provas={dossie.system_proof}
        sugestoes={dados.sugestoes}
        aoTerminar={(novo) => {
          setGuiado(false);
          if (novo) {
            setFim(true);
            focar.current = 'fim';
            disparar(aplicar(novo));
            setAnuncio(`A marca está pronta: versão ${novo.version?.version ?? 1}.`);
          } else {
            setSozinho(true);
            focar.current = 'titulo';
            avisar('Nada foi preenchido: a marca continua como estava.');
          }
        }}
        aoSair={(novo) => {
          setGuiado(false);
          focar.current = 'titulo';
          if (novo) disparar(aplicar(novo));
        }}
      />
    );
  } else if (fim && versao) {
    const a = andamentoDo(dossie.content, dossie.system_proof, []);
    corpo = (
      <div className="card">
        <div className="vazio">
          <span className="vazio-ic vazio-ic--ok" aria-hidden="true">
            <Icone nome="check-circle" />
          </span>
          <h2 tabIndex={-1} ref={tituloDoFim}>
            A marca está pronta: versão {versao.version}
          </h2>
          <p>
            {a.preenchidas} de {a.total} partes preenchidas. Os funcionários de IA já usam esta versão.
            {a.vazias.length ? ` ${juntar(a.vazias.map((s) => s.titulo))} ${a.vazias.length === 1 ? 'ficou vazia' : 'ficaram vazias'}: dá para preencher quando quiser.` : ''}
          </p>
          <div className="vazio-acoes">
            <button
              className="btn btn--primary"
              type="button"
              onClick={() => {
                focar.current = 'titulo';
                setFim(false);
              }}
            >
              Ver a marca
            </button>
          </div>
        </div>
      </div>
    );
  } else if (!versao && !sozinho && podeEditar) {
    corpo = (
      <div className="mk-vazio">
        <div className="card">
          <div className="vazio">
            <span className="vazio-ic" aria-hidden="true">
              <Icone nome="palette" />
            </span>
            <h2>A marca ainda não foi preenchida</h2>
            <p>
              Os funcionários de IA usam o que estiver aqui para escrever do jeito da {nomeDaMarca} e não dizer o que ela não diz. Leva uns 20 minutos. O Liame sugere a partir do que já sabe: as
              vendas do Regem e os cupons das campanhas.
            </p>
            <div className="vazio-acoes">
              <button className="btn btn--primary" type="button" onClick={() => setGuiado(true)}>
                <Icone nome="sparkles" />
                Preencher passo a passo
              </button>
              <button
                className="btn"
                type="button"
                onClick={() => {
                  focar.current = 'titulo';
                  setSozinho(true);
                }}
              >
                Preencher sozinho
              </button>
            </div>
          </div>
        </div>
        <ul className="mk-lista-vazia" aria-label="As nove partes da marca">
          {SECOES.map((s) => (
            <li key={s.id}>
              <Icone nome={s.icone} pequeno />
              <span>{s.titulo}</span>
            </li>
          ))}
        </ul>
      </div>
    );
  } else {
    const a = andamentoDo(dossie.content, dossie.system_proof, dados.sugestoes);
    const primeiraVazia = a.vazias[0];
    corpo = (
      <div className="mk">
        {!podeEditar ? (
          <Faixa icone={<Icone nome="lock" />} titulo="Você vê a marca, mas só o Dono e o Administrador mudam" texto="Se algo estiver errado, peça a um deles. Os funcionários de IA usam a versão confirmada." />
        ) : restaurada ? (
          <Faixa
            tipo="acao"
            icone={<Icone nome="undo" />}
            titulo={`Você voltou para a versão ${restaurada.de}`}
            texto={`Ela agora é a versão ${restaurada.nova}, a que os funcionários usam. A versão ${restaurada.antes} continua guardada.`}
            acao={
              <button className="btn btn--sm" type="button" onClick={() => setGaveta({ tipo: 'versoes' })} aria-haspopup="dialog">
                Ver versões
              </button>
            }
          />
        ) : null}
        <article className="card mk-geral" aria-labelledby="mk-geral-t">
          <div className="mk-geral-linha">
            <div>
              <p className="rotulo-marca">Dossiê da marca</p>
              <p className="mk-geral-tit" id="mk-geral-t">
                {versao ? `Versão ${versao.version}, confirmada por ${quemConfirmou(versao, agora)}` : 'Ainda sem versão: cada parte que você salvar entra na versão 1'}
              </p>
            </div>
            {podeEditar && primeiraVazia && (
              <button className="btn btn--sm" type="button" onClick={() => setGaveta({ tipo: 'secao', secao: primeiraVazia.id })} aria-haspopup="dialog">
                <Icone nome="plus" pequeno />
                Preencher {primeiraVazia.titulo.toLocaleLowerCase('pt-BR')}
              </button>
            )}
          </div>
          <div className="mk-barra" role="img" aria-label={`${a.preenchidas} de ${a.total} partes preenchidas`}>
            <span style={{ width: `${Math.round((a.preenchidas / a.total) * 100)}%` }} />
          </div>
          <p className="mk-geral-sub">{linhaDoAndamento(a)}</p>
          <p className="explica-nota">Os funcionários de IA usam a versão confirmada. Sugestão só vale depois que alguém confere, e cada mudança vira uma versão nova.</p>
        </article>
        <div className="mk-grade">
          {SECOES.map((s) => {
            const sugestao = dados.sugestoes.find((x) => x.section === s.id) ?? null;
            const vazia = a.vazias.some((v) => v.id === s.id);
            const situacao = sugestao ? 'sugestao' : vazia ? 'vazia' : 'confirmada';
            const acoes = podeEditar ? (
              <>
                {sugestao && (
                  <button className="btn btn--sm btn--primary" type="button" onClick={() => setGaveta({ tipo: 'sugestao', id: sugestao.id })} aria-haspopup="dialog">
                    <Icone nome="sparkles" pequeno />
                    Conferir a sugestão
                    <span className="sr-only"> de {s.titulo}</span>
                  </button>
                )}
                <button className="btn btn--sm" type="button" onClick={() => setGaveta({ tipo: 'secao', secao: s.id })} aria-haspopup="dialog">
                  <Icone nome={vazia ? 'plus' : 'pencil'} pequeno />
                  {vazia ? 'Preencher' : 'Editar'}
                  <span className="sr-only"> {s.titulo}</span>
                </button>
              </>
            ) : sugestao ? (
              <p className="eixo-nota">Sugestão para o Dono ou o Administrador conferir.</p>
            ) : null;
            return (
              <CartaoSecao
                key={s.id}
                secao={s.id}
                conteudo={dossie.content}
                provas={dossie.system_proof}
                situacao={situacao}
                nomeDaMarca={nomeDaMarca}
                acoes={acoes}
                tituloRef={(el) => {
                  titulosDasPartes.current[s.id] = el;
                }}
              />
            );
          })}
        </div>
        {versao && (
          <details className="mk-como">
            <summary>
              <Icone nome="chevron-down" pequeno />
              Como os funcionários de IA leem a marca
            </summary>
            <p className="explica-nota">
              O texto abaixo é montado pelo sistema, sempre na mesma ordem, a partir da versão {versao.version}. Vai junto em cada pedido aos funcionários de IA, sem dado pessoal.
            </p>
            <div className="mk-texto-ia">{dossie.model_text}</div>
          </details>
        )}
      </div>
    );
  }

  const sugestaoAberta = gaveta?.tipo === 'sugestao' && dados ? (dados.sugestoes.find((s) => s.id === gaveta.id) ?? null) : null;

  return (
    <section aria-labelledby="h-marca">
      <div className="view-cab anima" style={{ ['--i' as string]: 0 }}>
        <div>
          <h1 id="h-marca" ref={titulo} tabIndex={-1}>
            Minha marca
          </h1>
          <p>O que a {nomeDaMarca} é, vende e não pode dizer. Os funcionários de IA leem daqui, e nada novo vale antes de alguém confirmar.</p>
        </div>
        <div className="cab-acoes">
          {marcas && marcas.length > 1 && (
            <label className="res-campo">
              <span>Marca</span>
              <select className="input" value={marca ?? ''} onChange={(e) => setMarca(e.target.value)}>
                {marcas.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          {dossie && !guiado && !fim && (versao || sozinho || !podeEditar) && (
            <>
              <span className="lite-chip">{versao ? `Versão ${versao.version} · ${quandoComHora(versao.created_at, agora)}` : 'Sem versão ainda'}</span>
              {versao && (
                <button className="btn btn--sm" type="button" onClick={() => setGaveta({ tipo: 'versoes' })} aria-haspopup="dialog">
                  <Icone nome="history" pequeno />
                  Versões
                </button>
              )}
            </>
          )}
        </div>
      </div>
      {corpo}
      <p className="sr-only" role="status" aria-live="polite">
        {anuncio}
      </p>

      {dossie && gaveta?.tipo === 'secao' && (
        <GavetaSecao
          key={`secao-${gaveta.secao}`}
          secao={gaveta.secao}
          marca={{ id: dossie.brand_id, nome: nomeDaMarca }}
          base={{ versao: versao?.version ?? 0, conteudo: dossie.content }}
          rascunhoInicial={gaveta.rascunho}
          provas={dossie.system_proof}
          reserva={titulo}
          aoSalvar={(novo, mudou) => salvo(novo, mudou, gaveta.secao)}
          aoFechar={() => setGaveta(null)}
        />
      )}
      {dossie && sugestaoAberta && (
        <GavetaSugestao
          key={`sugestao-${sugestaoAberta.id}`}
          sugestao={sugestaoAberta}
          versaoBase={versao?.version ?? 0}
          agora={agora}
          reserva={titulo}
          aoUsar={(novo) => {
            setRestaurada(null);
            focar.current = sugestaoAberta.section;
            disparar(aplicar(novo));
            const n = novo.version?.version ?? 0;
            avisar(`Versão ${n} confirmada com a sugestão.`);
            setAnuncio(`Versão ${n} confirmada.`);
          }}
          aoDescartar={() => {
            focar.current = sugestaoAberta.section;
            setCarga((c) => (c.tipo === 'ok' ? { ...c, sugestoes: c.sugestoes.filter((s) => s.id !== sugestaoAberta.id) } : c));
            avisar('Sugestão descartada. A versão em uso continua a mesma.');
          }}
          aoEditarAntes={(marcados) => setGaveta({ tipo: 'secao', secao: sugestaoAberta.section, rascunho: aplicarSugestao(dossie.content, sugestaoAberta, marcados) })}
          aoFechar={() => setGaveta((g) => (g?.tipo === 'sugestao' ? null : g))}
        />
      )}
      {dossie && versao && gaveta?.tipo === 'versoes' && (
        <GavetaVersoes
          marca={{ id: dossie.brand_id, nome: nomeDaMarca }}
          atual={{ versao: versao.version, conteudo: dossie.content }}
          podeEditar={podeEditar}
          agora={agora}
          reserva={titulo}
          aoRestaurar={(novo, de) => {
            setRestaurada({ de, nova: novo.version?.version ?? 0, antes: versao.version });
            focar.current = 'titulo';
            disparar(aplicar(novo));
            avisar(`Pronto: a versão ${de} voltou como versão ${novo.version?.version ?? 0}.`);
            setAnuncio(`Versão ${novo.version?.version ?? 0} em uso, igual à ${de}.`);
          }}
          aoFechar={() => setGaveta(null)}
        />
      )}
    </section>
  );
}

function MarcaCarregando() {
  return (
    <div className="mk" aria-busy="true">
      <p className="sr-only">Carregando a marca…</p>
      <div className="card mk-esq" aria-hidden="true">
        <span className="esqueleto esqueleto--curto" />
        <span className="esqueleto" />
        <span className="esqueleto esqueleto--medio" />
      </div>
      <div className="mk-grade" aria-hidden="true">
        {[0, 1].map((i) => (
          <div className="card mk-esq" key={i}>
            <span className="esqueleto esqueleto--curto" />
            <span className="esqueleto" />
          </div>
        ))}
      </div>
    </div>
  );
}
