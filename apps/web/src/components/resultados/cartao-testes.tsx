'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Icone } from '@/components/ui/icone';
import { api, chamar, mensagemDe, type Problema } from '@/lib/api';
import { disparar } from '@/lib/disparar';
import { type TesteNaLista, testesDaMarca } from './testes';

// "Testes" em Resultados (R8; D-RG-97): depois do cartão das campanhas, os testes da marca (de criativo e de região), do
// mais novo ao mais antigo. "Ver o teste" abre o teste em Aprovações, onde ele é acompanhado. Sem teste, o cartão diz onde
// se pede; sem teste e sem a função do teste ligada, ele não aparece.

type Carga = { tipo: 'carregando' } | { tipo: 'ok'; itens: TesteNaLista[]; ligado: boolean } | { tipo: 'erro'; problema: Problema };

type Props = { brandId: string; hoje: string };

export function CartaoTestes({ brandId, hoje }: Props) {
  const [carga, setCarga] = useState<Carga>({ tipo: 'carregando' });
  const [tentativa, setTentativa] = useState(0);

  useEffect(() => {
    let vivo = true;
    setCarga({ tipo: 'carregando' });
    const query = { brand_id: brandId };
    disparar(
      Promise.all([
        chamar(() => api.GET('/v1/creative-tests', { params: { query } })),
        chamar(() => api.GET('/v1/region-tests', { params: { query } })),
        chamar(() => api.GET('/v1/creative-tests/options', { params: { query } })),
      ]).then(([c, r, o]) => {
        if (!vivo) return;
        if (!c.ok) return setCarga({ tipo: 'erro', problema: c.problema });
        if (!r.ok) return setCarga({ tipo: 'erro', problema: r.problema });
        setCarga({ tipo: 'ok', itens: testesDaMarca(c.data.items, r.data.items, hoje), ligado: o.ok && o.data.enabled });
      }),
    );
    return () => {
      vivo = false;
    };
  }, [brandId, hoje, tentativa]);

  if (carga.tipo === 'carregando') return null;
  if (carga.tipo === 'ok' && !carga.itens.length && !carga.ligado) return null;

  return (
    <section className="card r8t-card" id="card-testes" aria-labelledby="t-testes">
      <div className="card-cab">
        <div>
          <h2 id="t-testes" tabIndex={-1}>
            Testes
          </h2>
          <p className="card-sub">O que cada teste da marca mostrou, guardado aqui. Quem decide é o caixa; nada é comparado com outras empresas.</p>
        </div>
      </div>
      <div className="card-corpo">
        {carga.tipo === 'erro' ? (
          <div className="dialogo-erro" role="alert">
            <Icone nome="alert" pequeno />
            <span>
              Não deu para carregar os testes. {mensagemDe(carga.problema)}{' '}
              <button className="link-bt" type="button" onClick={() => setTentativa((x) => x + 1)}>
                Tentar de novo
              </button>
            </span>
          </div>
        ) : carga.itens.length === 0 ? (
          <div className="vazio">
            <div className="vazio-ic" aria-hidden="true">
              <Icone nome="chart" />
            </div>
            <h3>Nenhum teste ainda</h3>
            <p className="campo-dica">O teste de criativo se pede em Criativos, na peça aprovada (“Testar contra outra peça”).</p>
          </div>
        ) : (
          <ul className="r8t-lista">
            {carga.itens.map((t) => (
              <li key={t.id} className="r8t-teste">
                <div className="r8t-teste-nome">
                  <b>{t.nome}</b>
                  <small>
                    {t.tipo} · {t.quando}
                  </small>
                </div>
                <span className={`st st--${t.situacao.tom}`}>{t.situacao.rotulo}</span>
                <p className="r8t-teste-veredito">{t.veredito}</p>
                {t.numeros.length > 0 && (
                  <p className="r8t-teste-numeros">
                    {t.numeros.map((n) => (
                      <span key={n}>{n}</span>
                    ))}
                  </p>
                )}
                {t.pedido && (
                  <div>
                    <Link className="btn btn--sm" href={`/aprovacoes?pedido=${t.pedido}`}>
                      Ver o teste<span className="sr-only">: {t.nome}</span>
                    </Link>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
