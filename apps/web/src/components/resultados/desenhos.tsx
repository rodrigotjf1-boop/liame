'use client';

import { useEffect, useRef } from 'react';
import type { BarraDividida as Barra, GraficoDosDias as Dias, LinhaDoPar, RetornoLite, SeloDoPeriodo } from './graficos';
import { TextoRico } from './pecas';

// Os desenhos do modo simples de Resultados (mockups/prototipo-resultados-graficos.html, aprovado em 07/10/2026).
// Regras: barra e posição, nunca pizza; o valor sempre escrito ao lado (a dica só reforça, para o ponteiro e o
// toque); estado com palavra, nunca só a cor; cada desenho tem um rótulo para o leitor de tela.

/** O selo de estado em palavra ("Deu lucro", "Margem incompleta", "Sem pedido"). */
export function Selo({ selo }: { selo: SeloDoPeriodo }) {
  return <span className={`veredito veredito--${selo.classe}`}>{selo.rotulo}</span>;
}

/**
 * A dica dos desenhos: uma só para a tela, que segue o ponteiro sobre qualquer elemento com `data-dica`
 * ("título|complemento"). O texto entra por `textContent`. Não recebe foco: o valor está escrito ao lado.
 */
export function DicaDosDesenhos() {
  const caixa = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = caixa.current;
    if (!el) return;
    const alvoDe = (e: Event) => (e.target instanceof Element ? e.target.closest<HTMLElement>('[data-dica]') : null);
    const esconder = () => {
      el.hidden = true;
    };
    const mostrar = (alvo: HTMLElement, x: number, y: number) => {
      const [titulo = '', sub = ''] = (alvo.dataset.dica ?? '').split('|');
      const forte = document.createElement('b');
      forte.textContent = titulo;
      el.replaceChildren(forte, ...(sub ? [document.createTextNode(sub)] : []));
      el.hidden = false;
      const largura = el.offsetWidth;
      el.style.left = `${Math.max(8, Math.min(window.innerWidth - largura - 8, x - largura / 2))}px`;
      el.style.top = `${Math.max(8, y - el.offsetHeight - 14)}px`;
    };
    const aoMover = (e: PointerEvent) => {
      const alvo = alvoDe(e);
      if (alvo) mostrar(alvo, e.clientX, e.clientY);
      else if (e.pointerType === 'mouse') esconder();
    };
    const aoTocar = (e: PointerEvent) => {
      const alvo = alvoDe(e);
      if (alvo) mostrar(alvo, e.clientX, e.clientY);
      else esconder();
    };
    document.addEventListener('pointermove', aoMover);
    document.addEventListener('pointerdown', aoTocar);
    window.addEventListener('scroll', esconder, { passive: true, capture: true });
    return () => {
      document.removeEventListener('pointermove', aoMover);
      document.removeEventListener('pointerdown', aoTocar);
      window.removeEventListener('scroll', esconder, { capture: true });
    };
  }, []);
  return <div className="dica-desenho" ref={caixa} hidden aria-hidden="true" />;
}

function Linha({ linha, empate }: { linha: LinhaDoPar; empate?: { posicao: number; dica: string } | null }) {
  return (
    <div className="par-linha">
      <span>{linha.rotulo}</span>
      <b className="par-valor">{linha.valor}</b>
      {linha.barra ? (
        <div className="trilho">
          <span className={linha.barra.tom === 'gasto' ? 'barra barra--gasto' : 'barra'} style={{ width: `${linha.barra.largura}%` }} data-dica={linha.barra.dica} />
          {empate && <span className="empate" style={{ left: `${empate.posicao}%` }} data-dica={empate.dica} />}
        </div>
      ) : (
        <div className="trilho trilho--vazio">{linha.vazio}</div>
      )}
    </div>
  );
}

