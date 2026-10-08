'use client';

import Link from 'next/link';
import { BarraDividida, Selo } from '@/components/resultados/desenhos';
import { TextoRico } from '@/components/resultados/pecas';
import { Icone } from '@/components/ui/icone';
import type { BalaDoNumero, CanaisDoResumo, DinheiroDoResumo, LinhaDoCanal, ParteComFonte, PedidosDoResumo, Stat } from './graficos';
import { type MostrarFonte, NumeroComFonte, TextoComNumeros } from './numeros';
import type { LinhaDeFonte, Texto } from './textos';

// Os desenhos do Resumo (mockups/prototipo-resumo-graficos.html, aprovado em 07/10/2026). As mesmas regras de
// Resultados: barra e posição, nunca pizza; o valor sempre escrito ao lado, e aqui cada valor escrito leva à fonte
// dele; estado com palavra, nunca só a cor; cada desenho tem um rótulo para o leitor de tela (o número que se toca fica
// fora do desenho, para continuar sendo um botão).

/** A lista "De onde vêm os números" e como abrir a linha de um número. */
type ComFonte = { lista: LinhaDeFonte[]; aoTocar: MostrarFonte };

/** A barra do número: esta semana; a marca escura, a semana anterior, na mesma régua. A Revisão da semana usa a mesma. */
export function Bala({ bala }: { bala: BalaDoNumero }) {
  return (
    <div className="bala" role="img" aria-label={bala.rotulo}>
      <span className={bala.negativa ? 'bala-b bala-b--neg cor-falta' : `bala-b cor-${bala.cor}`} style={{ left: `${bala.de}%`, width: `${bala.largura}%` }} data-dica={bala.dicaAgora} />
      {bala.zero !== null && <span className="bala-zero" style={{ left: `${bala.zero}%` }} />}
      {bala.marca !== null && <span className="bala-marca" style={{ left: `${bala.marca}%` }} data-dica={bala.dicaAntes ?? undefined} />}
    </div>
  );
}

/** Um dos três números do topo: o valor, a barra contra a semana anterior, quanto mudou e o valor de antes. */
export function CartaoStat({ s, lista, aoTocar }: { s: Stat } & ComFonte) {
  const texto = (t: Texto) => <TextoComNumeros texto={t} lista={lista} aoTocar={aoTocar} />;
  return (
    <div className={`stat${s.foco ? ' stat--foco' : ''}${s.valor ? '' : ' stat--vazio'}`}>
      <p className="stat-rot">{s.rotulo}</p>
      {s.valor ? (
        <p className="stat-val">
          <NumeroComFonte num={s.valor} lista={lista} aoTocar={aoTocar} />
        </p>
      ) : (
        <p className="stat-val stat-val--txt">{s.vazio}</p>
      )}
      {s.nota && (
        <p className="stat-delta stat-delta--neutro">
          <span>{texto(s.nota)}</span>
        </p>
      )}
      {s.bala && <Bala bala={s.bala} />}
      {s.bala &&
        (s.anterior ? (
          <div className="stat-pe">
            {s.mudou && (
              <p className={`stat-delta stat-delta--${s.mudou.tom}`}>
                {s.mudou.seta && <Icone nome={s.mudou.seta === 'sobe' ? 'trend-up' : 'trend-down'} pequeno />}
                <span>{texto(s.mudou.texto)}</span>
              </p>
            )}
            <p className="bala-leg">
              <i aria-hidden="true" />
              <span>{texto(s.anterior)}</span>
            </p>
          </div>
        ) : (
          <p className="stat-delta stat-delta--neutro">
            <span>sem semana anterior para comparar</span>
          </p>
        ))}
    </div>
  );
}

