'use client';

import type { TeamMember, TeamShadowResponse } from '@liame/contracts';
import { Icone } from '@/components/ui/icone';
import type { Modo } from '@/lib/modo';
import { fraseDaSombra, linhaDaSombra, rodadaDa } from './textos';

// O Gestor de tráfego em sombra (protótipo P7): o que ele teria feito e o que a pessoa fez. No Lite, a frase com os
// números do mês; no Pro, a rodada mais recente e a tabela com cada recomendação. Nada muda na plataforma.

/** A última rodada da rotina (só no Pro). */
export function BlocoRodada({ sombra, agora }: { sombra: TeamShadowResponse; agora: Date }) {
  const rodada = rodadaDa(sombra, agora);
  if (!rodada) return null;
  return (
    <div className="eqp-bloco">
      <div className="eqp-bloco-cab">
        <h3>{rodada.dia === 'hoje' ? 'Rodada de hoje' : 'Última rodada'}</h3>
        <span className="eixo-nota">
          {rodada.dia} · {rodada.nota}
        </span>
      </div>
      <ol className="eqp-passos">
        {rodada.passos.map((p) => (
          <li className="eqp-passo" key={p.texto}>
            <span className="eqp-passo-ic" aria-hidden="true">
              <Icone nome="check" />
            </span>
            <div>
              <p className="eqp-passo-txt">{p.texto}</p>
              <div className="ferr">
                {p.ferramentas.map((f) => (
                  <span key={f}>{f}</span>
                ))}
              </div>
            </div>
          </li>
        ))}
      </ol>
      {rodada.aviso && <p className="explica-nota">{rodada.aviso}</p>}
    </div>
  );
}

export function BlocoSombra({ m, mes, sombra, modo, agora }: { m: TeamMember; mes: string; sombra: TeamShadowResponse | null; modo: Modo; agora: Date }) {
  const frase = fraseDaSombra(m, mes);
  let pro;
  if (!sombra) pro = <p className="card-sub">Não foi possível carregar a lista das recomendações. Os números do mês seguem acima.</p>;
  else if (!sombra.items.length) pro = <p className="card-sub">Nenhuma recomendação registrada ainda. Elas saem todo dia, depois da leitura da manhã, quando alguma campanha pede.</p>;
  else {
    pro = (
      <>
        <div className="table-wrap">
          <table className="tabela tabela--compacta">
            <caption className="sr-only">Recomendações em sombra, o que você fez e o resultado</caption>
            <thead>
              <tr>
                <th scope="col">Dia</th>
                <th scope="col">Campanha</th>
                <th scope="col">Ele faria</th>
                <th scope="col">Você fez</th>
                <th scope="col">Resultado</th>
              </tr>
            </thead>
            <tbody>
              {sombra.items.map((d) => {
                const l = linhaDaSombra(d, agora);
                return (
                  <tr key={d.id}>
                    <td className="num">{l.dia}</td>
                    <th scope="row">{l.campanha}</th>
                    <td>{l.eleFaria}</td>
                    <td>{l.voceFez}</td>
                    <td>{l.resultado}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {sombra.has_more && <p className="explica-nota">Aqui estão as {sombra.items.length} recomendações mais recentes.</p>}
      </>
    );
  }
  return (
    <div className="eqp-bloco">
      <div className="eqp-bloco-cab">
        <h3>O que ele teria feito, e o que você fez</h3>
        <span className="modo-chip modo-chip--sombra">Nada muda na plataforma</span>
      </div>
      {modo === 'lite' ? <p className="lite-frase">{frase.partes.map((p, i) => (p.forte ? <b key={i}>{p.texto}</b> : <span key={i}>{p.texto}</span>))}</p> : pro}
      <p className="explica-nota">
        O resultado compara os 7 dias depois da recomendação com o que teria acontecido se ela fosse feita, com os números confirmados no caixa. Quando você foi para outro lado, não há como
        comparar.
      </p>
    </div>
  );
}