/** O gráfico dos dias: as vendas dos anúncios em linha e o gasto em colunas, na mesma escala em reais. */
export function GraficoDosDias({ dias }: { dias: Dias }) {
  const ultimo = dias.dias.length - 1;
  const passo = 100 / ultimo;
  return (
    <div className="mini">
      <div className="mini-topo">
        <span className="mini-leg">
          <span>
            <i className="lg-linha" aria-hidden="true" />
            vendas dos anúncios
          </span>
          <span>
            <i className="lg-coluna" aria-hidden="true" />
            gasto com anúncios
          </span>
        </span>
        <span>
          <b>{dias.ultimo.valor}</b> {dias.ultimo.quando}
        </span>
      </div>
      <div className="faisca" role="img" tabIndex={0} aria-label={dias.rotulo}>
        {dias.dias.map((d, i) => (
          <span key={i} className={dias.fino ? 'coluna coluna--fina' : 'coluna'} style={{ left: `${d.x}%`, height: `${d.altura}%` }} />
        ))}
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          <path className="area" d={dias.area} />
          <path className="fio" d={dias.linha} />
        </svg>
        <span className="pt" style={{ left: '100%', top: `${dias.ultimo.y}%` }} />
        {/* A área de cada dia vai até a metade do caminho para o vizinho; nas pontas, só a metade de dentro. */}
        {dias.dias.map((d, i) => (
          <span
            key={`a${i}`}
            className={i === 0 ? 'alvo alvo--ini' : i === ultimo ? 'alvo alvo--fim' : 'alvo'}
            style={i === 0 || i === ultimo ? { width: `${passo / 2}%` } : { left: `${d.x}%`, width: `${passo}%` }}
            data-dica={d.dica}
          />
        ))}
      </div>
      <div className="dias" aria-hidden="true">
        {dias.marcas.map((m) => (
          <span key={m.x} style={{ left: `${m.x}%` }}>
            {m.texto}
          </span>
        ))}
      </div>
    </div>
  );
}

/** O número principal do modo simples: quanto voltou para cada R$ 1, as duas barras na mesma régua e os dias. */
export function RetornoDoPeriodo({ retorno }: { retorno: RetornoLite }) {
  const seta = retorno.variacao?.sentido;
  return (
    <div className="heroi-grade">
      <div className="heroi-esq">
        <div className="heroi">
          <p className={retorno.vazio ? 'heroi-valor num heroi-valor--vazio' : 'heroi-valor num'}>{retorno.valor}</p>
          {retorno.selo && <Selo selo={retorno.selo} />}
        </div>
        {retorno.sub && (
          <p className="heroi-sub">
            <TextoRico frase={retorno.sub} />
          </p>
        )}
        {retorno.variacao && (
          <p className="variacao">
            {seta !== 'igual' && (
              <svg viewBox="0 0 10 10" aria-hidden="true">
                <path className={seta === 'sobe' ? 'sobe' : 'cai'} d={seta === 'sobe' ? 'M5 1 9.5 9h-9z' : 'M5 9 .5 1h9z'} />
              </svg>
            )}
            <span>
              <TextoRico frase={retorno.variacao.frase} />
            </span>
          </p>
        )}
        {retorno.par && (
          <div className="par" role="img" aria-label={retorno.par.rotulo}>
            <Linha linha={retorno.par.linhas[0]} />
            <Linha linha={retorno.par.linhas[1]} empate={retorno.par.empate} />
          </div>
        )}
        {retorno.par?.empate && (
          <p className="par-legenda">
            <i aria-hidden="true" />
            <span>
              Empata em <b>{retorno.par.empate.valor}</b>: é o que paga o produto e o anúncio.
            </span>
          </p>
        )}
      </div>
      {retorno.dias && <GraficoDosDias dias={retorno.dias} />}
    </div>
  );
}

/** A posição de uma marca entre a parte `antes` e a seguinte, contando os 2px de respiro entre as partes. */
function posicaoDaMarca(posicao: number, antes: number, partes: number): string {
  if (antes === 0) return `${posicao * 100}%`;
  return `calc((100% - ${2 * (partes - 1)}px) * ${posicao.toFixed(5)} + ${2 * antes - 1}px)`;
}

/** Uma barra dividida com a legenda embaixo: o valor de cada parte fica escrito, com a cor ao lado. */
export function BarraDividida({ barra, legenda = true }: { barra: Barra; legenda?: boolean }) {
  return (
    <>
      <div className={barra.marca ? 'pilha-caixa pilha-caixa--marca' : 'pilha-caixa'} role="img" aria-label={barra.rotulo}>
        <div className="pilha">
          {barra.partes.map((p) => (
            <span key={p.rotulo} className={`cor-${p.classe}`} style={{ flex: `${p.peso} 1 0%` }} data-dica={p.dica} />
          ))}
        </div>
        {barra.marca && (
          <span className="pilha-marca" style={{ left: posicaoDaMarca(barra.marca.posicao, barra.marca.antes, barra.partes.length) }}>
            <span>{barra.marca.texto}</span>
          </span>
        )}
      </div>
      {legenda && (
        <ul className="legenda-b">
          {barra.partes.map((p) => (
            <li key={p.rotulo}>
              <i className={`cor-${p.classe}`} aria-hidden="true" />
              <span>
                <b>{p.valor}</b>
                {p.rotulo}
              </span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
