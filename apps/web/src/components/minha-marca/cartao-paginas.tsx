'use client';

import type { BrandDossierSuggestion, DossierSection, ResearchListResponse, ResearchResponse } from '@liame/contracts';
import Link from 'next/link';
import { type RefObject, useId } from 'react';
import { Faixa } from '@/components/ui/faixa';
import { Icone } from '@/components/ui/icone';
import { acaoDaLeitura, avisoDoPesquisador, linhaDoLimite, quandoDaLeitura, situacaoDaLeitura, tipoDaPagina } from './pesquisador';
import { SECAO } from './textos';

// O cartão "Páginas lidas" (mockups/prototipo-pesquisador.html, P25 aprovado em 21/10/2026): os pedidos de leitura da
// marca, os mais novos primeiro (até 50, o que a rota devolve), cada um com a situação em palavra e o que resolve o
// caso. Pedir é de quem muda a marca (`dossie.editar`) e só quando a rota diz que dá (`availability`: a IA ligada e o
// Pesquisador ativo na marca).

type Props = {
  lista: ResearchListResponse | null;
  erro: string | null;
  sugestoes: readonly BrandDossierSuggestion[];
  podeEditar: boolean;
  /** Quem liga o Pesquisador de novo em Sua equipe (`agentes.gerenciar`, mais as permissões da tela da equipe). */
  podeLigar: boolean;
  agora: Date;
  /** A linha que acabou de entrar ou que já estava na fila (destaque curto). */
  destaque: string | null;
  /** O "Ler de novo" em andamento (o id do pedido). O botão não se desabilita, para não perder o foco (V82): a tela ignora o segundo clique. */
  relendo: string | null;
  tituloRef: RefObject<HTMLHeadingElement | null>;
  aoPedir: () => void;
  aoConferir: (sugestao: BrandDossierSuggestion) => void;
  aoLerDeNovo: (x: ResearchResponse) => void;
  aoOutroEndereco: (x: ResearchResponse) => void;
  aoPreencher: (secao: DossierSection) => void;
  aoRecarregar: () => void;
};

