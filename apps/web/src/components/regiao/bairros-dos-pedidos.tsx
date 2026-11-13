import type { RegionOverviewResponse } from '@liame/contracts';
import { Icone } from '@/components/ui/icone';
import { diaEMes, inteiro, umaCasa } from './textos-da-regiao';

// Os bairros para atacar e para defender (plano da região, R3, parte 2; P40, revisão R3-2 aprovada pela autorização da
// noite de 12/11/2026, D-RG-36 a D-RG-39): os pedidos de entrega que o Regem manda somados por bairro, com a gente do
// Censo. Atacar: muita gente e poucos pedidos; defender: já compra muito (plano da região §4.2). Só para quem vê Resultados.

export const PAPEL: Record<string, { rotulo: string; classe: string }> = {
  defender: { rotulo: 'Defender', classe: 'st st--concluido' },
  atacar: { rotulo: 'Atacar', classe: 'st st--perigo' },
  manter: { rotulo: 'Manter', classe: 'st st--neutro' },
};

export function BairrosDosPedidos({ r, ids, mostraPro }: { r: RegionOverviewResponse; ids: string; mostraPro: boolean }) {
  if (r.order_districts_status === 'sem_endereco') return null;
  const b = r.order_districts;
  const titulo = `${ids}-bairros`;
  const cab = (sub: string) => (
    <div className="rg-grupo-cab">
      <h3 id={titulo}>Bairros para atacar e para defender</h3>
      <p>{sub}</p>
    </div>
  );

  if (r.order_districts_status === 'sem_permissao') {
    return (
      <section className="rg-grupo" aria-labelledby={titulo}>
        {cab('pedidos do Regem por bairro')}
        <p className="rg-nota">
          <Icone nome="lock" pequeno />
          <span>Os pedidos por bairro ficam para quem vê Resultados. Peça ao dono a permissão, se precisar deles.</span>
        </p>
      </section>
    );
  }
  if (r.order_districts_status === 'sem_regem') {
    return (
      <section className="rg-grupo" aria-labelledby={titulo}>
        {cab('pedidos por bairro')}
        <p className="lite-frase">Com o Regem, o Liame mostra de que bairros vêm os pedidos de entrega, somados e sem identificar ninguém, e quais bairros atacar e quais defender.</p>
      </section>
    );
  }
  if (r.order_districts_status === 'lendo' || !b) {
    return (
      <section className="rg-grupo" aria-labelledby={titulo}>
        {cab('pedidos do Regem por bairro')}
        <p className="lite-frase">Lendo os pedidos por bairro do Regem: aparecem na próxima leitura das vendas, uma vez por dia.</p>
      </section>
    );
  }

  const resto = [
    b.others.orders > 0 ? `${inteiro(b.others.districts)} ${b.others.districts === 1 ? 'outro bairro soma' : 'outros bairros somam'} ${inteiro(b.others.orders)} ${b.others.orders === 1 ? 'pedido' : 'pedidos'} (cada um com menos de ${b.minimum})` : null,
    b.without_district > 0 ? `${inteiro(b.without_district)} sem o bairro no endereço` : null,
    b.pickup > 0 ? `${inteiro(b.pickup)} de retirada e balcão` : null,
  ].filter((x): x is string => x !== null);

  return (
    <section className="rg-grupo" aria-labelledby={titulo}>
      {cab(`pedidos de entrega do Regem, 4 semanas até ontem (${diaEMes(b.to)})`)}
      {!b.comparable && (
        <p className="lite-frase">Ainda não dá para dizer quem atacar e quem defender: são precisos pelo menos 3 bairros com a gente conhecida pelo Censo.</p>
      )}
      {b.districts.length === 0 ? (
        <p className="lite-frase">Nenhum bairro chegou a {b.minimum} pedidos de entrega de {diaEMes(b.from)} a {diaEMes(b.to)}.</p>
      ) : (
        <ul className="rg-cidades">
          {b.districts.map((d) => {
            const papel = d.role ? PAPEL[d.role] : null;
            return (
              <li key={d.name}>
                <span>
                  <b>{d.name}</b>
                  {d.in_delivery_area && <small>na área de entrega</small>}
                </span>
                <span>
                  {papel && <span className={papel.classe}>{papel.rotulo}</span>}{' '}
                  {d.orders === null ? `menos de ${b.minimum} pedidos` : `${inteiro(d.orders)} ${d.orders === 1 ? 'pedido' : 'pedidos'}`}
                  {d.per_1000 !== null && d.orders !== null && `, ${umaCasa(d.per_1000)} por mil moradores`}
                  {mostraPro && d.population !== null && ` · ${inteiro(d.population)} moradores (Censo 2022)`}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {resto.length > 0 && <p className="lite-frase">Dos {inteiro(b.delivery_orders)} pedidos de entrega: {resto.join('; ')}.</p>}
      <p className="rg-nota">
        <Icone nome="info" pequeno />
        <span>
          Atacar: muita gente e poucos pedidos (reconhecimento e oferta de entrada). Defender: o bairro já compra muito (recompra e novidade). O Regem manda os pedidos somados por bairro,
          sem identificar ninguém; o bairro com menos de {b.minimum} pedidos vem somado.
        </span>
      </p>
    </section>
  );
}
