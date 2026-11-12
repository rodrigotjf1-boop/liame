import type { RegionOverviewResponse } from '@liame/contracts';
import type { CSSProperties } from 'react';
import { Icone } from '@/components/ui/icone';
import { Numero } from './numero';
import { diaDaSemanaCurto, diaEMes, fraseDoPico, horasDoGrafico, inteiro, parteEmPorcento, reaisDeMicros, variacao } from './textos-da-regiao';

// A demanda da loja (plano da região, R3, parte 1; P40, revisão aprovada em 12/11/2026, D-RG-21 a D-RG-25): os pedidos
// que o Liame já lê do Regem, nas 4 semanas completas até ontem. Os números de venda chegam só para quem vê Resultados
// (o servidor decide; a tela só diz por que não vieram).

export function DemandaDaLoja({ r, lojaNome, ids, mostraPro }: { r: RegionOverviewResponse; lojaNome: string; ids: string; mostraPro: boolean }) {
  if (r.store_demand_status === 'sem_endereco') return null;
  const d = r.store_demand;
  const titulo = `${ids}-dem`;
  const cab = (sub: string) => (
    <div className="rg-grupo-cab">
      <h3 id={titulo}>A demanda da loja</h3>
      <p>{sub}</p>
    </div>
  );

  if (r.store_demand_status === 'sem_permissao') {
    return (
      <section className="rg-grupo" aria-labelledby={titulo}>
        {cab('pedidos do Regem')}
        <p className="rg-nota">
          <Icone nome="lock" pequeno />
          <span>Os números de venda da loja ficam para quem vê Resultados. Peça ao dono a permissão, se precisar deles.</span>
        </p>
      </section>
    );
  }
  if (r.store_demand_status === 'sem_regem' || !d) {
    return (
      <section className="rg-grupo" aria-labelledby={titulo}>
        {cab('pedidos por dia e hora, tíquete e clientes')}
        <p className="lite-frase">
          A demanda da loja aparece com os pedidos do Regem: com ele, o Liame mostra os pedidos por dia da semana e por hora, o tíquete médio e o cliente novo × de volta. Sem ele, a
          medida de pedido é o cupom exclusivo de cada campanha.
        </p>
      </section>
    );
  }

  const sub = `pedidos do Regem, 4 semanas até ontem (${diaEMes(d.to)})`;
  const periodo = `de ${diaEMes(d.from)} a ${diaEMes(d.to)}`;
  if (d.status === 'sem_pedidos') {
    return (
      <section className="rg-grupo" aria-labelledby={titulo}>
        {cab(sub)}
        <p className="lite-frase">Nenhum pedido confirmado da loja {lojaNome} {periodo}. A demanda aparece quando os pedidos do Regem chegarem.</p>
      </section>
    );
  }

  const pedidos = (
    <Numero
      valor={
        <>
          {inteiro(d.orders)} <small>{d.orders === 1 ? 'pedido' : 'pedidos'}</small>
        </>
      }
      obs={`confirmados ${periodo}, na ${lojaNome}`}
      fonte="Regem · pedidos confirmados"
      pro={`order_fact · status confirmado · janela de ${d.days} dias no fuso da loja`}
      mostraPro={mostraPro}
    />
  );
  const mudou = d.ticket_micros && d.previous.ticket_micros ? variacao(Number(d.ticket_micros), Number(d.previous.ticket_micros)) : null;
  const tiquete = d.ticket_micros ? (
    <Numero
      valor={reaisDeMicros(d.ticket_micros)}
      obs={d.previous.ticket_micros ? `de tíquete médio; nas 4 semanas antes, ${reaisDeMicros(d.previous.ticket_micros)}${mudou ? ` (${mudou})` : ''}` : 'de tíquete médio'}
      fonte="Regem · receita líquida (sem o estorno) ÷ pedidos"
      pro={`receita: ${reaisDeMicros(d.revenue_micros)} · nas 4 semanas antes: ${inteiro(d.previous.orders)} pedidos`}
      mostraPro={mostraPro}
    />
  ) : null;

  if (d.status === 'poucos_pedidos') {
    return (
      <section className="rg-grupo" aria-labelledby={titulo}>
        {cab(sub)}
        <div className="rg-nums">
          {pedidos}
          {tiquete}
        </div>
        <p className="lite-frase">Ainda são poucos pedidos para dizer o dia e a hora: eles aparecem a partir de {inteiro(d.minimum_orders)} pedidos nas 4 semanas.</p>
      </section>
    );
  }

  const c = d.customers;
  const clientes = (
    <Numero
      valor={
        <>
          {parteEmPorcento(c.returning, d.orders)} <small>de volta</small>
        </>
      }
      obs={`${parteEmPorcento(c.new, d.orders)} de clientes novos${c.unknown > 0 ? `; ${parteEmPorcento(c.unknown, d.orders)} sem o cliente identificado (o iFood e a 99 não mandam o cliente)` : ''}`}
      fonte="Regem · cliente novo × de volta"
      pro={`${inteiro(c.returning)} de volta, ${inteiro(c.new)} novos, ${inteiro(c.unknown)} sem cliente`}
      mostraPro={mostraPro}
    />
  );
  const maxDia = Math.max(1, ...d.by_weekday.map((x) => x.orders));
  const horas = horasDoGrafico(d.by_hour);
  const maxHora = Math.max(1, ...horas.map((x) => x.orders));
  // Cada gráfico destaca o seu maior (no empate, o primeiro); o pico (dia × hora) vem na frase de baixo.
  const diaMaior = d.by_weekday.find((x) => x.orders === maxDia)?.weekday ?? -1;
  const horaMaior = horas.find((x) => x.orders === maxHora)?.hour ?? -1;
  // Com muitas colunas, o rótulo fica só nas horas pares, para caber no celular.
  const rotuloEmTodas = horas.length <= 13;
  const descricao = `Pedidos por hora nas 4 semanas: ${horas.map((h) => `${h.hour}h, ${h.orders}`).join('; ')}.`;
  const pico = d.peak ? fraseDoPico(d.peak) : null;

  return (
    <section className="rg-grupo" aria-labelledby={titulo}>
      {cab(sub)}
      <div className="rg-nums">
        {pedidos}
        {tiquete}
        {clientes}
      </div>
      <div className="rg-duas">
        <div>
          <h4>Por dia da semana</h4>
          <div className="rg-barras-dia">
            {d.by_weekday.map((x) => (
              <div className={`rg-barra${x.weekday === diaMaior ? ' rg-barra--foco' : ''}`} key={x.weekday}>
                <span>{diaDaSemanaCurto(x.weekday)}</span>
                <span className="rg-barra-trilho" aria-hidden="true">
                  <i style={{ '--v': `${(x.orders / maxDia) * 100}%` } as CSSProperties} />
                </span>
                <span className="num">{inteiro(x.orders)}</span>
              </div>
            ))}
          </div>
        </div>
        <div>
          <h4>Por hora em que o cliente pediu</h4>
          <ul className="rg-horas" role="img" aria-label={descricao} style={{ '--n': String(Math.max(1, horas.length)) } as CSSProperties}>
            {horas.map((h) => (
              <li className={`rg-hora${h.hour === horaMaior ? ' rg-hora--foco' : ''}`} key={h.hour}>
                <span className="rg-hora-trilho" aria-hidden="true">
                  <i style={{ '--v': `${(h.orders / maxHora) * 100}%` } as CSSProperties} />
                </span>
                <span className="num">{rotuloEmTodas || h.hour % 2 === 0 ? `${h.hour}h` : ''}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
      {pico && (
        <p className="rg-pico">
          <Icone nome="clock" pequeno />
          <span>
            <b>{pico.titulo}</b> {pico.resto}
          </span>
        </p>
      )}
      <p className="rg-nota">
        <Icone nome="info" pequeno />
        <span>O pico vira o horário da verba no plano de mídia (R5), e o tíquete se compara com o bolso do bairro. Os números são da sua loja, não da região.</span>
      </p>
    </section>
  );
}