export function CartaoPaginas({ lista, erro, sugestoes, podeEditar, podeLigar, agora, destaque, relendo, tituloRef, aoPedir, aoConferir, aoLerDeNovo, aoOutroEndereco, aoPreencher, aoRecarregar }: Props) {
  const ids = useId();
  const podePedir = podeEditar && lista?.availability.status === 'disponivel';

  const cabecalho = (
    <div className="card-cab">
      <div>
        <h2 id={`${ids}-t`} ref={tituloRef} tabIndex={-1}>
          Páginas lidas
        </h2>
        <p className="card-sub">O Pesquisador lê a página que você informa e sugere o que achar nela, para você conferir. A página não fica guardada.</p>
      </div>
      {podePedir && (
        <button className="btn btn--sm" type="button" onClick={aoPedir} aria-haspopup="dialog">
          <Icone nome="plus" pequeno />
          Ler uma página
        </button>
      )}
    </div>
  );

  if (erro) {
    return (
      <article className="card pq-card" aria-labelledby={`${ids}-t`}>
        {cabecalho}
        <div className="vazio vazio--compacto" role="alert">
          <span className="vazio-ic vazio-ic--perigo" aria-hidden="true">
            <Icone nome="alert-circle" />
          </span>
          <h3>Não foi possível carregar as páginas lidas</h3>
          <p>{erro} Nada foi perdido.</p>
          <div className="vazio-acoes">
            <button className="btn btn--primary" type="button" onClick={aoRecarregar}>
              <Icone nome="refresh" />
              Tentar de novo
            </button>
          </div>
        </div>
      </article>
    );
  }
  if (!lista) {
    return (
      <article className="card pq-card" aria-labelledby={`${ids}-t`} aria-busy="true">
        {cabecalho}
        <p className="sr-only">Carregando as páginas lidas…</p>
        <span className="esqueleto esqueleto--medio" aria-hidden="true" />
        <span className="esqueleto" aria-hidden="true" />
      </article>
    );
  }

  const aviso = avisoDoPesquisador(lista.availability.status, { podeEditar, podeLigar });
  const faixa = aviso ? (
    <Faixa
      icone={<Icone nome="info" />}
      titulo={aviso.titulo}
      texto={aviso.texto}
      acao={
        aviso.abrirEquipe ? (
          <Link className="btn btn--sm" href="/equipe">
            Abrir Sua equipe
          </Link>
        ) : undefined
      }
    />
  ) : !podeEditar ? (
    <Faixa icone={<Icone nome="lock" />} titulo="Você vê as páginas lidas, mas só o Dono e o Administrador pedem leituras" texto="A sugestão do Pesquisador também é conferida por um deles." />
  ) : null;

  if (!lista.items.length) {
    return (
      <article className="card pq-card" aria-labelledby={`${ids}-t`}>
        {cabecalho}
        {faixa && <div className="pq-faixa">{faixa}</div>}
        <div className="vazio vazio--compacto">
          <span className="vazio-ic" aria-hidden="true">
            <Icone nome="search" />
          </span>
          <h3>Nenhuma página lida ainda</h3>
          <p>Informe o site da marca, o cardápio online ou a página de um concorrente. O que servir vira sugestão aqui, para você conferir.</p>
          {podePedir && (
            <div className="vazio-acoes">
              <button className="btn btn--primary" type="button" onClick={aoPedir} aria-haspopup="dialog">
                <Icone nome="plus" pequeno />
                Ler uma página
              </button>
            </div>
          )}
        </div>
      </article>
    );
  }

  return (
    <article className="card pq-card" aria-labelledby={`${ids}-t`}>
      {cabecalho}
      {faixa && <div className="pq-faixa">{faixa}</div>}
      <ul className="pq-lista" aria-label="Páginas lidas, as mais novas primeiro">
        {lista.items.map((x) => {
          const tipo = tipoDaPagina(x.kind);
          const s = situacaoDaLeitura(x, sugestoes);
          const acao = acaoDaLeitura(x, sugestoes, podePedir, podeEditar);
          return (
            <li key={x.id} className={`pq-item${destaque === x.id ? ' pq-item--novo' : ''}`}>
              <span className="pq-ic" aria-hidden="true">
                <Icone nome={tipo.icone} />
              </span>
              <div className="pq-corpo">
                <p className="pq-tit">
                  <b>{x.host}</b>
                  <span className="pq-tipo">{tipo.rotulo}</span>
                </p>
                <p className="pq-url" title={x.url}>
                  {x.url}
                </p>
                <p className="pq-sit">
                  <span className={`st ${s.classe}`}>{s.rotulo}</span>
                  <span>{s.texto}</span>
                </p>
                <p className="pq-quem">{quandoDaLeitura(x, agora)}</p>
              </div>
              {acao && (
                <div className="pq-acoes">
                  {acao.tipo === 'conferir' && (
                    <button className="btn btn--sm btn--primary" type="button" onClick={() => aoConferir(acao.sugestao)} aria-haspopup="dialog">
                      <Icone nome="sparkles" pequeno />
                      Conferir a sugestão
                      <span className="sr-only"> de {x.host}</span>
                    </button>
                  )}
                  {acao.tipo === 'ler-de-novo' && (
                    <button className="btn btn--sm" type="button" onClick={() => aoLerDeNovo(x)} aria-busy={relendo === x.id}>
                      <Icone nome="refresh" pequeno />
                      {relendo === x.id ? 'Pedindo…' : 'Ler de novo'}
                      <span className="sr-only"> {x.host}</span>
                    </button>
                  )}
                  {acao.tipo === 'outro-endereco' && (
                    <button className="btn btn--sm" type="button" onClick={() => aoOutroEndereco(x)} aria-haspopup="dialog">
                      Ler outro endereço
                      <span className="sr-only"> no lugar de {x.host}</span>
                    </button>
                  )}
                  {acao.tipo === 'a-mao' && (
                    <button className="btn btn--sm" type="button" onClick={() => aoPreencher(acao.secao)} aria-haspopup="dialog">
                      Preencher {SECAO[acao.secao].titulo.toLocaleLowerCase('pt-BR')} à mão
                    </button>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      <div className="pq-rodape">
        {podePedir && <p className="pq-conta">{linhaDoLimite(lista.daily, agora)}</p>}
        <p className="eixo-nota">
          O Pesquisador é um assistente de IA: um modelo sem ferramenta nenhuma tira da página só produtos e preços, ofertas e diferenciais, e o código confere cada item contra o texto dela.
        </p>
      </div>
    </article>
  );
}
