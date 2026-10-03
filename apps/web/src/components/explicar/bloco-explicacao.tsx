'use client';

import type { ExplanationResponse, ExplanationSegment } from '@liame/contracts';
import Link from 'next/link';
import { Fragment, type ReactNode, useEffect, useRef, useState } from 'react';
import { IconeLia } from '@/components/marca/logo';
import { Icone } from '@/components/ui/icone';
import { mensagemDe } from '@/lib/api';
import { quandoComHora } from '@/lib/formato';
import { Retorno } from './retorno';
import { avisoSemIa, ehDaLia, seloDoRisco, tituloDasFontes } from './textos';
import type { EstadoDaExplicacao } from './use-explicacao';

// O bloco da explicação (mockups/prototipo-explicar.html, P4): fica logo abaixo do que ele explica (o número
// principal dos Resultados ou um aviso da Atenção). O texto vem pronto da API, em trechos: cada número é um
// botão que abre "De onde vêm os números" na linha dele. A LIA aparece em violeta, com "Feito com IA"; o
// resumo do sistema, em cinza, com "Sem IA" e o motivo. Quem decide é a pessoa: as ações são de navegação.

type Props = {
  /** Identifica o bloco na tela (ids e rótulos): `resultados` ou `aviso-…`. */
  id: string;
  estado: Exclude<EstadoDaExplicacao, { tipo: 'fechada' }>;
  /** A LIA responde para esta empresa? Decide o texto enquanto carrega. */
  lia: boolean;
  /** O que está sendo explicado: os números da tela ou os de um aviso. */
  sobre: 'tela' | 'aviso';
  /** Nível do título do bloco (2 em Resultados; 3 dentro de um aviso, cujo título é o 2). */
  nivel?: 2 | 3;
  /** Dentro de um aviso o bloco não é um cartão: sem moldura dupla. */
  solto?: boolean;
  /** Até duas ações de navegação (nada muda em campanha por aqui). */
  acoes?: ReactNode;
  podeVerContas: boolean;
  aoFechar: () => void;
  aoPedirDeNovo: () => void;
  /** Só no aviso: recarrega a lista quando o aviso explicado saiu dela (pedir de novo não resolveria). */
  aoAtualizar?: () => void;
};

/** O código que a API manda quando o aviso explicado não está mais ativo. */
const AVISO_SUMIU = 'aviso-nao-encontrado';

const SOBRE = { tela: 'com os números desta tela', aviso: 'com os números deste aviso' } as const;

