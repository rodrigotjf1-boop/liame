'use client';

import type { BrandPhoto, BrandPhotosResponse, BrandResponse } from '@liame/contracts';
import { type DragEvent, useCallback, useEffect, useRef, useState } from 'react';
import { useAvisar } from '@/components/ui/avisos';
import { Estado } from '@/components/ui/estado';
import { Faixa } from '@/components/ui/faixa';
import { Icone } from '@/components/ui/icone';
import { useAgora } from '@/lib/agora';
import { api, chamar, mensagemDe, type Problema } from '@/lib/api';
import { disparar } from '@/lib/disparar';
import { useSessao } from '@/lib/sessao';
import { CartaoFoto } from './cartao-foto';
import { DialogoApagarFoto } from './dialogo-apagar-foto';
import { enviarFoto, hashDoArquivo, medirImagem } from './enviar';
import { FilaDoEnvio, type ItemDoEnvio } from './fila-do-envio';
import { GavetaFoto } from './gaveta-foto';
import {
  ACEITA,
  conferirArquivo,
  conferirMedidas,
  contagens,
  ENVIOS_JUNTOS,
  enderecosVencendo,
  FALHA_DE_CONEXAO,
  foraDoLote,
  grupos,
  INFO_DO_ENVIO,
  nomeDoProduto,
  POR_VEZ,
  recusaDoCodigo,
  resumoDoEnvio,
  terminou,
  visiveis,
} from './textos';

// Fotos (A6 · Z4, parte b; mockups/prototipo-fotos.html, P20 aprovado em 21/10/2026): as fotos de verdade dos produtos
// que a empresa envia. A grade (a mais nova primeiro) com o filtro por produto; "Enviar fotos" (escolher ou arrastar
// para a tela), com a lista do envio; a gaveta da foto (o produto, o que aparece nela, apagar). Quem tem `fotos.ver`
// vê; quem tem `fotos.enviar` (o Dono, o Administrador e o Gestor; D-A6-19) envia, muda e apaga. A função `fotos`
// nasce desligada: desligada, a tela diz isso e não envia nada.

type Carga = { tipo: 'carregando' } | { tipo: 'ok'; dados: BrandPhotosResponse } | { tipo: 'erro'; problema: Problema };
type Foco = { tipo: 'titulo' } | { tipo: 'fila' } | { tipo: 'foto'; indice: number };

/** Ler a lista de novo por endereço vencido: no máximo uma vez a cada 20 segundos (a imagem que falha não vira laço). */
const ESPERA_DA_RELEITURA_MS = 20_000;

