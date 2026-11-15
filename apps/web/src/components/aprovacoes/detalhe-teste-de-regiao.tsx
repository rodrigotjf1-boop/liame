'use client';

import { type ActionResponse, REGION_TEST_MIN_OTHER_DISTRICTS, REGION_TEST_MIN_WEEKLY_ORDERS, REGION_TEST_WEEKS_BEFORE, type RegionTestResponse } from '@liame/contracts';
import { type RefObject, useCallback, useEffect, useId, useState } from 'react';
import { BotaoDetalhes } from '@/components/resultados/pecas';
import { Icone } from '@/components/ui/icone';
import { api, chamar, mensagemDe, type Problema } from '@/lib/api';
import type { Prova } from '@/lib/chave-de-acesso';
import { disparar } from '@/lib/disparar';
import { BarraDaDecisao, type Decisao } from './barra-da-decisao';
import { andamentoDoTesteDeRegiao, bairrosDoTeste, conjuntosDoTesteDeRegiao, idDoTesteDeRegiao, semanasDoTeste, situacaoDoTesteDeRegiao, tituloDoTesteDeRegiao } from './teste-de-regiao-textos';
import { cabecalhoDe, type Grupo, MOTIVOS_DA_RECUSA, resultadoDe, riscoDe, ROTULO_RISCO } from './textos';

// O teste de região em Aprovações (plano da região, R8; protótipo dos testes aprovado pelo dono em 13/11/2026; D-RG-81 e
// D-RG-82): o pedido "um bairro 14 dias sem anúncio", com os pedidos por bairro das 4 semanas de antes, de onde o bairro sai
// e o risco; a decisão com o código do app. Aprovar, por enquanto, só marca o teste como pronto (a tela diz).

type Props = {
  acao: ActionResponse;
  grupo: Grupo | null;
  agora: Date;
  podeDecidir: boolean;
  temApp: boolean;
  temChave?: boolean;
  titulo: RefObject<HTMLHeadingElement | null>;
  campoCodigo: RefObject<HTMLInputElement | null>;
  aoVoltar: () => void;
  aoAprovar: (acao: ActionResponse, prova: Prova) => Promise<Decisao>;
  aoRecusar: (acao: ActionResponse, motivo: string) => Promise<Decisao>;
};

type Lido = { estado: 'lendo' } | { estado: 'ok'; t: RegionTestResponse } | { estado: 'erro'; problema: Problema };

const MOTIVOS = MOTIVOS_DA_RECUSA.map((m) => ({ valor: m, rotulo: m }));

