'use client';

import type { AgencyBrandResponse, AgencyReportsResponse } from '@liame/contracts';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Estado } from '@/components/ui/estado';
import { Icone } from '@/components/ui/icone';
import { api, chamar, mensagemDe, type Problema } from '@/lib/api';
import { disparar } from '@/lib/disparar';
import { iniciais } from '@/lib/formato';
import { useSessao } from '@/lib/sessao';
import { contagemDosRelatorios, mesDoTitulo, nomeDaLinha, situacaoDoRelatorio } from './relatorios-textos';

// Relatórios (P29 aprovado; A7, W7, parte 5b): o relatório do mês de cada marca de cada cliente, com a situação dele.
// Quem está no time do cliente revisa, escreve o comentário e manda; o membro vê só os clientes em que está.

type Estado = { tipo: 'carregando' } | { tipo: 'ok'; dados: AgencyReportsResponse } | { tipo: 'erro'; problema: Problema };

export function RelatoriosTela() {
  const { pode } = useSessao();
  const [estado, setEstado] = useState<Estado>({ tipo: 'carregando' });
  const [marca, setMarca] = useState<AgencyBrandResponse | null>(null);
  const cuida = pode('agencia.clientes');

  const carregar = useCallback(async () => {
    const r = await chamar(() => api.GET('/v1/agency/reports'));
    setEstado(r.ok ? { tipo: 'ok', dados: r.data } : { tipo: 'erro', problema: r.problema });
  }, []);

  useEffect(() => {
    if (!pode('agencia.ver')) return;
    disparar(carregar());
    // Sem logo, a faixa do alto lembra quem cuida da marca de pôr o logo (P29).
    if (pode('agencia.clientes')) disparar(chamar(() => api.GET('/v1/agency/brand')).then((r) => r.ok && setMarca(r.data)));
  }, [carregar, pode]);

  if (!pode('agencia.ver')) {
    return (
      <Estado icone="lock" titulo="Esta tela é de quem está numa agência">
        Os relatórios dos clientes aparecem aqui com a agência ativa no seletor do alto do menu.
      </Estado>
    );
  }
  const dados = estado.tipo === 'ok' ? estado.dados : null;

  return (
    <section aria-labelledby="h-relatorios">
      <div className="view-cab anima" style={{ ['--i' as string]: 0 }}>
        <div>
          <h1 id="h-relatorios" tabIndex={-1}>
            Relatórios
          </h1>
          <p>O relatório do mês de cada cliente fica pronto no dia 1º. Revise, escreva o seu comentário e mande ao cliente, com o nome e o logo da agência.</p>
        </div>
      </div>

      {cuida && marca && !marca.logo && (
        <div className="faixa faixa--atencao">
          <span className="faixa-ic">
            <Icone nome="alert" />
          </span>
          <span className="faixa-txt">
            <b>Os seus relatórios saem sem o logo da agência</b>
            <span>Sem logo, o relatório mostra as iniciais e o e-mail, só o nome. Ponha o logo em A marca da agência.</span>
          </span>
          <Link className="btn btn--sm" href="/agencia/marca">
            Pôr o logo
          </Link>
        </div>
      )}

      {estado.tipo === 'carregando' && (
        <p className="sr-only" role="status">
          Carregando os relatórios…
        </p>
      )}
      {estado.tipo === 'erro' && (
        <Estado
          icone="alert"
          perigo
          titulo="Não deu para carregar os relatórios"
          acao={
            <button className="btn" type="button" onClick={() => disparar(carregar())}>
              <Icone nome="refresh" />
              Tentar de novo
            </button>
          }
        >
          {mensagemDe(estado.problema)}
        </Estado>
      )}

      {dados && dados.items.length > 0 && (
        <article className="card" aria-labelledby="rl-t">
          <div className="card-cab">
            <div>
              <h2 id="rl-t">{mesDoTitulo(dados.month)}</h2>
              <p className="card-sub">{contagemDosRelatorios(dados.items)}</p>
            </div>
          </div>
          <ul className="rel-lista">
            {dados.items.map((i) => {
              const s = situacaoDoRelatorio(i, cuida);
              const n = nomeDaLinha(i);
              const destino = i.report_id ? `/agencia/relatorios/revisar?vinculo=${i.link_id}&relatorio=${i.report_id}` : null;
              return (
                <li className="rel-item" key={`${i.link_id}-${i.brand?.id ?? 'sem-marca'}`}>
                  <span className="rel-av" aria-hidden="true">
                    {iniciais(n.nome)}
                  </span>
                  <div className="rel-txt">
                    <b>
                      {n.nome}
                      {n.empresa && <small> · {n.empresa}</small>}
                    </b>
                    <span className={`st st--${s.tom}`}>
                      <span className="dot" aria-hidden="true" />
                      {s.rotulo}
                    </span>
                    {s.texto && <span className="rel-frase">{s.texto}</span>}
                  </div>
                  {destino && s.acao && (
                    <div className="rel-acoes">
                      <Link className={`btn btn--sm${s.acao === 'revisar' ? ' btn--primary' : ''}`} href={destino}>
                        {s.acao === 'revisar' ? 'Revisar e mandar' : 'Ver'}
                      </Link>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </article>
      )}

      {dados && !dados.items.length && (
        <div className="card vazio">
          <span className="pessoa-av pessoa-av--ag" aria-hidden="true">
            <Icone nome="file" />
          </span>
          <h2>{cuida ? 'Nenhum cliente ainda' : 'Você ainda não está em nenhum cliente'}</h2>
          <p className="lite-frase">
            {cuida
              ? 'Os relatórios aparecem aqui quando um cliente aceitar o pedido da agência.'
              : 'A dona ou um administrador da agência coloca você nos clientes em que vai trabalhar.'}
          </p>
          {cuida && (
            <Link className="btn btn--primary" href="/agencia/clientes">
              Ir para Clientes
            </Link>
          )}
        </div>
      )}
    </section>
  );
}
