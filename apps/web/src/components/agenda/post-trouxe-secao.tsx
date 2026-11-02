import Link from 'next/link';
import { useId } from 'react';
import { Icone } from '@/components/ui/icone';
import type { OQueTrouxe } from './post-trouxe';

// "O que este post trouxe", na gaveta do post da Agenda (mockups/prototipo-post-trouxe.html, A6 · P33, aprovado em
// 01/11/2026): logo abaixo da situação, os pedidos pelo link do post e, como apoio, os números de cada rede, cada uma no
// seu quadro, com a hora da leitura e o porquê quando faltam. O atalho para Resultados, só para quem pode abri-los; o de
// Contas conectadas, quando falta a permissão de ler ou a conta da rede, só para quem pode vê-las.

export function PostTrouxe({ trouxe: t, podeVerResultados, podeVerContas }: { trouxe: OQueTrouxe; podeVerResultados: boolean; podeVerContas: boolean }) {
  const ids = useId();
  const p = t.pedidos;
  return (
    <section className="ptr" aria-labelledby={`${ids}-t`}>
      <h3 className="rotulo-marca" id={`${ids}-t`}>
        {t.titulo}
      </h3>
      <div className="ptr-pedidos">
        {p.tipo === 'sem-link' && (
          <p className="ptr-sub ptr-sem-link">
            <Icone nome="link" pequeno />
            <span>{p.texto}</span>
          </p>
        )}
        {p.tipo === 'zero' && (
          <>
            <p className="ptr-linha">
              <b className="ptr-n ptr-n--zero">Nenhum pedido pelo link ainda</b>
            </p>
            <p className="ptr-sub">{p.sub}</p>
          </>
        )}
        {p.tipo === 'com' && (
          <>
            <p className="ptr-linha">
              <b className="ptr-n num">{p.n}</b>
              <span className="ptr-caixa">
                <span className="num">{p.caixa}</span> no caixa
              </span>
            </p>
            <p className="ptr-sub">{p.sub}</p>
            {!t.pacote && podeVerResultados && (
              <Link className="ptr-atalho" href="/resultados">
                Ver em Resultados
              </Link>
            )}
          </>
        )}
      </div>
      <p className="ptr-apoio-t">Na rede, como apoio</p>
      {t.semLeitura ? (
        <p className="ptr-falta">
          <Icone nome="info" pequeno />
          <span>{t.semLeitura}</span>
        </p>
      ) : (
        <div className="ptr-redes">
          {t.redes.map((r) => (
            <section className="ptr-rede" aria-labelledby={`${ids}-${r.canal}`} key={r.canal}>
              <div className="ptr-rede-cab">
                <h4 id={`${ids}-${r.canal}`}>{r.nome}</h4>
                {r.lido && <span className="ptr-lido">{r.lido}</span>}
              </div>
              {r.numeros.length > 0 && (
                <dl className="ptr-numeros">
                  {r.numeros.map((n) => (
                    <div key={n.rotulo}>
                      <dt>{n.rotulo}</dt>
                      <dd className="num">{n.valor}</dd>
                    </div>
                  ))}
                </dl>
              )}
              {r.falta && (
                <p className={`ptr-falta${r.falta.atencao ? ' ptr-falta--atencao' : ''}`}>
                  <Icone nome={r.falta.icone} pequeno />
                  <span>{r.falta.texto}</span>
                </p>
              )}
            </section>
          ))}
        </div>
      )}
      {t.conectar && podeVerContas && (
        <div className="ptr-acao">
          <Link className="btn btn--sm" href="/contas">
            <Icone nome="plug" pequeno />
            Abrir Contas conectadas
          </Link>
        </div>
      )}
      {t.nota && <p className="ptr-nota">{t.nota}</p>}
    </section>
  );
}
