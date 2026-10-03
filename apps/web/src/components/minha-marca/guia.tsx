'use client';

import type { BrandDossierContent, BrandDossierResponse, BrandDossierSuggestion, SystemProof } from '@liame/contracts';
import { useEffect, useRef, useState } from 'react';
import { useAvisar } from '@/components/ui/avisos';
import { Icone } from '@/components/ui/icone';
import { api, chamar, mensagemDe } from '@/lib/api';
import { disparar } from '@/lib/disparar';
import { CamposDaSecao } from './campos';
import { aplicarSugestao, copiar, parteVazia, partesQueMudaram, SECOES, textoDoItem } from './textos';

// Preenchimento guiado da marca (protótipo P6): um passo por parte, com a sugestão do sistema onde ele tem o que
// sugerir (produtos, pelas vendas; ofertas, pelos cupons das campanhas; sem IA). Nada fica guardado no navegador:
// "Confirmar e terminar" e "Sair e continuar depois" salvam o que foi preenchido como uma versão do dossiê.

type Props = {
  marca: { id: string; nome: string };
  /** A versão de partida (0 na primeira vez) e o conteúdo dela. */
  base: { versao: number; conteudo: BrandDossierContent };
  provas: SystemProof[];
  sugestoes: BrandDossierSuggestion[];
  /** Terminou os passos: o dossiê salvo (ou nulo, se nada foi preenchido). */
  aoTerminar: (dossie: BrandDossierResponse | null) => void;
  /** Saiu no meio: o dossiê salvo com o que já tinha (ou nulo, se nada mudou). */
  aoSair: (dossie: BrandDossierResponse | null) => void;
};

