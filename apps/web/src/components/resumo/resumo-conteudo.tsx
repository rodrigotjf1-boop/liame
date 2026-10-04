'use client';

import type { SummaryResponse, TeamResponse } from '@liame/contracts';
import Link from 'next/link';
import { type FormEvent, type ReactNode, type Ref, useMemo, useState } from 'react';
import { useConversa } from '@/components/conversa/contexto';
import { IconeLia } from '@/components/marca/logo';
import { Icone } from '@/components/ui/icone';
import { ListaDeFontes, NumeroComFonte, TextoComNumeros, useFontes } from './numeros';
import { canaisDo, equipeDo, Fontes, hojeEscrito, pedidosDo, perguntasDoResumo, perguntasDoVeredito, precisaDe, primeiroNome, saudacao, type Stat, statsDo, vereditoDo } from './textos';

// O Resumo (A3 · P8, aprovado em 03/10/2026): a página inicial do Lite, a visão do dono. Os números são os de
// Resultados (`GET /v1/summary`), com a fonte de cada um; o que a equipe fez vem de `/v1/team`. Desenhado a
// partir dos dados prontos: o teste usa o mesmo componente.

type Props = {
  r: SummaryResponse;
  /** O que a equipe fez no mês; nulo sem a permissão ou se a leitura falhou (o cartão some). */
  equipe: TeamResponse | null;
  nomePessoa: string;
  nomeMarca: string | null;
  agora: Date;
  pode: (permissao: string) => boolean;
  /** Seletor de marca, quando a empresa tem mais de uma. */
  seletor?: ReactNode;
  tituloRef?: Ref<HTMLHeadingElement>;
};