export function FotosTela() {
  const { pode } = useSessao();
  const avisar = useAvisar();
  const podeVer = pode('fotos.ver');
  const titulo = useRef<HTMLHeadingElement>(null);
  const tituloDaFila = useRef<HTMLHeadingElement>(null);
  const seletor = useRef<HTMLInputElement>(null);
  const grade = useRef<HTMLUListElement>(null);
  const [marcas, setMarcas] = useState<BrandResponse[] | null>(null);
  const [erroMarcas, setErroMarcas] = useState<Problema | null>(null);
  const [marca, setMarca] = useState<string | null>(null);
  const [carga, setCarga] = useState<Carga>({ tipo: 'carregando' });
  const [tentativa, setTentativa] = useState(0);
  const [filtro, setFiltro] = useState('todas');
  const [fila, setFila] = useState<ItemDoEnvio[]>([]);
  const [aberta, setAberta] = useState<string | null>(null);
  const [apagar, setApagar] = useState<string | null>(null);
  const [arrastando, setArrastando] = useState(false);
  const [anuncio, setAnuncio] = useState('');
  const agora = useAgora(60_000, carga);
  const secao = useRef<HTMLElement>(null);
  const seq = useRef(0);
  const seqDoArquivo = useRef(0);
  const focar = useRef<Foco | null>(null);
  const relida = useRef(0);
  // O envio: a lista espelhada num ref (o envio que termina lê a lista de agora), os arquivos por item, os hashes do que
  // já foi (a mesma foto não vai duas vezes) e quantos envios estão no ar.
  const filaRef = useRef<ItemDoEnvio[]>([]);
  const arquivos = useRef(new Map<string, { arquivo: File; hash: string | null; deNovo: boolean }>());
  const hashes = useRef(new Set<string>());
  const noAr = useRef(0);
  const montada = useRef(true);
  const marcaDoEnvio = useRef<string | null>(null);

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
    montada.current = true;
    return () => {
      montada.current = false;
    };
  }, []);

  useEffect(() => {
    if (!marca) return;
    const id = ++seq.current;
    setCarga({ tipo: 'carregando' });
    setAberta(null);
    setApagar(null);
    setFiltro('todas');
    disparar(
      chamar(() => api.GET('/v1/brand-photos', { params: { query: { brand_id: marca } } })).then((r) => {
        if (id !== seq.current) return;
        setCarga(r.ok ? { tipo: 'ok', dados: r.data } : { tipo: 'erro', problema: r.problema });
      }),
    );
  }, [marca, tentativa]);

  /** Lê a lista de novo sem tirar a tela do lugar (endereços novos, produtos novos, a foto que outra pessoa apagou). */
  const reler = useCallback(async () => {
    if (!marca) return;
    relida.current = Date.now();
    const id = ++seq.current;
    const r = await chamar(() => api.GET('/v1/brand-photos', { params: { query: { brand_id: marca } } }));
    if (id !== seq.current) return;
    if (r.ok) setCarga({ tipo: 'ok', dados: r.data });
  }, [marca]);

  const relerPorEndereco = useCallback(() => {
    if (Date.now() - relida.current < ESPERA_DA_RELEITURA_MS) return;
    disparar(reler());
  }, [reler]);

  // O foco depois de uma ação: o título, a lista do envio ou a foto vizinha da que foi apagada.
  useEffect(() => {
    const alvo = focar.current;
    if (!alvo) return;
    focar.current = null;
    let el: HTMLElement | null = null;
    if (alvo.tipo === 'fila') el = tituloDaFila.current;
    else if (alvo.tipo === 'foto') {
      const cartoes = grade.current?.querySelectorAll<HTMLElement>('[data-ft-foto]') ?? [];
      el = cartoes[Math.min(alvo.indice, cartoes.length - 1)] ?? document.querySelector<HTMLElement>('[data-ft-enviar]');
    }
    el ??= titulo.current;
    el?.focus({ preventScroll: alvo.tipo !== 'foto' });
    if (document.activeElement !== el) titulo.current?.focus({ preventScroll: true });
  });

  // A foto aberta saiu da lista (outra pessoa apagou, e a lista foi lida de novo): a gaveta fecha e diz por quê.
  const sumiu = aberta !== null && carga.tipo === 'ok' && !carga.dados.items.some((f) => f.id === aberta);
  useEffect(() => {
    if (!sumiu) return;
    setAberta(null);
    setApagar(null);
    focar.current = { tipo: 'titulo' };
    avisar('Esta foto não está mais aqui.', { tipo: 'perigo' });
  }, [sumiu, avisar]);

  // Sair da página com envio no meio: o navegador pergunta antes (a foto que ainda não subiu se perde).
  const enviando = fila.some((i) => !terminou(i.fase));
  useEffect(() => {
    if (!enviando) return;
    const segurar = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', segurar);
    return () => window.removeEventListener('beforeunload', segurar);
  }, [enviando]);

  // O fim do envio é anunciado uma vez.
  const anunciado = useRef(false);
  useEffect(() => {
    if (!fila.length) return;
    if (!fila.every((i) => terminou(i.fase))) {
      anunciado.current = false;
      return;
    }
    if (anunciado.current) return;
    anunciado.current = true;
    setAnuncio(resumoDoEnvio(fila.map((i) => i.fase)));
  }, [fila]);

  // As prévias (endereços `blob:`) saem com a tela.
  useEffect(
    () => () => {
      for (const i of filaRef.current) if (i.previa) URL.revokeObjectURL(i.previa);
    },
    [],
  );

  const mudarFila = useCallback((fn: (lista: ItemDoEnvio[]) => ItemDoEnvio[]) => {
    filaRef.current = fn(filaRef.current);
    setFila(filaRef.current);
  }, []);
  const mudarItem = useCallback((id: string, campos: Partial<ItemDoEnvio>) => mudarFila((l) => l.map((i) => (i.id === id ? { ...i, ...campos } : i))), [mudarFila]);

  const entrou = useCallback((foto: BrandPhoto) => {
    setCarga((c) => (c.tipo === 'ok' && c.dados.brand_id === foto.brand_id ? { ...c, dados: { ...c.dados, items: [foto, ...c.dados.items.filter((f) => f.id !== foto.id)] } } : c));
  }, []);

  /** Um arquivo da lista: confere as medidas e a repetida, envia e diz o que aconteceu. */
  const enviarUm = useCallback(
    async (id: string) => {
      const guardado = arquivos.current.get(id);
      const item = filaRef.current.find((i) => i.id === id);
      const destino = marcaDoEnvio.current;
      if (!guardado || !item || !destino) return;
      mudarItem(id, { fase: 'enviando', pct: 0, falha: undefined });
      const { largura, altura } = item.previa ? await medirImagem(item.previa) : { largura: 0, altura: 0 };
      const medida = conferirMedidas(largura, altura);
      if (medida) {
        arquivos.current.delete(id);
        return mudarItem(id, { fase: 'recusada', recusa: medida });
      }
      guardado.hash ??= await hashDoArquivo(guardado.arquivo);
      if (guardado.hash && hashes.current.has(guardado.hash)) {
        arquivos.current.delete(id);
        return mudarItem(id, { fase: 'recusada', recusa: 'repetida' });
      }
      if (guardado.hash) hashes.current.add(guardado.hash);
      const r = await enviarFoto(destino, guardado.arquivo, (pct) => mudarItem(id, pct >= 100 ? { fase: 'conferindo', pct: 100 } : { fase: 'enviando', pct }));
      if (r.ok) {
        arquivos.current.delete(id);
        mudarItem(id, { fase: r.data.narrow_for_instagram ? 'aviso' : 'ok', pct: 100 });
        entrou(r.data);
        return;
      }
      const recusa = recusaDoCodigo(r.problema.code);
      if (recusa === 'repetida' && guardado.deNovo) {
        // A tentativa que "caiu" chegou ao servidor antes: a foto entrou. A lista é lida de novo para mostrá-la.
        arquivos.current.delete(id);
        mudarItem(id, { fase: 'ok', pct: 100 });
        disparar(reler());
        return;
      }
      if (recusa) {
        arquivos.current.delete(id);
        if (recusa !== 'repetida' && guardado.hash) hashes.current.delete(guardado.hash);
        mudarItem(id, { fase: 'recusada', recusa });
        if (recusa === 'desligada') disparar(reler());
        return;
      }
      if (guardado.hash) hashes.current.delete(guardado.hash);
      mudarItem(id, { fase: 'falhou', falha: r.problema.status === 0 ? FALHA_DE_CONEXAO : `Não foi: ${mensagemDe(r.problema)}` });
    },
    [entrou, mudarItem, reler],
  );

  /** Põe no ar os próximos da lista, dois por vez (o servidor regrava duas fotos por vez). */
  const andar = useCallback(() => {
    while (montada.current && noAr.current < ENVIOS_JUNTOS) {
      const proximo = filaRef.current.find((i) => i.fase === 'na_fila');
      if (!proximo) return;
      noAr.current += 1;
      mudarItem(proximo.id, { fase: 'enviando', pct: 0 });
      disparar(
        enviarUm(proximo.id).finally(() => {
          noAr.current -= 1;
          andar();
        }),
      );
    }
  }, [enviarUm, mudarItem]);

  const dados = carga.tipo === 'ok' ? carga.dados : null;
  const podeEnviar = Boolean(dados?.enabled && dados.can_manage);

  const receber = useCallback(
    (lista: File[]) => {
      if (!podeEnviar || !marca || !lista.length) return;
      marcaDoEnvio.current = marca;
      const sobra = Math.max(0, lista.length - POR_VEZ);
      if (sobra) avisar(foraDoLote(sobra));
      const novos: ItemDoEnvio[] = lista.slice(0, POR_VEZ).map((arquivo) => {
        const id = `e${++seqDoArquivo.current}`;
        const recusa = conferirArquivo(arquivo);
        if (recusa) return { id, nome: arquivo.name, fase: 'recusada', recusa, pct: 0, previa: null };
        arquivos.current.set(id, { arquivo, hash: null, deNovo: false });
        return { id, nome: arquivo.name, fase: 'na_fila', pct: 0, previa: URL.createObjectURL(arquivo) };
      });
      mudarFila((l) => {
        for (const i of l) if (terminou(i.fase) && i.previa) URL.revokeObjectURL(i.previa);
        return [...l.filter((i) => !terminou(i.fase)), ...novos];
      });
      andar();
    },
    [andar, avisar, marca, mudarFila, podeEnviar],
  );

  function tentarDeNovo(id: string) {
    const guardado = arquivos.current.get(id);
    if (!guardado) return;
    guardado.deNovo = true;
    focar.current = { tipo: 'fila' };
    mudarItem(id, { fase: 'na_fila', pct: 0, falha: undefined });
    andar();
  }

  function fecharFila() {
    for (const i of filaRef.current) if (i.previa) URL.revokeObjectURL(i.previa);
    mudarFila(() => []);
    focar.current = { tipo: 'titulo' };
  }

  // Arrastar: a tela inteira recebe; fora dela, o arquivo solto não abre no navegador (a pessoa perderia a tela).
  useEffect(() => {
    const segurar = (e: globalThis.DragEvent) => {
      if (![...(e.dataTransfer?.types ?? [])].includes('Files')) return;
      e.preventDefault();
      if (e.dataTransfer && !(e.target instanceof Node && secao.current?.contains(e.target))) e.dataTransfer.dropEffect = 'none';
    };
    document.addEventListener('dragover', segurar);
    document.addEventListener('drop', segurar);
    return () => {
      document.removeEventListener('dragover', segurar);
      document.removeEventListener('drop', segurar);
    };
  }, []);
  const comArquivos = (e: DragEvent) => [...e.dataTransfer.types].includes('Files');

  if (!podeVer) {
    return (
      <Estado icone="lock" titulo="Esta tela é de quem cuida da marca">
        O seu nível nesta empresa não mostra as fotos dos produtos. Se precisar, peça ao dono da conta.
      </Estado>
    );
  }

  const fotos = dados?.items ?? [];
  const tem = fotos.length > 0;
  const nomeDaMarca = marcas?.find((m) => m.id === marca)?.name ?? 'sua marca';
  const lista = grupos(fotos, dados?.products ?? []);
  const filtroValido = filtro === 'todas' || lista.includes(filtro) ? filtro : 'todas';
  const vistas = visiveis(fotos, filtroValido);
  const c = contagens(fotos);
  const fotoAberta = aberta ? (fotos.find((f) => f.id === aberta) ?? null) : null;

  function abrir(id: string) {
    const f = fotos.find((x) => x.id === id);
    if (!f) return;
    // Os endereços valem 5 minutos: perto do fim, a lista é lida de novo (a gaveta passa a mostrar os novos).
    if (enderecosVencendo(f.urls_expire_at, new Date())) disparar(reler());
    setAberta(id);
  }

  let corpo;
  if (erroMarcas || carga.tipo === 'erro') {
    const problema = erroMarcas ?? (carga.tipo === 'erro' ? carga.problema : null);
    corpo = (
      <Faixa
        tipo="perigo"
        icone={<Icone nome="alert-circle" />}
        titulo="Não deu para carregar as fotos"
        texto={`${problema ? mensagemDe(problema) : 'Tente de novo em instantes.'} As fotos continuam guardadas.`}
        acao={
          <button
            className="btn btn--sm"
            type="button"
            onClick={() => {
              focar.current = { tipo: 'titulo' };
              if (erroMarcas) disparar(carregarMarcas());
              else setTentativa((t) => t + 1);
            }}
          >
            <Icone nome="refresh" pequeno />
            Tentar de novo
          </button>
        }
      />
    );
  } else if (marcas && !marcas.length) {
    corpo = (
      <div className="card">
        <Estado icone="info" titulo="Nenhuma marca ativa nesta empresa">
          As fotos são por marca: quando a empresa tiver uma marca ativa, elas aparecem aqui.
        </Estado>
      </div>
    );
  } else if (!dados) {
    corpo = (
      <div aria-busy="true">
        <p className="sr-only">Carregando as fotos</p>
        <div className="ft-esq" aria-hidden="true">
          {Array.from({ length: 8 }, (_, i) => (
            <span className="esqueleto" key={i} />
          ))}
        </div>
      </div>
    );
  } else if (!dados.enabled) {
    corpo = (
      <div className="card">
        <Estado icone="camera" titulo="As fotos ainda não estão ligadas para esta empresa">
          Quem liga é a Liame, a pedido do dono. Com a função desligada, nenhuma foto é enviada nem guardada.
        </Estado>
      </div>
    );
  } else {
    corpo = (
      <>
        {!dados.can_manage && (
          <Faixa icone={<Icone nome="lock" />} titulo="Você vê as fotos, mas só o Dono, o Administrador e o Gestor enviam e apagam" texto="Se faltar a foto de um produto, peça a um deles." />
        )}
        <FilaDoEnvio itens={fila} tituloRef={tituloDaFila} aoTentarDeNovo={tentarDeNovo} aoFechar={fecharFila} />
        {!tem ? (
          <div className="ft-vazio">
            <span className="ft-vazio-ic" aria-hidden="true">
              <Icone nome="image" />
            </span>
            <h2>Nenhuma foto ainda</h2>
            {dados.can_manage ? (
              <>
                <p>Envie as fotos de verdade dos seus produtos. Dá para arrastar para cá.</p>
                <p className="ft-info">{INFO_DO_ENVIO}</p>
                <button className="btn btn--primary" type="button" data-ft-enviar="vazio" onClick={() => seletor.current?.click()}>
                  <Icone nome="upload" />
                  Enviar fotos
                </button>
              </>
            ) : (
              <p>Quando alguém da equipe enviar as fotos dos produtos, elas aparecem aqui.</p>
            )}
          </div>
        ) : (
          <>
            {lista.length > 1 && (
              <div className="filtros" role="group" aria-label="Filtrar por produto">
                {[['todas', 'Todas'] as const, ...lista.map((g) => [g, nomeDoProduto(g || null)] as const)].map(([v, rotulo]) => (
                  <button
                    key={v || 'sem-produto'}
                    className="chip"
                    type="button"
                    aria-pressed={filtroValido === v}
                    onClick={() => {
                      setFiltro(v);
                      const n = visiveis(fotos, v).length;
                      setAnuncio(`${n} ${n === 1 ? 'foto' : 'fotos'}`);
                    }}
                  >
                    {rotulo} <span className="num">{c.get(v) ?? 0}</span>
                  </button>
                ))}
              </div>
            )}
            <h2 className="sr-only" id="ft-grade-t">
              {vistas.length} {vistas.length === 1 ? 'foto' : 'fotos'}
            </h2>
            <ul className="ft-grade" aria-labelledby="ft-grade-t" ref={grade}>
              {vistas.map((f) => (
                <CartaoFoto key={f.id} foto={f} agora={agora} aberta={aberta === f.id} aoAbrir={() => abrir(f.id)} aoFalhar={relerPorEndereco} />
              ))}
            </ul>
          </>
        )}
      </>
    );
  }

  return (
    <>
      <section
        ref={secao}
        className="ft-tela"
        aria-labelledby="h-fotos"
        onDragEnter={(e) => {
          if (!comArquivos(e)) return;
          e.preventDefault();
          if (podeEnviar) setArrastando(true);
        }}
        onDragOver={(e) => {
          if (!comArquivos(e)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = podeEnviar ? 'copy' : 'none';
        }}
        onDragLeave={(e) => {
          if (!(e.relatedTarget instanceof Node) || !e.currentTarget.contains(e.relatedTarget)) setArrastando(false);
        }}
        onDrop={(e) => {
          if (!comArquivos(e)) return;
          e.preventDefault();
          setArrastando(false);
          if (podeEnviar) receber([...e.dataTransfer.files]);
        }}
      >
        <div className="view-cab anima" style={{ ['--i' as string]: 0 }}>
          <div>
            <h1 id="h-fotos" ref={titulo} tabIndex={-1}>
              Fotos
            </h1>
            <p>As fotos de verdade dos produtos da {nomeDaMarca}, como são. Os posts usam só estas fotos.</p>
            {podeEnviar && tem && <p className="ft-info">{INFO_DO_ENVIO}</p>}
          </div>
          <div className="cab-acoes">
            {marcas && marcas.length > 1 && (
              <label className="res-campo">
                <span>Marca</span>
                <select className="input" value={marca ?? ''} onChange={(e) => setMarca(e.target.value)} disabled={enviando}>
                  {marcas.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {podeEnviar && tem && (
              <button className="btn btn--primary" type="button" data-ft-enviar="cab" onClick={() => seletor.current?.click()}>
                <Icone nome="upload" />
                Enviar fotos
              </button>
            )}
          </div>
        </div>
        <input
          ref={seletor}
          type="file"
          accept={ACEITA}
          multiple
          hidden
          onChange={(e) => {
            const escolhidos = [...(e.currentTarget.files ?? [])];
            e.currentTarget.value = '';
            receber(escolhidos);
          }}
        />
        {corpo}
        {arrastando && (
          <div className="ft-arraste" aria-hidden="true">
            <span className="ft-arraste-ic">
              <Icone nome="upload" />
            </span>
            <b>Solte as fotos para enviar</b>
            <span>JPEG, PNG ou WebP, até 10 MB.</span>
          </div>
        )}
        <p className="sr-only" role="status" aria-live="polite">
          {anuncio}
        </p>
      </section>
      {/* Os diálogos ficam fora da seção (arrastar arquivo sobre eles não envia) e com chaves de tipos diferentes: a
          gaveta e a confirmação são da mesma foto, e a mesma chave nas duas fazia o React trocar uma pela outra (ERR-154). */}
      {dados && fotoAberta && (
        <GavetaFoto
          key={`gaveta-${fotoAberta.id}`}
          foto={fotoAberta}
          produtos={dados.products}
          podeMudar={dados.can_manage}
          apagando={apagar === fotoAberta.id}
          agora={agora}
          reserva={titulo}
          aoSalvar={(nova, mudou) => {
            if (mudou) setCarga((cg) => (cg.tipo === 'ok' ? { ...cg, dados: { ...cg.dados, items: cg.dados.items.map((f) => (f.id === nova.id ? nova : f)) } } : cg));
            avisar(mudou ? 'Foto salva.' : 'Nada mudou.');
          }}
          aoPedirApagar={() => setApagar(fotoAberta.id)}
          aoMudarLa={(p) => {
            setAberta(null);
            avisar(p.code === 'funcao-desligada' ? 'As fotos não estão mais ligadas para esta empresa.' : 'Esta foto não está mais aqui.', { tipo: 'perigo' });
            focar.current = { tipo: 'titulo' };
            disparar(reler());
          }}
          aoProdutosMudarem={() => disparar(reler())}
          aoFalharImagem={relerPorEndereco}
          aoFechar={() => setAberta((a) => (a === fotoAberta.id ? null : a))}
        />
      )}
      {apagar && (
        <DialogoApagarFoto
          key={`apagar-${apagar}`}
          id={apagar}
          aoApagar={(jaTinhaSaido) => {
            const indice = vistas.findIndex((f) => f.id === apagar);
            setCarga((cg) => (cg.tipo === 'ok' ? { ...cg, dados: { ...cg.dados, items: cg.dados.items.filter((f) => f.id !== apagar) } } : cg));
            setApagar(null);
            setAberta(null);
            focar.current = { tipo: 'foto', indice: Math.max(indice, 0) };
            avisar(jaTinhaSaido ? 'Esta foto já não estava mais aqui.' : 'Foto apagada.');
          }}
          aoFechar={() => setApagar(null)}
        />
      )}
    </>
  );
}