function semMovimento(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function BlocoExplicacao({ id, estado, lia, sobre, nivel = 2, solto = false, acoes, podeVerContas, aoFechar, aoPedirDeNovo, aoAtualizar }: Props) {
  const Bloco = solto ? 'div' : 'article';
  const Titulo = nivel === 2 ? 'h2' : 'h3';
  const caixa = useRef<HTMLElement | null>(null);
  // O bloco é um <article> na tela e um <div> dentro do aviso: a referência serve aos dois.
  const guardarCaixa = (el: HTMLElement | null) => {
    caixa.current = el;
  };
  const titulo = useRef<HTMLHeadingElement>(null);
  const resposta = estado.tipo === 'pronta' ? estado.resposta : null;
  const daLia = resposta ? ehDaLia(resposta) : lia;

  // A cada passo (lendo, pronta, falhou) o bloco entra na vista e o título recebe o foco: quem ouve a
  // tela acompanha sem procurar.
  useEffect(() => {
    caixa.current?.scrollIntoView({ block: 'nearest', behavior: semMovimento() ? 'auto' : 'smooth' });
    titulo.current?.focus({ preventScroll: true });
  }, [estado.tipo]);

  const fechar = (
    <button className="btn btn--icon btn--sm btn--ghost" type="button" onClick={aoFechar} aria-label="Fechar a explicação">
      <Icone nome="x" />
    </button>
  );
  const cabecalho = (texto: string, etiqueta: ReactNode, meta: string, comLia: boolean) => (
    <div className="explica-cab">
      {comLia ? (
        <IconeLia />
      ) : (
        <span className="av-sistema" aria-hidden="true">
          <Icone nome="file" />
        </span>
      )}
      <div className="explica-quem">
        <Titulo id={`exp-t-${id}`} ref={titulo} tabIndex={-1}>
          {texto}
        </Titulo>
        <p>
          {etiqueta}
          <span>{meta}</span>
        </p>
      </div>
      {fechar}
    </div>
  );
  const feitoComIa = (
    <span className="st st--ia">
      <Icone nome="sparkles" />
      Feito com IA
    </span>
  );
  const semIa = <span className="st st--espera">Sem IA</span>;
  const classe = `${solto ? 'explica' : 'card explica'}${daLia ? '' : ' explica--sistema'}`;

  if (estado.tipo === 'carregando') {
    return (
      <Bloco className={classe} id={`exp-${id}`} ref={guardarCaixa} aria-labelledby={`exp-t-${id}`} aria-busy="true">
        {lia ? cabecalho('A LIA está lendo os números…', feitoComIa, 'leva alguns segundos', true) : cabecalho('Montando o resumo do sistema…', semIa, `por regra, ${SOBRE[sobre]}`, false)}
        <div className="explica-esq" aria-hidden="true">
          <span className="esqueleto esqueleto--medio" />
          <span className="esqueleto" />
          <span className="esqueleto" />
          <span className="esqueleto esqueleto--curto" />
        </div>
        {lia && <p className="explica-nota">A LIA recebe só os números {sobre === 'tela' ? 'desta tela' : 'deste aviso'}, já calculados pelo sistema, sem dado pessoal de cliente.</p>}
      </Bloco>
    );
  }

  if (estado.tipo === 'erro') {
    // O aviso saiu da lista com a tela aberta: pedir de novo daria o mesmo; o que resolve é atualizar os avisos.
    const sumiu = estado.problema.code === AVISO_SUMIU && aoAtualizar !== undefined;
    return (
      <Bloco className={`${solto ? 'explica' : 'card explica'} explica--sistema`} id={`exp-${id}`} ref={guardarCaixa} aria-labelledby={`exp-t-${id}`}>
        {sumiu ? cabecalho(estado.problema.title, null, 'a lista mudou com a tela aberta', false) : cabecalho('Não deu para montar a explicação', null, 'nada foi perdido', false)}
        <div className="explica-aviso explica-aviso--neutro" role="alert">
          <Icone nome="alert-circle" />
          <div className="explica-aviso-txt">{mensagemDe(estado.problema)}</div>
          <button className="btn btn--sm" type="button" onClick={sumiu ? aoAtualizar : aoPedirDeNovo}>
            <Icone nome="refresh" pequeno />
            {sumiu ? 'Atualizar os avisos' : 'Tentar de novo'}
          </button>
        </div>
      </Bloco>
    );
  }

  return (
    <Bloco className={classe} id={`exp-${id}`} ref={guardarCaixa} aria-labelledby={`exp-t-${id}`}>
      {daLia
        ? cabecalho('Explicação da LIA', feitoComIa, `${SOBRE[sobre]} · ${quandoComHora(estado.resposta.generated_at)}`, true)
        : cabecalho('Resumo do sistema', semIa, `montado por regra, ${SOBRE[sobre]}`, false)}
      <Conteudo id={id} resposta={estado.resposta} nivel={nivel} acoes={acoes} podeVerContas={podeVerContas} aoPedirDeNovo={aoPedirDeNovo} />
    </Bloco>
  );
}

/** O corpo da explicação pronta: o aviso de "sem IA", o texto, as fontes dos números e o rodapé. */
function Conteudo({ id, resposta, nivel, acoes, podeVerContas, aoPedirDeNovo }: { id: string; resposta: ExplanationResponse; nivel: 2 | 3; acoes: ReactNode; podeVerContas: boolean; aoPedirDeNovo: () => void }) {
  const Secao = nivel === 2 ? 'h3' : 'h4';
  const [fontesAbertas, setFontesAbertas] = useState(false);
  const [destaque, setDestaque] = useState<number | null>(null);
  const [anuncio, setAnuncio] = useState('');
  const linhas = useRef<Array<HTMLDivElement | null>>([]);
  const e = resposta.explanation;
  const daLia = ehDaLia(resposta);
  const aviso = avisoSemIa(resposta);
  const selo = seloDoRisco(e.risk);

  // Tocar num número abre a lista na linha dele (e diz a fonte para quem ouve a tela).
  function mostrarFonte(n: number) {
    const numero = resposta.numbers[n];
    if (!numero) return;
    setFontesAbertas(true);
    setDestaque(n);
    setAnuncio(`${numero.value}: ${numero.sources.join('; ')}`);
    // A lista abre neste mesmo desenho: a linha só existe na tela no quadro seguinte.
    requestAnimationFrame(() => linhas.current[n]?.scrollIntoView({ block: 'nearest', behavior: semMovimento() ? 'auto' : 'smooth' }));
  }
  const texto = (trechos: ExplanationSegment[]) => <TextoDaExplicacao trechos={trechos} numeros={resposta.numbers} aoTocar={mostrarFonte} />;

  return (
    <>
      {aviso && (
        <div className={aviso.tom === 'neutro' ? 'explica-aviso explica-aviso--neutro' : 'explica-aviso'} role="status">
          <Icone nome={aviso.icone} />
          <div className="explica-aviso-txt">
            <b>{aviso.titulo}</b>
            {aviso.texto}
          </div>
          {aviso.acao === 'de-novo' && (
            <button className="btn btn--sm" type="button" onClick={aoPedirDeNovo}>
              <Icone nome="refresh" pequeno />
              Tentar de novo com a LIA
            </button>
          )}
          {aviso.acao === 'ver-conexao' && podeVerContas && (
            <Link className="btn btn--sm" href="/contas">
              Ver a conexão
            </Link>
          )}
        </div>
      )}

      <div className="explica-corpo">
        <p className="explica-texto">{texto(e.what_happened)}</p>
        <div className="explica-sec">
          <Secao>Motivos</Secao>
          <ul className="explica-lista">
            {e.reasons.map((m, i) => (
              <li key={i}>{texto(m)}</li>
            ))}
          </ul>
        </div>
        <p className="explica-risco">
          <span className={`st ${selo.classe}`}>
            <span className="dot" aria-hidden="true" />
            {selo.rotulo}
          </span>
          <span>{texto(e.risk_reason)}</span>
        </p>
        <div className="explica-sec">
          <Secao>O que fazer</Secao>
          <ul className="explica-lista explica-lista--fazer">
            {e.what_to_do.map((m, i) => (
              <li key={i}>{texto(m)}</li>
            ))}
          </ul>
        </div>
        {acoes && <div className="explica-acoes">{acoes}</div>}
      </div>

      {resposta.numbers.length > 0 && (
        <details className="fontes-num" open={fontesAbertas} onToggle={(ev) => setFontesAbertas(ev.currentTarget.open)}>
          <summary>
            <Icone nome="chevron-down" pequeno />
            {tituloDasFontes(resposta.numbers.length)}
          </summary>
          <dl>
            {resposta.numbers.map((n, i) => (
              <div
                key={i}
                className={destaque === i ? 'destaque' : undefined}
                ref={(el) => {
                  linhas.current[i] = el;
                }}
              >
                <dt>{n.value}</dt>
                {n.sources.map((fonte) => (
                  <dd key={fonte}>{fonte}</dd>
                ))}
              </div>
            ))}
          </dl>
        </details>
      )}
      <p className="sr-only" role="status" aria-live="polite">
        {anuncio}
      </p>

      {daLia && resposta.usage_id ? (
        <Retorno id={id} usageId={resposta.usage_id} />
      ) : (
        <div className="explica-rodape">
          <p className="explica-nota">Resumo montado pelo sistema, por regra, com os mesmos números. Nenhuma IA escreveu este texto.</p>
        </div>
      )}
    </>
  );
}

/** O texto em trechos: o comum como está; cada número, um botão que leva à fonte dele. */
export function TextoDaExplicacao({ trechos, numeros, aoTocar }: { trechos: ExplanationSegment[]; numeros: ExplanationResponse['numbers']; aoTocar: (n: number) => void }) {
  return (
    <>
      {trechos.map((t, i) => {
        const fontes = t.number === null ? null : numeros[t.number]?.sources;
        // Número sem linha na lista (não deveria acontecer) fica como texto: nada de botão que não leva a lugar nenhum.
        if (t.number === null || !fontes) return <Fragment key={i}>{t.text}</Fragment>;
        const n = t.number;
        return (
          <button key={i} type="button" className="nf" title={fontes[0]} onClick={() => aoTocar(n)}>
            {t.text}
            <span className="sr-only">, fonte: {fontes.join('; ')}</span>
          </button>
        );
      })}
    </>
  );
}
