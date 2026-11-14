'use client';

import type { ActionResponse, RegionRhythmDetailResponse } from '@liame/contracts';
import { type RefObject, useCallback, useEffect, useId, useState } from 'react';
import { BotaoDetalhes } from '@/components/resultados/pecas';
import { Icone } from '@/components/ui/icone';
import { api, chamar, mensagemDe, type Problema } from '@/lib/api';
import type { Prova } from '@/lib/chave-de-acesso';
import { disparar } from '@/lib/disparar';
import { reaisDeMicros } from '@/lib/formato';
import { BarraDaDecisao, type Decisao } from './barra-da-decisao';
import { campanhaNoRitmo, diaEscrito, diaMes, fraseDoRitmo, idDoRitmo, porqueDoDia, quandoEscrito, situacaoDoRitmo, tituloDoRitmo, trilhaDoRitmo, variacaoDoDia } from './ritmo-textos';
import { cabecalhoDe, type Grupo, MOTIVOS_DA_RECUSA, politicaDe, prazoDe, resultadoDe, riscoDe, ROTULO_RISCO } from './textos';

// O pedido "Ritmo da semana" em Aprovações (plano da região, R7, parte 1b-3; protótipo aprovado pelo dono em
// 13/11/2026, D-RG-58 a D-RG-65 e D-RG-68 a D-RG-72). O Gestor de tráfego monta a verba de cada dia das campanhas da
// Meta, por regra e sem IA; a pessoa aprova uma vez, com o código do app, e a aprovação vale para os 7 dias. A tela
// mostra o ritmo dia a dia com o porquê, a verba de cada campanha, o caminho (o que o Liame já fez em cada dia), a
// campanha que saiu do ritmo e "Parar o ritmo", que não pede o código. Nesta parte o ritmo mexe só na verba do dia: o
// horário (ligar e pausar os anúncios) é a parte 2.

type Props = {
  acao: ActionResponse;
  grupo: Grupo | null;
  agora: Date;
  podeDecidir: boolean;
  podeOperar: boolean;
  temApp: boolean;
  temChave?: boolean;
  titulo: RefObject<HTMLHeadingElement | null>;
  campoCodigo: RefObject<HTMLInputElement | null>;
  aoVoltar: () => void;
  aoAprovar: (acao: ActionResponse, prova: Prova) => Promise<Decisao>;
  aoRecusar: (acao: ActionResponse, motivo: string) => Promise<Decisao>;
};

type Lido = { estado: 'lendo' } | { estado: 'ok'; r: RegionRhythmDetailResponse } | { estado: 'erro'; problema: Problema };

const MOTIVOS = MOTIVOS_DA_RECUSA.map((m) => ({ valor: m, rotulo: m }));
const reais = (micros: number) => reaisDeMicros(BigInt(micros));
const ICONE_DO_PASSO = { ok: 'check', espera: 'clock', falha: 'x', depois: 'chevron-right' } as const;