export function ResumoConteudo({ r, equipe, nomePessoa, nomeMarca, agora, pode, seletor, tituloRef }: Props) {
  const fuso = r.period.timezone;
  const dados = useMemo(() => {
    const fontes = new Fontes();
    // A ordem das linhas em "De onde vêm os números" é a ordem em que os números aparecem na tela.
    const stats = statsDo(r, fontes, agora);
    const pedidos = pedidosDo(r, fontes);
    const canais = canaisDo(r, fontes);
    return { lista: fontes.lista, stats, pedidos, canais };
  }, [r, agora]);
  const fontes = useFontes(dados.lista);
  const veredito = vereditoDo(r);
  // O que a pessoa decide: as ações e os planos, na tela Aprovações (de quem acompanha as campanhas); a promoção de um funcionário, em Sua equipe.
  const verCampanhas = pode('campanhas.ver');
  const itens = precisaDe(r, pode('vendas.ver'), pode('contas.ver'), {
    acoes: verCampanhas && pode('acoes.aprovar'),
    planos: verCampanhas && pode('planos.decidir'),
    autonomia: verCampanhas && pode('politicas.gerenciar'),
  });
  const linhasDaEquipe = equipe ? equipeDo(equipe) : [];
  const primeira = r.state === 'primeira_semana';
  const semRegem = r.state === 'sem_regem';
  const aoTocar = fontes.mostrar;
  const convite = pode('pessoas.convidar');
  // A conversa com a LIA é do shell: fora dele (ou sem a permissão), os atalhos para ela não aparecem.
  const conversa = useConversa();
  const [pergunta, setPergunta] = useState('');
  const doVeredito = conversa.disponivel ? perguntasDoVeredito(r) : [];
  function perguntar(evento: FormEvent) {
    evento.preventDefault();
    const t = pergunta.trim();
    if (!t) return;
    setPergunta('');
    conversa.abrir({ pergunta: t });
  }
  const nf = (texto: Parameters<typeof TextoComNumeros>[0]['texto']) => <TextoComNumeros texto={texto} lista={dados.lista} aoTocar={aoTocar} />;

  return (
    <div className="resumo-corpo">
      <div className="dono-topo">
        <p className="rotulo-marca">
          {hojeEscrito(agora, fuso)}
          {nomeMarca ? ` · ${nomeMarca}` : ''}
        </p>
        <h1 id="h-resumo" tabIndex={-1} ref={tituloRef}>
          {saudacao(agora, fuso)}, {primeiroNome(nomePessoa)}.{' '}
          <span className="sub">{primeira ? 'Os primeiros 7 dias completos ainda não fecharam.' : 'Assim foi o seu marketing nos últimos 7 dias.'}</span>
        </h1>
        {seletor}
      </div>

      <div className="stats3" role="group" aria-label="O dinheiro do marketing nos últimos 7 dias">
        {dados.stats.map((s) => (
          <CartaoStat key={s.id} s={s} lista={dados.lista} aoTocar={aoTocar} />
        ))}
      </div>

      <div className="dono-veredito">
        <p className="lite-frase lite-frase--grande">{nf(veredito.frase)}</p>
        {veredito.conectarRegem && pode('contas.ver') && (
          <div className="ia-linha">
            <Link className="btn btn--primary" href="/contas">
              <Icone nome="plug" />
              Conectar o Regem
            </Link>
          </div>
        )}
        {doVeredito.length > 0 && (
          <div className="ia-linha" role="group" aria-label="Perguntar à LIA sobre a semana">
            {doVeredito.map((q) => (
              <button className="ia-bt" type="button" key={q} onClick={() => conversa.abrir({ pergunta: q })}>
                <Icone nome="sparkles" />
                {q}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="resumo-grid">
        <article className={conversa.disponivel ? 'card r-precisa r-precisa--com-lia' : 'card r-precisa'} aria-labelledby="rp-t">
          <div className="card-cab">
            <div>
              <h2 id="rp-t">Precisa de você</h2>
              <p className="card-sub">{itens.length ? 'Do que pode custar mais para o que pode custar menos.' : 'Tudo em dia.'}</p>
            </div>
            {itens.length > 0 && pode('campanhas.ver') && (
              <Link className="btn btn--ghost btn--sm" href="/atencao">
                Ver todos os avisos
              </Link>
            )}
          </div>
          {itens.length ? (
            <ul className="dono-lista">
              {itens.map((i) => (
                <li className="dono-item" key={i.chave}>
                  <span className={`dono-sev dono-sev--${i.gravidade}`} aria-hidden="true" />
                  <div>
                    <p className="dono-tit">
                      <span className="sr-only">{i.falado}: </span>
                      {i.titulo}
                    </p>
                    <p className="dono-sub">{nf(i.sub)}</p>
                  </div>
                  {i.botao && (
                    <Link className={i.botao.primario ? 'btn btn--primary btn--sm' : 'btn btn--sm'} href={i.botao.href}>
                      {i.botao.rotulo}
                      <span className="sr-only">: {i.titulo}</span>
                    </Link>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <div className="r-vazio">
              <p className="dono-tit">
                <Icone nome="check-circle" pequeno /> Nada precisa de você agora
              </p>
              <p className="card-sub">Quando algo sair do normal nas contas, nas campanhas ou nas vendas, ou quando a equipe pedir o seu ok, aparece aqui.</p>
            </div>
          )}
        </article>

        {conversa.disponivel && (
          <article className="card r-lia" aria-labelledby="rl-t">
            <div className="card-cab">
              <div>
                <h2 id="rl-t">Pergunte à LIA</h2>
                <p className="card-sub">Ela responde em palavras simples, com os números por trás.</p>
              </div>
              <IconeLia />
            </div>
            <form className="pergunte" onSubmit={perguntar}>
              <label className="sr-only" htmlFor="in-pergunte">
                Pergunta para a LIA
              </label>
              <input className="input" id="in-pergunte" autoComplete="off" maxLength={2000} placeholder="Ex.: por que sobrou pouco esta semana?" value={pergunta} onChange={(e) => setPergunta(e.target.value)} />
              <button className="btn btn--primary btn--icon" type="submit" aria-label="Perguntar à LIA">
                <Icone nome="send" />
              </button>
            </form>
            <div className="ia-linha" role="group" aria-label="Perguntas prontas">
              {perguntasDoResumo(r).map((q) => (
                <button className="ia-bt" type="button" key={q} onClick={() => conversa.abrir({ pergunta: q })}>
                  <Icone nome="sparkles" />
                  {q}
                </button>
              ))}
            </div>
            <p className="explica-nota">A LIA é uma assistente de IA. Ela lê os números do sistema; quem decide é você.</p>
          </article>
        )}

        <article className="card r-pedidos" aria-labelledby="rpd-t">
          <div className="card-cab">
            <div>
              <h2 id="rpd-t">Seus pedidos</h2>
              <p className="card-sub">Confirmados no caixa do Regem.</p>
            </div>
          </div>
          {dados.pedidos ? (
            <dl className="mini-stats">
              {dados.pedidos.map((m) => (
                <div key={m.rotulo}>
                  <dt>{m.rotulo}</dt>
                  <dd>
                    <NumeroComFonte num={m.valor} lista={dados.lista} aoTocar={aoTocar} />
                  </dd>
                </div>
              ))}
            </dl>
          ) : (
            <p className="card-sub">{semRegem ? 'Os pedidos vêm do caixa do Regem.' : 'Ainda sem 7 dias completos de pedidos.'}</p>
          )}
        </article>

        <article className="card r-canais" aria-labelledby="rcn-t">
          <div className="card-cab">
            <div>
              <h2 id="rcn-t">De onde vieram os pedidos</h2>
              <p className="card-sub">E quanto sobrou em cada canal.</p>
            </div>
          </div>
          {dados.canais && dados.canais.canais.length ? (
            <>
              <ul className="canais">
                {dados.canais.canais.map((c) => (
                  <li key={c.provider}>
                    <div className="canal-linha">
                      <span className="canal-nome">{c.nome}</span>
                      <span className="canal-num">
                        <NumeroComFonte num={c.pedidos} lista={dados.lista} aoTocar={aoTocar} /> pedidos
                      </span>
                    </div>
                    <div className="canal-barra" role="img" aria-label={c.falado}>
                      <span style={{ width: `${c.parte}%` }} />
                    </div>
                    <p className="canal-sub">{nf(c.sub)}</p>
                  </li>
                ))}
              </ul>
              <p className="eixo-nota">
                Mais <NumeroComFonte num={dados.canais.semOrigem} lista={dados.lista} aoTocar={aoTocar} /> pedidos do cardápio e do WhatsApp vieram sem origem provada.
              </p>
            </>
          ) : (
            <p className="card-sub">
              {semRegem
                ? 'Sem o Regem, os pedidos não chegam ao Liame.'
                : primeira
                  ? 'Os pedidos aparecem aqui depois dos primeiros 7 dias completos.'
                  : 'Nenhuma conta de anúncio conectada a esta marca.'}
            </p>
          )}
        </article>

        {equipe && (
          <article className={convite ? 'card r-equipe' : 'card r-equipe r-cheio'} aria-labelledby="re-t">
            <div className="card-cab">
              <div>
                <h2 id="re-t">O que a sua equipe fez</h2>
                <p className="card-sub">Neste mês. Cada funcionário é um assistente de IA ou uma regra do Liame. Ninguém mexeu em campanha.</p>
              </div>
              <Link className="btn btn--ghost btn--sm" href="/equipe">
                Ver a equipe
              </Link>
            </div>
            {linhasDaEquipe.length ? (
              <ul className="feito-lista">
                {linhasDaEquipe.map((l) => (
                  <li key={l.chave}>
                    <span className="av-func" aria-hidden="true">
                      <Icone nome={l.icone} />
                    </span>
                    <p>
                      <b>{l.nome}</b>
                      {l.sep}
                      {l.texto}
                    </p>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="card-sub">
                {equipe.ai.enabled ? 'A equipe ainda não trabalhou este mês.' : 'Os funcionários de IA começam a trabalhar quando a IA for ligada para a sua empresa.'}
              </p>
            )}
          </article>
        )}

        {convite && (
          <article className={equipe ? 'card r-cta' : 'card r-cta r-cheio'} aria-labelledby="rct-t">
            <span className="av-func av-func--lg" aria-hidden="true">
              <Icone nome="user-plus" />
            </span>
            <h2 id="rct-t">Quer alguém de confiança cuidando disso?</h2>
            <p className="lite-frase">Convide por e-mail uma agência, um consultor ou o seu gerente. A pessoa entra com o próprio login, dentro dos limites que você der, e você tira o acesso quando quiser.</p>
            <div className="ia-linha">
              <Link className="btn btn--primary" href="/pessoas">
                <Icone nome="user-plus" />
                Convidar uma pessoa
              </Link>
            </div>
          </article>
        )}
      </div>

      <ListaDeFontes lista={dados.lista} estado={fontes} />
    </div>
  );
}

function CartaoStat({ s, lista, aoTocar }: { s: Stat; lista: Parameters<typeof NumeroComFonte>[0]['lista']; aoTocar: (i: number) => void }) {
  const classe = `stat${s.foco ? ' stat--foco' : ''}${s.valor ? '' : ' stat--vazio'}`;
  return (
    <div className={classe}>
      <p className="stat-rot">{s.rotulo}</p>
      {s.valor ? (
        <p className="stat-val">
          <NumeroComFonte num={s.valor} lista={lista} aoTocar={aoTocar} />
        </p>
      ) : (
        <p className="stat-val stat-val--txt">{s.vazio}</p>
      )}
      {s.sub && (
        <p className={`stat-delta stat-delta--${s.sub.tom}`}>
          {s.sub.seta && <Icone nome={s.sub.seta === 'sobe' ? 'trend-up' : 'trend-down'} pequeno />}
          <span>
            <TextoComNumeros texto={s.sub.texto} lista={lista} aoTocar={aoTocar} />
          </span>
        </p>
      )}
    </div>
  );
}