/** A legenda de uma barra dividida, com cada valor levando à fonte dele. */
function LegendaComFonte({ partes, lista, aoTocar }: { partes: ParteComFonte[] } & ComFonte) {
  return (
    <ul className="legenda-b">
      {partes.map((p) => (
        <li key={p.rotulo}>
          <i className={`cor-${p.classe}`} aria-hidden="true" />
          <span>
            <b>
              <NumeroComFonte num={p.num} lista={lista} aoTocar={aoTocar} />
            </b>
            {p.rotulo}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** O veredito desenhado: o selo da semana, "para onde foi cada real vendido" e as campanhas de cada lado. */
export function CartaoDinheiro({
  dinheiro,
  perguntas,
  aoPerguntar,
  podeVerContas,
  lista,
  aoTocar,
}: {
  dinheiro: DinheiroDoResumo;
  /** As perguntas prontas para a LIA sobre a semana (vazias sem a conversa ou sem o que explicar). */
  perguntas: string[];
  aoPerguntar: (pergunta: string) => void;
  podeVerContas: boolean;
} & ComFonte) {
  const texto = (t: Texto) => <TextoComNumeros texto={t} lista={lista} aoTocar={aoTocar} />;
  const botoes = perguntas.length > 0 && (
    <div className="ia-linha" role="group" aria-label="Perguntar à LIA sobre a semana">
      {perguntas.map((q) => (
        <button className="ia-bt" type="button" key={q} onClick={() => aoPerguntar(q)}>
          <Icone nome="sparkles" />
          {q}
        </button>
      ))}
    </div>
  );
  if (dinheiro.tipo === 'vago') {
    return (
      <article className="card r-dinheiro" aria-labelledby="rd-t">
        <div className="card-cab">
          <h2 id="rd-t">Para onde foi cada real vendido</h2>
        </div>
        <div className="desenho-b">
          <div className="pilha pilha--vazia" aria-hidden="true" />
          <p className="lite-frase lite-frase--grande">{texto(dinheiro.veredito.frase)}</p>
          {dinheiro.veredito.conectarRegem && podeVerContas && (
            <div className="ia-linha">
              <Link className="btn btn--primary" href="/contas">
                <Icone nome="plug" />
                Conectar o Regem
              </Link>
            </div>
          )}
          {botoes}
        </div>
      </article>
    );
  }
  const { lucro, prejuizo } = dinheiro.lados;
  const juntar = (nomes: string[]) => (nomes.length <= 1 ? (nomes[0] ?? '') : `${nomes.slice(0, -1).join(', ')} e ${nomes.at(-1)}`);
  return (
    <article className="card r-dinheiro" aria-labelledby="rd-t">
      <div className="card-cab">
        <div>
          <h2 id="rd-t">Para onde foi cada real vendido</h2>
          <p className="card-sub">{texto(dinheiro.sub)}</p>
        </div>
        {dinheiro.selo && <Selo selo={dinheiro.selo} />}
      </div>
      <div className="dinheiro-grade">
        <div className="desenho-b">
          <BarraDividida barra={{ partes: dinheiro.partes, marca: dinheiro.marca, rotulo: dinheiro.rotulo }} legenda={false} />
          <LegendaComFonte partes={dinheiro.partes} lista={lista} aoTocar={aoTocar} />
        </div>
        <div className="dinheiro-lado">
          {dinheiro.frase && (
            <p className="lite-frase">
              <TextoRico frase={dinheiro.frase} />
            </p>
          )}
          {(lucro.length > 0 || prejuizo.length > 0) && (
            <ul className="lados" aria-label="As campanhas de cada lado">
              {lucro.length > 0 && (
                <li>
                  <span className="veredito veredito--bom">Dá lucro</span>
                  <span>{juntar(lucro)}</span>
                </li>
              )}
              {prejuizo.length > 0 && (
                <li>
                  <span className="veredito veredito--ruim">Dá prejuízo</span>
                  <span>{juntar(prejuizo)}</span>
                </li>
              )}
            </ul>
          )}
          {botoes}
        </div>
      </div>
    </article>
  );
}

/** Os pedidos da semana numa barra só, com o valor médio dos que vieram dos anúncios. */
export function CartaoPedidos({ pedidos, semRegem, lista, aoTocar }: { pedidos: PedidosDoResumo | null; semRegem: boolean } & ComFonte) {
  return (
    <article className="card r-pedidos" aria-labelledby="rpd-t">
      <div className="card-cab">
        <div>
          <h2 id="rpd-t">De onde vieram os pedidos</h2>
          <p className="card-sub">
            {pedidos ? (
              <>
                <NumeroComFonte num={pedidos.total} lista={lista} aoTocar={aoTocar} /> confirmados no caixa do Regem, em todos os canais.
              </>
            ) : (
              'Confirmados no caixa do Regem.'
            )}
          </p>
        </div>
      </div>
      {!pedidos ? (
        <p className="card-sub">{semRegem ? 'Os pedidos vêm do caixa do Regem.' : 'Ainda sem 7 dias completos de pedidos.'}</p>
      ) : pedidos.partes.length ? (
        <div className="desenho-b">
          <BarraDividida barra={{ partes: pedidos.partes, marca: null, rotulo: pedidos.rotulo }} legenda={false} />
          <LegendaComFonte partes={pedidos.partes} lista={lista} aoTocar={aoTocar} />
          {pedidos.medio && (
            <p className="nota-b">
              <span>
                Cada pedido que veio dos anúncios valeu, em média,{' '}
                <b>
                  <NumeroComFonte num={pedidos.medio} lista={lista} aoTocar={aoTocar} />
                </b>
                .
              </span>
            </p>
          )}
        </div>
      ) : (
        <p className="card-sub">Nenhum pedido confirmado nos últimos 7 dias.</p>
      )}
    </article>
  );
}

/** Onde o valor fica escrito: na ponta da barra que sobrou, logo depois do zero na que faltou, depois do traço na incompleta. */
function ondeOValor(l: LinhaDoCanal, zero: number): string {
  if (l.tipo === 'ganho') return `${zero + l.largura}%`;
  if (l.tipo === 'semcusto') return `calc(${zero}% + 22px)`;
  return `${zero}%`;
}

/** Cada canal de anúncio na mesma régua: sobrou (para a direita) ou faltou (para a esquerda). */
export function CartaoCanais({ canais, semRegem, lista, aoTocar }: { canais: CanaisDoResumo | null; semRegem: boolean } & ComFonte) {
  return (
    <article className="card r-canais" aria-labelledby="rcn-t">
      <div className="card-cab">
        <div>
          <h2 id="rcn-t">Cada canal de anúncio</h2>
          <p className="card-sub">O que sobrou ou faltou depois de pagar o anúncio.</p>
        </div>
      </div>
      {!canais ? (
        <p className="card-sub">{semRegem ? 'Sem o Regem, os pedidos não chegam ao Liame.' : 'Os pedidos aparecem aqui depois dos primeiros 7 dias completos.'}</p>
      ) : canais.tipo === 'vazio' ? (
        <p className="card-sub">{canais.frase}</p>
      ) : (
        <ul className="canais canais--b" style={{ ['--zero' as string]: `${canais.zero}%` }} aria-label="Quanto sobrou ou faltou em cada canal de anúncio">
          {(canais.legenda.faltou || canais.legenda.sobrou) && (
            <li className="canal-leg" aria-hidden="true">
              <div className="eixo-legenda">
                {canais.legenda.faltou && <span className="el-falta">← faltou</span>}
                {canais.legenda.sobrou && <span className="el-sobra">sobrou →</span>}
              </div>
            </li>
          )}
          {canais.linhas.map((l) => (
            <li key={l.provider}>
              <div className="canal-linha">
                <span className="canal-nome">{l.nome}</span>
                <span className="canal-num">
                  <NumeroComFonte num={l.pedidos} lista={lista} aoTocar={aoTocar} /> {l.umPedido ? 'pedido' : 'pedidos'}
                </span>
              </div>
              <div className="eixo">
                <span className={`b b--${l.tipo}`} style={l.tipo === 'ganho' || l.tipo === 'perda' ? { width: `${l.largura}%` } : undefined} role="img" aria-label={l.rotulo} data-dica={l.dica} />
                <span className={l.valor ? 'v' : 'v v--txt'} style={{ left: ondeOValor(l, canais.zero) }}>
                  {l.valor ? (
                    <>
                      {l.valor.sinal} <NumeroComFonte num={l.valor.num} lista={lista} aoTocar={aoTocar} />
                    </>
                  ) : (
                    l.texto
                  )}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}
