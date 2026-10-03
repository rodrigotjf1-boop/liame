import type { BrandDossierContent, DossierSection, SystemProof } from '@liame/contracts';
import type { ReactNode, Ref } from 'react';
import { Icone } from '@/components/ui/icone';
import { parteVazia, REGRAS_LIAME, SECAO } from './textos';

// Uma parte da marca na página (protótipo P6): o que está confirmado, a situação (confirmada, com sugestão para
// conferir ou vazia) e o que a pessoa pode fazer (quem não pode mudar só lê).

type Props = {
  secao: DossierSection;
  conteudo: BrandDossierContent;
  provas: SystemProof[];
  situacao: 'confirmada' | 'vazia' | 'sugestao';
  nomeDaMarca: string;
  acoes: ReactNode;
  tituloRef?: Ref<HTMLHeadingElement>;
};

export function CartaoSecao({ secao, conteudo, provas, situacao, nomeDaMarca, acoes, tituloRef }: Props) {
  const s = SECAO[secao];
  const classes = ['card', 'mk-secao', secao === 'proibido' ? 'mk-secao--largo' : '', situacao === 'sugestao' ? 'mk-secao--sugestao' : '', situacao === 'vazia' ? 'mk-secao--vazia' : ''].filter(Boolean).join(' ');
  return (
    <article className={classes} aria-labelledby={`mk-t-${secao}`}>
      <div className="mk-secao-cab">
        <span className="mk-ic" aria-hidden="true">
          <Icone nome={s.icone} />
        </span>
        <h2 id={`mk-t-${secao}`} tabIndex={-1} ref={tituloRef}>
          {s.titulo}
        </h2>
        {situacao === 'confirmada' ? (
          <span className="st st--concluido">
            <Icone nome="check" pequeno />
            Confirmada
          </span>
        ) : situacao === 'sugestao' ? (
          <span className="st st--ia">
            <Icone nome="sparkles" />
            Sugestão para conferir
          </span>
        ) : (
          <span className="st st--espera">Vazia</span>
        )}
      </div>
      <div className="mk-resumo">
        <ResumoDaParte secao={secao} conteudo={conteudo} provas={provas} nomeDaMarca={nomeDaMarca} />
      </div>
      {acoes && <div className="mk-secao-acoes">{acoes}</div>}
    </article>
  );
}

type Ponto = { texto: string; menor?: string };

function Pontos({ itens }: { itens: Ponto[] }) {
  return (
    <ul className="mk-pontos">
      {itens.map((p, i) => (
        <li key={`${i}-${p.texto}`}>
          {p.texto}
          {p.menor ? <small>{p.menor}</small> : null}
        </li>
      ))}
    </ul>
  );
}

/** O conteúdo de uma parte como a página mostra (também usado ao abrir uma versão antiga). */
export function ResumoDaParte({ secao, conteudo: c, provas, nomeDaMarca }: { secao: DossierSection; conteudo: BrandDossierContent; provas: SystemProof[]; nomeDaMarca: string }) {
  if (secao === 'proibido') {
    return (
      <div className="mk-regras">
        <div>
          <h3>Regras da Liame · valem para todas as marcas</h3>
          {REGRAS_LIAME.map((r) => (
            <p className="mk-regra" key={r.texto}>
              <Icone nome="lock" pequeno />
              <span>
                <b>{r.texto}</b>
                <small>{r.motivo}</small>
              </span>
            </p>
          ))}
        </div>
        <div>
          <h3>Regras da {nomeDaMarca}</h3>
          {c.forbidden.items.length ? (
            c.forbidden.items.map((r) => (
              <p className="mk-regra" key={r.text}>
                <Icone nome="ban" pequeno />
                <span>
                  <b>“{r.text}”</b>
                  {r.why ? <small>{r.why}</small> : null}
                </span>
              </p>
            ))
          ) : (
            <p className="mk-vazia-txt">Nenhuma regra própria ainda.</p>
          )}
        </div>
      </div>
    );
  }
  if (parteVazia(secao, c, provas)) return <p className="mk-vazia-txt">Ainda não preenchida. {SECAO[secao].vazia}</p>;
  switch (secao) {
    case 'identidade':
      return (
        <>
          {c.identity.summary && <p>{c.identity.summary}</p>}
          {c.identity.audience && (
            <p>
              <span className="rot">Para quem</span>
              {c.identity.audience}
            </p>
          )}
          {(c.identity.differentiator || c.identity.since) && (
            <p>
              <span className="rot">O que tem de diferente</span>
              {c.identity.differentiator}
              {c.identity.since ? `${c.identity.differentiator ? ' ' : ''}Desde ${c.identity.since}.` : ''}
            </p>
          )}
        </>
      );
    case 'voz':
      return (
        <>
          {c.voice.traits.length > 0 && (
            <ul className="mk-tags">
              {c.voice.traits.map((j) => (
                <li key={j}>{j}</li>
              ))}
            </ul>
          )}
          {c.voice.rules.length > 0 && <Pontos itens={c.voice.rules.map((texto) => ({ texto }))} />}
          {(c.voice.do_example || c.voice.dont_example) && (
            <div className="mk-exemplos">
              {c.voice.do_example && (
                <p className="mk-exemplo">
                  <span className="rot">Assim sim</span>
                  {c.voice.do_example}
                </p>
              )}
              {c.voice.dont_example && (
                <p className="mk-exemplo mk-exemplo--nao">
                  <span className="rot">Assim não</span>
                  {c.voice.dont_example}
                </p>
              )}
            </div>
          )}
        </>
      );
    case 'provas':
      return <Pontos itens={[...provas.map((p) => ({ texto: p.text, menor: p.source })), ...c.proof.stated.map((p) => ({ texto: p.text, menor: p.why }))]} />;
    case 'concorrentes':
      return <Pontos itens={c.competitors.items.map((p) => ({ texto: p.text, menor: p.why }))} />;
    case 'regiao':
      return (
        <>
          {c.region.area && <p>{c.region.area}</p>}
          {c.region.pickup && <p>Tem retirada no balcão.</p>}
        </>
      );
    case 'produtos':
      return <Pontos itens={c.products.items.map((texto) => ({ texto }))} />;
    case 'ofertas':
      return <Pontos itens={c.offers.items.map((texto) => ({ texto }))} />;
    case 'datas':
      return <Pontos itens={c.seasonality.items.map((texto) => ({ texto }))} />;
  }
}
