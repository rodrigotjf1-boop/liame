'use client';

import type { CSSProperties } from 'react';
import { BotaoPedir, type PedirNaLista } from '@/components/pedir/botao-pedir';
import { Selo } from './desenhos';
import type { BarraDaCampanha, CampanhasLite as Dados, LinhaConversa } from './graficos';
import { TextoRico } from './pecas';

// Cada campanha no modo simples (protótipo de Resultados em gráficos): uma barra para a direita (sobrou) ou para a
// esquerda (faltou), todas na mesma régua, com o selo em palavra e o "Pedir mudança". Em "Hoje" e sem o Regem, a
// barra é de quantidade (pedidos ou gasto). As campanhas de mensagem ganham o cartão das conversas.

function Barra({ barra, zero }: { barra: BarraDaCampanha; zero: number }) {
  if ('texto' in barra) {
    const semCusto = barra.tipo === 'semcusto';
    return (
      <>
        <span className={semCusto ? 'b b--semcusto' : 'b b--neutro'} data-dica={barra.dica} />
        <span className="v v--txt" style={{ left: semCusto ? `calc(${zero}% + 22px)` : `calc(${zero}% + 4px)` }}>
          {barra.texto}
        </span>
      </>
    );
  }
  if (barra.tipo === 'tamanho') {
    return (
      <>
        <span className={barra.tom === 'gasto' ? 'b b--gasto' : 'b b--foco'} style={{ width: `${barra.largura}%` }} data-dica={barra.dica} />
        <span className="v" style={{ left: `${barra.largura}%` }}>
          {barra.valor}
        </span>
      </>
    );
  }
  const ganho = barra.tipo === 'ganho';
  return (
    <>
      <span className={ganho ? 'b b--ganho' : 'b b--perda'} style={{ width: `${barra.largura}%` }} data-dica={barra.dica} />
      <span className="v" style={{ left: `${ganho ? zero + barra.largura : zero}%` }}>
        {barra.valor}
      </span>
    </>
  );
}

export function ListaDeCampanhas({ campanhas, pedir }: { campanhas: Dados; /** O pedido de mudança, quando alguma campanha à vista o tem. */ pedir: PedirNaLista | null }) {
  const sobra = campanhas.modo === 'sobra';
  return (
    <ul className={pedir ? 'camp-b camp-b--pedir' : 'camp-b'} style={{ ['--zero' as string]: `${campanhas.zero}%` } as CSSProperties} aria-label={campanhas.rotulo}>
      {sobra && (campanhas.temFalta || campanhas.temSobra) && (
        <li className="camp-b-leg" aria-hidden="true">
          <span />
          <div className="eixo-legenda">
            {campanhas.temFalta && <span className="el-falta">← faltou</span>}
            {campanhas.temSobra && <span className="el-sobra">sobrou →</span>}
          </div>
        </li>
      )}
      {campanhas.linhas.map((c) => (
        <li key={c.id}>
          <div className="cl-nome">
            <b>{c.nome}</b>
            <span>{c.sub}</span>
          </div>
          <div className={sobra ? 'eixo' : 'eixo eixo--sem-zero'} role="img" aria-label={c.rotulo}>
            <Barra barra={c.barra} zero={campanhas.zero} />
          </div>
          {c.selo ? <Selo selo={c.selo} /> : <span className="veredito-vago" />}
          {pedir && (
            <span className="camp-acao">
              <BotaoPedir campanha={c} pedir={pedir} />
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

/** "Das conversas ao pedido": os pedidos dentro das conversas abertas pelo anúncio (só no modo simples). */
export function CartaoConversas({ linhas }: { linhas: LinhaConversa[] }) {
  if (!linhas.length) return null;
  return (
    <article className="card" aria-labelledby="t-conv">
      <div className="card-cab">
        <h2 id="t-conv">Das conversas ao pedido</h2>
      </div>
      <ul className="funil">
        {linhas.map((c) => (
          <li key={c.id}>
            <div className="cl-nome">
              <b>{c.nome}</b>
              <span>{c.plataforma}</span>
            </div>
            <div className="funil-trilho" style={{ width: `${c.largura}%` }} role="img" aria-label={c.rotulo} data-dica={c.dicaConversas}>
              <span style={{ width: `${c.fatia}%` }} data-dica={c.dicaPedidos} />
            </div>
            <p className="funil-txt">
              <TextoRico frase={c.frase} />
            </p>
          </li>
        ))}
      </ul>
      <ul className="legenda-b legenda-b--linha" aria-hidden="true">
        <li>
          <i className="cor-c1" />
          <span>conversas abertas pelo anúncio</span>
        </li>
        <li>
          <i className="cor-foco" />
          <span>viraram pedido</span>
        </li>
      </ul>
    </article>
  );
}