export function DetalheTesteDeRegiao({ acao, grupo, agora, podeDecidir, temApp, temChave = false, titulo, campoCodigo, aoVoltar, aoAprovar, aoRecusar }: Props) {
  const ids = useId();
  const id = idDoTesteDeRegiao(acao.resource_id);
  const [lido, setLido] = useState<Lido>({ estado: 'lendo' });
  const [detalhes, setDetalhes] = useState(false);
  const cab = cabecalhoDe(acao, agora);

  const ler = useCallback(async () => {
    if (!id) return;
    const r = await chamar(() => api.GET('/v1/region-tests/{id}', { params: { path: { id } } }));
    setLido(r.ok ? { estado: 'ok', t: r.data } : { estado: 'erro', problema: r.problema });
  }, [id]);

  useEffect(() => {
    setLido({ estado: 'lendo' });
    disparar(ler());
  }, [ler, acao.status, acao.updated_at]);

  const voltar = (
    <button className="btn btn--ghost btn--sm voltar" type="button" onClick={aoVoltar}>
      <Icone nome="chevron-left" />
      Voltar para a lista
    </button>
  );
  const cabecalho = (
    <>
      <div className="det-cab">
        <span>
          <b>{cab.quem}</b> {cab.verbo}
        </span>
        <span>· {cab.quando}</span>
        <span>· em Minha marca › Região › Sua região, no bairro dos pedidos: “Testar sem anúncio”</span>
      </div>
      <h2 className="det-titulo" id="ap-det-titulo" ref={titulo} tabIndex={-1}>
        {tituloDoTesteDeRegiao(lido.estado === 'ok' ? lido.t.name : null)}
      </h2>
    </>
  );

  if (!id) {
    return (
      <>
        {voltar}
        {cabecalho}
        <p className="nota">
          <Icone nome="alert-circle" />
          <span>O pedido não aponta para um teste de região do Liame.</span>
        </p>
      </>
    );
  }
  if (lido.estado !== 'ok') {
    return (
      <>
        {voltar}
        {cabecalho}
        {lido.estado === 'erro' ? (
          <div className="plano-espera" role="alert">
            <p className="nota">
              <Icone nome="alert-circle" />
              <span>Não foi possível abrir o teste. {mensagemDe(lido.problema)}</span>
            </p>
            <div className="vazio-acoes">
              <button className="btn btn--sm" type="button" onClick={() => disparar(ler())}>
                <Icone nome="refresh" pequeno />
                Tentar de novo
              </button>
            </div>
          </div>
        ) : (
          <div className="plano-espera" aria-busy="true">
            <p className="sr-only">Abrindo o teste…</p>
            <span className="esqueleto esqueleto--curto" aria-hidden="true" />
            <span className="esqueleto" aria-hidden="true" />
          </div>
        )}
      </>
    );
  }

  const t = lido.t;
  const pendente = grupo === 'pendente';
  const situacao = situacaoDoTesteDeRegiao(t);
  const risco = riscoDe(acao);
  const andamento = andamentoDoTesteDeRegiao(t);
  const resultado = pendente ? null : resultadoDe(acao);
  const perigo = t.status === 'interrompido' || t.status === 'cancelado';
  const bairros = bairrosDoTeste(t);

  return (
    <>
      {voltar}
      {cabecalho}
      <div className="det-chips">
        <span className={`st st--${situacao.tom}`}>{situacao.rotulo}</span>
        {pendente && <span className={`risco risco--${risco}`}>{ROTULO_RISCO[risco]}</span>}
      </div>

      {pendente && (
        <div className="secao secao--lite">
          <p className="lite-frase lite-frase--grande">
            Por {t.days} dias, <b>{t.district.name} fica sem anúncio</b>. Depois, o Liame compara os pedidos do bairro no caixa com os dos outros bairros, antes e durante. É como se descobre{' '}
            <b>quantos pedidos o anúncio traz que não viriam sozinhos</b>. A verba não muda: ela vai para os outros bairros.
          </p>
          <div className="lite-chips">
            <span className="lite-chip">Sem verba nova</span>
            <span className="lite-chip">O bairro pode vender menos no teste</span>
          </div>
        </div>
      )}

      {andamento && (
        <div className="secao">
          {perigo ? (
            <div className="pd-aviso pd-aviso--perigo" role="alert">
              <Icone nome="alert-circle" />
              <div>
                <b>{t.status === 'interrompido' ? 'O teste foi interrompido' : 'O teste não foi pedido'}</b>
                <span>{andamento}</span>
              </div>
            </div>
          ) : (
            <div className="politica">
              <Icone nome={t.status === 'encerrado' ? 'pause' : 'check'} />
              <span>{andamento}</span>
            </div>
          )}
        </div>
      )}

      <div className="secao">
        <p className="rotulo-marca">Os pedidos por bairro, nas {REGION_TEST_WEEKS_BEFORE} semanas de antes</p>
        <div className="r8-envolve">
          <table className="tabela r8-tabela r8-ab">
            <caption className="sr-only">Os pedidos de entrega por semana no caixa, por bairro, nas {REGION_TEST_WEEKS_BEFORE} semanas antes do pedido</caption>
            <thead>
              <tr>
                <th scope="col">Bairro</th>
                <th scope="col" className="n">
                  Antes (por semana)
                </th>
              </tr>
            </thead>
            <tbody>
              {bairros.map((b) => (
                <tr key={b.nome}>
                  <th scope="row" className={b.alvo ? 'r8-frente' : undefined}>
                    {b.nome}
                    <small>{b.alvo ? 'o bairro do teste' : 'segue com anúncio, para comparar'}</small>
                  </th>
                  <td className={b.alvo ? 'n r8-frente' : 'n'}>{b.porSemana}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="nota">
          <Icone nome="info" pequeno />
          <span>Do caixa da loja (o Regem), por bairro de entrega, {semanasDoTeste(t)}.</span>
        </p>
      </div>

      {pendente && (
        <div className="secao">
          <BotaoDetalhes aberto={detalhes} controla={`${ids}-detalhes`} aoAlternar={() => setDetalhes((v) => !v)} />
        </div>
      )}
      {pendente && (
        <div id={`${ids}-detalhes`} hidden={!detalhes}>
          <div className="secao">
            <p className="rotulo-marca">O que o Liame muda na Meta</p>
            <p className="nota">
              <Icone nome="megaphone" pequeno />
              <span>{conjuntosDoTesteDeRegiao(t)}</span>
            </p>
            <p className="nota">
              <Icone nome="shield" pequeno />
              <span>O Liame não muda campanha criada fora dele: se houvesse uma mostrando anúncio no bairro, o teste nem seria pedido.</span>
            </p>
            <p className="nota">
              <Icone nome="clock" pequeno />
              <span>Por enquanto, aprovar só deixa o teste pronto: tirar o bairro dos anúncios e devolvê-lo entram numa próxima etapa do Liame. Até lá, nada muda na Meta.</span>
            </p>
          </div>
          <div className="secao">
            <p className="rotulo-marca">Risco e limites</p>
            <div className="politica">
              <Icone nome="shield" />
              <span>
                <b className={`risco risco--${risco}`}>{ROTULO_RISCO[risco]}.</b> Não gasta mais, mas o teste tem um custo: nos {t.days} dias, {t.district.name} pode vender menos. É o preço de saber quanto o anúncio vale ali.
              </span>
            </div>
            <p className="nota">
              <Icone nome="chart" pequeno />
              <span>
                Só entra bairro com pelo menos {REGION_TEST_MIN_WEEKLY_ORDERS} pedidos por semana e com {REGION_TEST_MIN_OTHER_DISTRICTS} ou mais bairros para comparar: abaixo disso a conta não diz nada.
              </span>
            </p>
            <p className="nota">
              <Icone nome="clock" pequeno />
              <span>O Liame não espia: a conta só sai com os {t.days} dias completos, e vem em faixa (“entre 4 e 16 pedidos por semana”), nunca num número seco.</span>
            </p>
            <p className="nota">
              <Icone nome="shield" pequeno />
              <span>Um teste por vez na marca, de região ou de criativo.</span>
            </p>
          </div>
        </div>
      )}

      {resultado && (
        <div className="secao">
          <div className="politica">
            <Icone nome={resultado.ok ? 'check' : 'x'} />
            <span>{resultado.texto}</span>
          </div>
        </div>
      )}

      {pendente &&
        (podeDecidir ? (
          <BarraDaDecisao
            key={`${acao.id}:${acao.plan_hash}`}
            ids={ids}
            temApp={temApp}
            temChave={temChave}
            campoCodigo={campoCodigo}
            motivos={MOTIVOS}
            dica="O código de 6 números que o app autenticador mostra agora. A aprovação deixa o teste pronto; nada muda na Meta por enquanto."
            aoAprovar={(prova) => aoAprovar(acao, prova)}
            aoRecusar={(motivo) => aoRecusar(acao, motivo)}
          />
        ) : (
          <p className="nota ap-so-leitura">
            <Icone nome="lock" />
            <span>Só quem pode aprovar decide este pedido. Você acompanha por aqui.</span>
          </p>
        ))}
    </>
  );
}