export function Guia({ marca, base, provas, sugestoes, aoTerminar, aoSair }: Props) {
  const avisar = useAvisar();
  const titulo = useRef<HTMLHeadingElement>(null);
  const campos = useRef<HTMLDivElement>(null);
  const [rascunho, setRascunho] = useState<BrandDossierContent>(() => copiar(base.conteudo));
  // Quem volta para continuar começa na primeira parte vazia; o que já tem conteúdo conta como feito.
  const [passo, setPasso] = useState(() => {
    const i = SECOES.findIndex((s) => s.id !== 'proibido' && parteVazia(s.id, base.conteudo, provas));
    return i < 0 ? 0 : i;
  });
  const [feitos, setFeitos] = useState<string[]>(() => SECOES.filter((s) => s.id !== 'proibido' && !parteVazia(s.id, base.conteudo, provas)).map((s) => s.id));
  const [usadas, setUsadas] = useState<string[]>([]);
  const [erro, setErro] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [anuncio, setAnuncio] = useState('');
  const s = SECOES[passo]!;
  const ultimo = passo === SECOES.length - 1;
  const sugestao = sugestoes.find((x) => x.section === s.id && !usadas.includes(x.id)) ?? null;
  const mudou = partesQueMudaram(base.conteudo, rascunho).length > 0;

  // A cada passo, o foco vai para o título dele.
  useEffect(() => {
    titulo.current?.focus({ preventScroll: true });
  }, [passo]);

  function ir(novo: number, { feito = false } = {}) {
    setErro('');
    if (feito && !feitos.includes(s.id) && !parteVazia(s.id, rascunho, provas)) setFeitos((f) => [...f, s.id]);
    const alvo = Math.max(0, Math.min(SECOES.length - 1, novo));
    setPasso(alvo);
    setAnuncio(`Passo ${alvo + 1} de ${SECOES.length}: ${SECOES[alvo]!.titulo}`);
  }

  /** Salva o que foi preenchido (se algo mudou) e devolve o dossiê novo; nulo sem mudança; `false` se falhou. */
  async function salvar(): Promise<BrandDossierResponse | null | false> {
    if (!mudou) return null;
    setErro('');
    setEnviando(true);
    const r = await chamar(() => api.PUT('/v1/brand-dossier', { body: { brand_id: marca.id, base_version: base.versao, content: rascunho } }));
    setEnviando(false);
    if (r.ok) return r.data;
    setErro(mensagemDe(r.problema));
    return false;
  }

  async function terminar() {
    const r = await salvar();
    if (r !== false) aoTerminar(r);
  }

  async function sair() {
    const r = await salvar();
    if (r === false) return;
    if (r) avisar(`O que você preencheu ficou salvo na versão ${r.version?.version ?? 1}. Dá para continuar depois.`);
    aoSair(r);
  }

  function usarSugestao() {
    if (!sugestao) return;
    setRascunho((c) =>
      aplicarSugestao(
        c,
        sugestao,
        sugestao.items.map((_, i) => i),
      ),
    );
    setUsadas((u) => [...u, sugestao.id]);
    setAnuncio('Sugestão usada. Confira e confirme.');
    campos.current?.querySelector<HTMLElement>('input, textarea, button')?.focus({ preventScroll: true });
  }

  return (
    <div className="mk-guia">
      <div className="mk-guia-cab">
        <div>
          <p className="rotulo-marca">Preencher passo a passo</p>
          <h2 tabIndex={-1} ref={titulo}>
            Passo {passo + 1} de {SECOES.length} · {s.titulo}
          </h2>
        </div>
        <button className="btn btn--sm btn--ghost" type="button" onClick={() => disparar(sair())} disabled={enviando}>
          Sair e continuar depois
        </button>
      </div>
      <div className="mk-barra" role="img" aria-label={`${feitos.length} de ${SECOES.length} passos feitos`}>
        <span style={{ width: `${Math.round((feitos.length / SECOES.length) * 100)}%` }} />
      </div>
      <div className="mk-guia-grade">
        <ol className="mk-passos" aria-label="Passos">
          {SECOES.map((x, i) => {
            const feito = feitos.includes(x.id);
            return (
              <li key={x.id} className={feito ? 'feito' : undefined} aria-current={i === passo ? 'step' : undefined}>
                {feito ? (
                  <Icone nome="check" pequeno />
                ) : (
                  <span className="num" aria-hidden="true">
                    {i + 1}
                  </span>
                )}
                <span className="rot">
                  {x.titulo}
                  {feito && <span className="sr-only">, feito</span>}
                </span>
              </li>
            );
          })}
        </ol>
        <article className="card mk-passo" aria-labelledby="mk-passo-t">
          {erro && (
            <p className="dialogo-erro" role="alert">
              <Icone nome="alert" pequeno />
              <span>{erro}</span>
            </p>
          )}
          <div>
            <h3 id="mk-passo-t">{s.pergunta(marca.nome)}</h3>
            <p className="mk-passo-ajuda">{s.ajuda}</p>
          </div>
          {sugestao && sugestao.items.some((i) => i.op === 'incluir') && (
            <div className="mk-sug">
              <p className="mk-sug-cab">
                <span className="av-func" aria-hidden="true">
                  <Icone nome="chart" />
                </span>
                <b>Sugestão do Liame</b>
                <span className="st st--espera">Sem IA</span>
              </p>
              <p>{s.id === 'ofertas' ? 'Os cupons ligados a campanhas no Liame:' : 'Pelas vendas do Regem nos últimos 30 dias:'}</p>
              <ul className="mk-pontos">
                {sugestao.items.map((item, i) => (
                  <li key={i}>
                    {item.op === 'incluir' ? item.text : textoDoItem(item)}
                    {item.why ? <small>{item.why}</small> : null}
                  </li>
                ))}
              </ul>
              <div className="mk-chips">
                <button className="btn btn--sm" type="button" onClick={usarSugestao}>
                  <Icone nome="check" pequeno />
                  Usar a sugestão
                </button>
              </div>
            </div>
          )}
          <div ref={campos}>
            <CamposDaSecao secao={s.id} conteudo={rascunho} mudar={setRascunho} provas={provas} marca={marca} anunciar={setAnuncio} />
          </div>
          <div className="mk-passo-acoes">
            {passo > 0 && (
              <button className="btn" type="button" onClick={() => ir(passo - 1)} disabled={enviando}>
                <Icone nome="chevron-left" pequeno />
                Voltar
              </button>
            )}
            <span className="spacer" />
            {!ultimo && (
              <button className="btn btn--ghost" type="button" onClick={() => ir(passo + 1)} disabled={enviando}>
                Pular por agora
              </button>
            )}
            {ultimo ? (
              <button className="btn btn--primary" type="button" onClick={() => disparar(terminar())} disabled={enviando}>
                {enviando ? 'Salvando…' : 'Confirmar e terminar'}
              </button>
            ) : (
              <button className="btn btn--primary" type="button" onClick={() => ir(passo + 1, { feito: true })} disabled={enviando}>
                Confirmar e seguir
              </button>
            )}
          </div>
        </article>
      </div>
      <p className="sr-only" role="status" aria-live="polite">
        {anuncio}
      </p>
    </div>
  );
}