export function DetalheRitmo({ acao, grupo, agora, podeDecidir, podeOperar, temApp, temChave = false, titulo, campoCodigo, aoVoltar, aoAprovar, aoRecusar }: Props) {
  const ids = useId();
  const id = idDoRitmo(acao.resource_id);
  const [lido, setLido] = useState<Lido>({ estado: 'lendo' });
  const [detalhes, setDetalhes] = useState(false);
  const [parando, setParando] = useState<'nao' | 'confirmar' | 'enviando'>('nao');
  const [erroParar, setErroParar] = useState<string | null>(null);
  const cab = cabecalhoDe(acao, agora);

  const ler = useCallback(async () => {
    if (!id) return;
    const r = await chamar(() => api.GET('/v1/region/rhythms/{id}', { params: { path: { id } } }));
    setLido(r.ok ? { estado: 'ok', r: r.data } : { estado: 'erro', problema: r.problema });
  }, [id]);

  useEffect(() => {
    setLido({ estado: 'lendo' });
    setParando('nao');
    setErroParar(null);
    disparar(ler());
  }, [ler, acao.status, acao.updated_at]);

  async function parar() {
    if (!id) return;
    setParando('enviando');
    setErroParar(null);
    const r = await chamar(() => api.POST('/v1/region/rhythm/{id}/stop', { params: { path: { id } } }));
    setParando('nao');
    if (!r.ok) return setErroParar(mensagemDe(r.problema));
    await ler();
  }

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
          <b>Gestor de tráfego</b> {cab.verbo}
        </span>
        <span>· {cab.quando} · por regra, sem IA: os pedidos da loja, a previsão do tempo e as datas</span>
      </div>
      <h2 className="det-titulo" id="ap-det-titulo" ref={titulo} tabIndex={-1}>
        {lido.estado === 'ok' ? tituloDoRitmo(lido.r.week) : 'Ritmo da semana'}
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
          <span>O pedido não aponta para um ritmo da semana do Liame.</span>
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
              <span>Não foi possível abrir o ritmo. {mensagemDe(lido.problema)}</span>
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
            <p className="sr-only">Abrindo o ritmo…</p>
            <span className="esqueleto esqueleto--curto" aria-hidden="true" />
            <span className="esqueleto" aria-hidden="true" />
          </div>
        )}
      </>
    );
  }

  const r = lido.r;
  const pendente = grupo === 'pendente' && r.status === 'pedido';
  const situacao = situacaoDoRitmo(r);
  const risco = riscoDe(acao);
  const frase = fraseDoRitmo(r);
  const rodando = r.status === 'aprovado';
  const naSemana = rodando && r.today >= r.week.from && r.today <= r.week.to;
  const fora = r.campaigns.filter((c) => c.state === 'fora');
  const comNota = r.campaigns.map((c) => ({ c, s: campanhaNoRitmo(c) })).filter((x) => x.s?.nota);
  const n = r.campaigns.length;
  const campanhas = n === 1 ? 'a campanha' : `as ${n} campanhas`;

  const tabelaDosDias = (
    <div className="secao">
      <p className="rotulo-marca">O ritmo, dia a dia</p>
      <div className="r7-envolve">
        <div className="table-wrap">
          <table className="tabela r7-tabela">
            <caption className="sr-only">O ritmo da semana, dia a dia: a verba do dia e por quê</caption>
            <thead>
              <tr>
                <th scope="col">Dia</th>
                <th scope="col">Verba do dia</th>
                <th scope="col">Por quê</th>
              </tr>
            </thead>
            <tbody>
              {r.days.map((d) => {
                const hoje = rodando && d.day === r.today;
                const variacao = variacaoDoDia(d.weight);
                return (
                  <tr key={d.day} className={hoje ? 'r7-hoje' : undefined}>
                    <th scope="row" className="r7-dia">
                      {diaEscrito(d.day, d.weekday)}
                      {hoje && <small>hoje</small>}
                    </th>
                    <td className="r7-verba" data-col="Verba do dia">
                      <b>{reais(d.total_micros)}</b> <span className={`r7-var${variacao.tom === 'igual' ? '' : ` r7-var--${variacao.tom}`}`}>{variacao.texto}</span>
                      <small>hoje: {reais(r.base_micros)} por dia</small>
                    </td>
                    <td data-col="Por quê">
                      <ul className="r7-porques">
                        {d.reasons.map((q, i) => {
                          const p = porqueDoDia(q);
                          return (
                            // biome-ignore lint/suspicious/noArrayIndexKey: os porquês de um dia não mudam de ordem nem têm chave própria
                            <li key={i}>
                              <Icone nome={p.icone} />
                              <span>{p.texto}</span>
                            </li>
                          );
                        })}
                      </ul>
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row">A semana</th>
                <td data-col="Verba dos 7 dias">
                  <b>{reais(r.week_micros)}</b>
                  <small>sem o ritmo: {reais(r.base_week_micros)}</small>
                </td>
                <td data-col="">O ritmo muda o dia, não o total: o que sai dos dias fracos vai para os fortes.</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
      <p className="nota">
        <Icone nome="info" pequeno />
        <span>A verba muda no máximo 10% de um dia para o outro: por isso ela começa a subir antes do dia forte, e desce aos poucos depois dele.</span>
      </p>
    </div>
  );

  const porCampanha = (
    <div className="secao">
      <p className="rotulo-marca">Campanha por campanha</p>
      <div className="r7-envolve">
        <div className="table-wrap">
          <table className="tabela r7-tabela r7-camp">
            <caption className="sr-only">A verba de cada campanha em cada dia do ritmo</caption>
            <thead>
              <tr>
                <th scope="col">Campanha</th>
                <th scope="col">Hoje</th>
                {r.days.map((d) => (
                  <th scope="col" key={d.day}>
                    {diaEscrito(d.day, d.weekday).slice(0, 3)}
                  </th>
                ))}
                <th scope="col">Semana</th>
              </tr>
            </thead>
            <tbody>
              {r.campaigns.map((c) => {
                const s = campanhaNoRitmo(c);
                return (
                  <tr key={c.resource}>
                    <th scope="row">
                      {c.name}
                      {s && r.status !== 'pedido' && <span className={`st st--${s.tom} r7-estado`}>{s.rotulo}</span>}
                    </th>
                    <td data-col="Hoje">{reais(c.base_micros)}</td>
                    {r.days.map((d, i) => (
                      <td data-col={diaEscrito(d.day, d.weekday).slice(0, 3)} key={d.day}>
                        {reais(c.days_micros[i] ?? 0)}
                      </td>
                    ))}
                    <td data-col="Semana">{reais(c.week_micros)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
      {r.out.length > 0 && (
        <p className="nota">
          <Icone nome="info" pequeno />
          <span>
            {r.out.length === 1 ? 'Uma campanha ficou fora' : `${r.out.length} campanhas ficaram fora`} do ritmo: {r.out.map((o) => `${o.name} (${FORA[o.reason] ?? 'não coube nas regras'})`).join('; ')}.
          </span>
        </p>
      )}
    </div>
  );

  const resultado = !pendente && (r.status === 'cancelado' || r.status === 'pedido') ? resultadoDe(acao) : null;

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
            {frase.dias} <b>{frase.semana}</b> Se você aprovar, o Liame muda a verba d{campanhas} no começo de cada dia.
          </p>
          <div className="lite-chips">
            <span className="lite-chip">A soma das verbas da semana não aumenta</span>
            <span className="lite-chip">Dá para parar a qualquer hora</span>
            <span className="lite-chip">vale até {diaMes(r.week.to)}</span>
          </div>
        </div>
      )}

      {resultado && (
        <div className="secao">
          <div className="politica">
            <Icone nome={resultado.ok ? 'check' : 'x'} />
            <span>{resultado.texto} Nada mudou nas campanhas. O Gestor de tráfego monta outro ritmo no domingo.</span>
          </div>
        </div>
      )}

      {rodando && (
        <div className="secao">
          <div className="politica">
            <Icone nome="check" />
            <span>
              <b>
                Aprovado{r.approved_by ? ` por ${r.approved_by.name}` : ''}
                {r.approved_at ? ` em ${quandoEscrito(r.approved_at)}` : ''}.
              </b>{' '}
              {r.today < r.week.from
                ? `O ritmo começa em ${diaMes(r.week.from)}: o Liame muda a verba no começo de cada dia.`
                : naSemana
                  ? 'O ritmo está rodando: o Liame muda a verba no começo de cada dia.'
                  : 'A semana acabou: a verba está voltando à de antes, em até 10% por dia.'}
            </span>
          </div>
          {fora.map((c) => (
            <div className="pd-aviso pd-aviso--perigo" role="alert" key={c.resource}>
              <Icone nome="alert-circle" />
              <div>
                <b>A campanha “{c.name}” saiu do ritmo</b>
                <span>{campanhaNoRitmo(c)?.nota}</span>
                {n - fora.length > 0 && <span>{n - fora.length === 1 ? 'A outra campanha segue' : `As outras ${n - fora.length} campanhas seguem`} no ritmo.</span>}
              </div>
            </div>
          ))}
          {podeOperar && naSemana && (
            <>
              <div className="r7-acoes">
                {parando === 'nao' ? (
                  <button className="btn" type="button" onClick={() => setParando('confirmar')} aria-describedby={`${ids}-parar-d`}>
                    <Icone nome="pause" />
                    Parar o ritmo
                  </button>
                ) : (
                  <>
                    <button className="btn btn--primary" type="button" onClick={() => disparar(parar())} disabled={parando === 'enviando'} aria-describedby={`${ids}-parar-d`}>
                      <Icone nome="pause" />
                      {parando === 'enviando' ? 'Parando…' : 'Parar o ritmo desta semana'}
                    </button>
                    <button className="btn btn--ghost" type="button" onClick={() => setParando('nao')} disabled={parando === 'enviando'}>
                      Deixar rodando
                    </button>
                  </>
                )}
              </div>
              <p className="campo-dica" id={`${ids}-parar-d`}>
                Parar devolve a verba de antes a cada campanha, em até 10% por dia. Não precisa do código: parar só devolve a verba que cada campanha já tinha. Outro ritmo, só na semana que vem.
              </p>
              {erroParar && (
                <p className="campo-erro" role="alert">
                  {erroParar}
                </p>
              )}
            </>
          )}
        </div>
      )}

      {(r.status === 'parado' || r.status === 'encerrado') && (
        <div className="secao">
          <div className="politica">
            <Icone nome={r.status === 'parado' ? 'pause' : 'check'} />
            <span>
              {r.status === 'parado' ? (
                <b>
                  Parado{r.stopped_by ? ` por ${r.stopped_by.name}` : ''}
                  {r.stopped_at ? ` em ${quandoEscrito(r.stopped_at)}` : ''}.
                </b>
              ) : (
                <b>A semana deste ritmo acabou.</b>
              )}{' '}
              {r.campaigns.some((c) => c.state === 'voltando')
                ? 'A verba está voltando à de antes, em até 10% por dia.'
                : `A verba voltou à de antes: ${r.campaigns.filter((c) => c.state !== 'fora').map((c) => `${c.name} ${reais(c.base_micros)}`).join(', ')}.`}{' '}
              O Gestor de tráfego monta outro ritmo no domingo; ele só roda com outra aprovação.
            </span>
          </div>
        </div>
      )}

      {r.status !== 'pedido' && r.status !== 'cancelado' && comNota.filter((x) => x.c.state !== 'fora' || !rodando).length > 0 && (
        <div className="secao">
          <p className="rotulo-marca">Como está cada campanha</p>
          {comNota
            .filter((x) => x.c.state !== 'fora' || !rodando)
            .map(({ c, s }) => (
              <p className="nota" key={c.resource}>
                <Icone nome={s?.tom === 'perigo' ? 'alert-circle' : 'info'} pequeno />
                <span>
                  <b>{c.name}:</b> {s?.nota}
                </span>
              </p>
            ))}
        </div>
      )}

      {r.status !== 'pedido' && r.status !== 'cancelado' && (
        <div className="secao">
          <p className="rotulo-marca">O caminho do ritmo</p>
          <ol className="trilha-pedido">
            {trilhaDoRitmo(r).map((p) => (
              <li key={p.titulo}>
                <span className={`passo${p.estado === 'ok' ? '' : ` passo--${p.estado}`}`} aria-hidden="true">
                  <Icone nome={ICONE_DO_PASSO[p.estado]} />
                </span>
                <span>
                  <b>{p.titulo}</b>
                  {p.sub && <small>{p.sub}</small>}
                </span>
              </li>
            ))}
          </ol>
        </div>
      )}

      {tabelaDosDias}

      {pendente && (
        <div className="secao">
          <BotaoDetalhes aberto={detalhes} controla={`${ids}-detalhes`} aoAlternar={() => setDetalhes((v) => !v)} />
        </div>
      )}
      <div id={`${ids}-detalhes`} hidden={pendente && !detalhes}>
        {porCampanha}
        {pendente && (
          <div className="secao">
            <p className="rotulo-marca">Risco e limites</p>
            <div className="politica">
              <Icone nome="shield" />
              <span>
                <b className={`risco risco--${risco}`}>{ROTULO_RISCO[risco]}.</b> Muda a verba d{campanhas} todo dia, mas a soma das verbas da semana não aumenta ({reais(r.week_micros)}, contra {reais(r.base_week_micros)} sem o ritmo)
                {r.ceiling_micros !== null ? `, e nenhum dia passa do teto por campanha (${reais(r.ceiling_micros)} por dia)` : ''}. O gasto de cada dia é a Meta que decide: ela pode passar da verba num dia e compensar em outro. O
                Liame confere os 7 dias e avisa na Atenção se o gasto passar da soma. {politicaDe(acao)}
              </span>
            </div>
            {LIMITES.map(([icone, texto]) => (
              <p className="nota" key={texto}>
                <Icone nome={icone} pequeno />
                <span>{texto}</span>
              </p>
            ))}
            <p className="nota">
              <Icone nome="clock" pequeno />
              <span>
                Aprovado depois que a semana começou, vale só para os dias que faltam. Depois de {diaMes(r.week.to)}, a verba volta à de antes; outro ritmo, só com outra aprovação. Prazo deste pedido: {prazoDe(acao, agora)}.
              </span>
            </p>
          </div>
        )}
      </div>

      {pendente &&
        (podeDecidir ? (
          <BarraDaDecisao
            key={`${acao.id}:${acao.plan_hash}`}
            ids={ids}
            temApp={temApp}
            temChave={temChave}
            campoCodigo={campoCodigo}
            motivos={MOTIVOS}
            dica="O código de 6 números que o app autenticador mostra agora. Uma aprovação vale para os 7 dias deste ritmo."
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

/** Por que uma campanha ficou fora do ritmo, em palavras. */
const FORA: Record<string, string> = {
  verba_pequena: 'menos de R$ 10,00 por dia',
  fracao_de_centavo: 'a verba tem fração de centavo',
  acima_do_teto: 'já está acima do teto por campanha',
  fora_dos_limites: 'não coube nos limites do ritmo',
  teste_de_criativo: 'está num teste de criativo: mudar a verba de um lado estragaria a comparação',
};

/** Os limites que valem para o ritmo, na ordem do protótipo (sem o horário, que é a parte seguinte). */
const LIMITES = [
  ['target', 'Cada mudança segue os limites que já valem: no máximo 10% de um dia para o outro, e nunca mais de 20% acima ou abaixo da verba de hoje.'],
  ['shield', 'O aprovado é o teto de cada dia: o Liame pode fazer menos, nunca mais.'],
  ['check-circle', 'A Meta confere antes de cada mudança. Se ela recusar, a campanha fica como está e o motivo aparece aqui.'],
  ['alert-circle', 'Se alguém mudar a verba ou pausar uma campanha por fora, o ritmo dessa campanha para, e ela fica como a pessoa deixou. As outras seguem.'],
  ['wallet', 'Se a verba do mês ou o teto por campanha não deixarem um dia subir, a campanha sai do ritmo e volta à verba de antes.'],
  ['undo', 'Dá para parar a qualquer hora: “Parar o ritmo” devolve a verba de antes, em até 10% por dia, e não pede o código.'],
] as const;
