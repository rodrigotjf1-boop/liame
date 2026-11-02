'use client';

import type { AgencyReportDetailResponse } from '@liame/contracts';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { iniciaisDaAgencia } from '@/components/agencia/marca-textos';
import { periodoDoMes } from '@/components/relatorio/textos';
import { numerosDoPeriodo } from '@/components/revisao/graficos';
import { useAvisar } from '@/components/ui/avisos';
import { Estado } from '@/components/ui/estado';
import { Icone } from '@/components/ui/icone';
import { api, chamar, mensagemDe, type Problema } from '@/lib/api';
import { disparar } from '@/lib/disparar';
import { diaHora } from '@/lib/formato';
import { NIVEIS } from '@/lib/niveis';
import { useSessao } from '@/lib/sessao';
import { GavetaMandar } from './gaveta-mandar';
import { avisoDeMandado, nomeDoMes, pessoas } from './relatorios-textos';

// Revisar e mandar o relatório do mês de um cliente (P29 aprovado; A7, W7, parte 5b; D-A7-65): o alto do relatório com
// a marca da agência e o comentário (a prévia de como sai), os números e a leitura do mês, e, ao lado, o comentário e
// "Mandar ao cliente". Depois de mandar, quem recebeu, e "Mandar de novo" (a versão corrigida).

const MAX_COMENTARIO = 1000;

type Estado = { tipo: 'carregando' } | { tipo: 'ok'; detalhe: AgencyReportDetailResponse } | { tipo: 'erro'; problema: Problema };

export function RevisarRelatorioTela() {
  const params = useSearchParams();
  const vinculo = params.get('vinculo') ?? '';
  const relatorio = params.get('relatorio') ?? '';
  const { me, pode } = useSessao();
  const avisar = useAvisar();
  const ids = useId();
  const titulo = useRef<HTMLHeadingElement>(null);
  const [estado, setEstado] = useState<Estado>({ tipo: 'carregando' });
  const [comentario, setComentario] = useState('');
  const [mandando, setMandando] = useState(false);

  const carregar = useCallback(async () => {
    if (!vinculo || !relatorio) return setEstado({ tipo: 'erro', problema: { status: 404, code: 'nao-encontrado', title: 'Não encontramos', detail: 'Abra o relatório pela lista de Relatórios.' } });
    const r = await chamar(() => api.GET('/v1/agency/clients/{id}/reports/{reportId}', { params: { path: { id: vinculo, reportId: relatorio } } }));
    if (!r.ok) return setEstado({ tipo: 'erro', problema: r.problema });
    setEstado({ tipo: 'ok', detalhe: r.data });
    // O comentário começa como o do último envio (para corrigir e mandar de novo), ou vazio.
    setComentario(r.data.sends[0]?.comment ?? '');
  }, [vinculo, relatorio]);

  useEffect(() => {
    if (pode('agencia.ver')) disparar(carregar());
  }, [carregar, pode]);

  if (!pode('agencia.ver')) {
    return (
      <Estado icone="lock" titulo="Esta tela é de quem está numa agência">
        Os relatórios dos clientes aparecem com a agência ativa no seletor do alto do menu.
      </Estado>
    );
  }
  const voltar = (
    <Link className="btn btn--ghost btn--sm rel-voltar" href="/agencia/relatorios">
      <Icone nome="undo" pequeno />
      Voltar para os relatórios
    </Link>
  );
  if (estado.tipo === 'carregando') {
    return (
      <p className="sr-only" role="status">
        Carregando o relatório…
      </p>
    );
  }
  if (estado.tipo === 'erro') {
    return (
      <section aria-labelledby="h-rel-erro">
        {voltar}
        <Estado
          icone="alert"
          perigo
          titulo="Não deu para abrir o relatório"
          acao={
            <button className="btn" type="button" onClick={() => disparar(carregar())}>
              <Icone nome="refresh" />
              Tentar de novo
            </button>
          }
        >
          <span id="h-rel-erro">{mensagemDe(estado.problema)}</span>
        </Estado>
      </section>
    );
  }

  const d = estado.detalhe;
  const r = d.report;
  const marca = d.item.brand?.name ?? d.item.organization.name;
  const mes = nomeDoMes(r.month.from);
  const numeros = numerosDoPeriodo(r.totals, periodoDoMes(r));
  const ultimo = d.sends[0] ?? null;
  const assinatura = `${me.user.name}, ${d.agency.name}`;
  const leitura = r.reading.explanation.what_happened.map((t) => t.text).join('');

  return (
    <section aria-labelledby="h-relatorio-ag">
      {voltar}
      <div className="view-cab">
        <div>
          <h1 id="h-relatorio-ag" ref={titulo} tabIndex={-1}>
            Relatório de {mes}
          </h1>
          <p>
            {marca}
            {d.item.brand && d.item.brand.name !== d.item.organization.name ? ` · ${d.item.organization.name}` : ''} · {r.month.from.slice(8, 10)}/
            {r.month.from.slice(5, 7)} a {r.month.to.slice(8, 10)}/{r.month.to.slice(5, 7)}/{r.month.to.slice(0, 4)}
          </p>
        </div>
      </div>
      {d.item.state === 'suspensa' && (
        <div className="faixa faixa--perigo">
          <span className="faixa-ic">
            <Icone nome="lock" />
          </span>
          <span className="faixa-txt">
            <b>A conta da {d.item.organization.name} está suspensa</b>
            <span>O relatório fica só com o dono{d.item.owner_name ? `, ${d.item.owner_name},` : ''} até a conta voltar. Ninguém da agência manda.</span>
          </span>
        </div>
      )}
      <div className="rel-grid">
        <article className="card rel-doc" aria-labelledby={`${ids}-doc`}>
          <h2 className="sr-only" id={`${ids}-doc`}>
            O relatório
          </h2>
          <div className="rel-agencia-marca">
            {d.agency.logo_url ? (
              <img className="logo-ag-img" src={d.agency.logo_url} alt={`Logo da ${d.agency.name}`} />
            ) : (
              <span className="logo-ag logo-ag--vazio" aria-hidden="true">
                {iniciaisDaAgencia(d.agency.name)}
              </span>
            )}
            <span>
              <b>{d.agency.name}</b>
              <small>preparado por {d.agency.name}, com o Liame</small>
            </span>
          </div>
          {comentario.trim() && (
            <blockquote className="comentario-ag">
              <p>{comentario.trim()}</p>
              <footer>{ultimo && comentario === (ultimo.comment ?? '') && ultimo.sent_by_name ? `${ultimo.sent_by_name}, ${d.agency.name}` : assinatura}</footer>
            </blockquote>
          )}
          <div className="rel-numeros" role="group" aria-label="Números do mês">
            {numeros.map((k) => (
              <div className="kpi" key={k.id}>
                <p className="kpi-rot">{k.rotulo}</p>
                <p className="kpi-val num">{k.valor}</p>
                {k.mudou && <p className={`stat-delta stat-delta--${k.mudou.tom}`}>{k.mudou.texto}</p>}
              </div>
            ))}
          </div>
          <div className="rel-leitura">
            <h3>A leitura do mês</h3>
            <p>{leitura}</p>
            <p className="campo-dica">{r.reading.source === 'lia' ? 'Escrita pela LIA com os números do sistema.' : 'Escrita pelo sistema, sem IA.'}</p>
          </div>
          <p className="lite-frase">As outras partes (semana a semana, cada campanha, o que melhorou e o que piorou, a verba, a equipe e o mês que vem) vão como no relatório do mês, sem mudança.</p>
        </article>
        <aside className="rel-lado" aria-label="Mandar ao cliente">
          {ultimo && (
            <article className="card" aria-labelledby={`${ids}-env`}>
              <h2 className="card-titulo" id={`${ids}-env`}>
                Mandado ao cliente
              </h2>
              <div className="enviado">
                <span className="st st--concluido">
                  <span className="dot" aria-hidden="true" />
                  {ultimo.mode === 'sozinho' ? 'Saiu sozinho' : `Mandado por ${ultimo.sent_by_name ?? 'alguém da agência'}`} em {diaHora(ultimo.sent_at)}
                  {ultimo.version > 1 ? ', versão corrigida' : ''}
                </span>
                <span>Para {pessoas(ultimo.sent_to.length)}:</span>
                <ul>
                  {ultimo.sent_to.map((p) => (
                    <li key={`${p.name}-${p.role}`}>
                      {p.name} · {p.role === 'dono' ? 'Dono' : (NIVEIS[p.role as keyof typeof NIVEIS]?.nome ?? p.role)}
                    </li>
                  ))}
                </ul>
              </div>
              <p className="lite-frase">Quem recebeu este não recebe o e-mail do Liame de {mes}.</p>
            </article>
          )}
          {d.can_send && (
            <article className="card" aria-labelledby={`${ids}-com`}>
              <h2 className="card-titulo" id={`${ids}-com`}>
                {ultimo ? 'Corrigir e mandar de novo' : 'O seu comentário'}
              </h2>
              <div className="campo">
                <label htmlFor={`${ids}-c`}>
                  Comentário da agência <span className="campo-dica">(opcional)</span>
                </label>
                <textarea
                  className="input textarea"
                  id={`${ids}-c`}
                  maxLength={MAX_COMENTARIO}
                  rows={6}
                  value={comentario}
                  onChange={(e) => setComentario(e.target.value)}
                  aria-describedby={`${ids}-c-dica ${ids}-c-n`}
                />
                <span className="campo-dica" id={`${ids}-c-dica`}>
                  Aparece no alto do relatório e do e-mail, assinado por você. Os números e a leitura do mês não mudam.
                </span>
                <span className={`ag-contador${comentario.length >= MAX_COMENTARIO * 0.9 ? ' ag-contador--perto' : ''}`} id={`${ids}-c-n`}>
                  {comentario.length.toLocaleString('pt-BR')} de {MAX_COMENTARIO.toLocaleString('pt-BR')}
                </span>
              </div>
              <div className="lado-acoes">
                <button className={`btn${ultimo ? '' : ' btn--primary'}`} type="button" aria-haspopup="dialog" onClick={() => setMandando(true)}>
                  <Icone nome="send" />
                  {ultimo ? 'Mandar de novo' : 'Mandar ao cliente'}
                </button>
              </div>
            </article>
          )}
        </aside>
      </div>
      {mandando && (
        <GavetaMandar
          vinculo={vinculo}
          detalhe={d}
          comentario={comentario}
          reserva={titulo}
          aoMandar={(res) => {
            avisar(avisoDeMandado(res), res.failed ? { tipo: 'perigo' } : undefined);
            disparar(carregar());
          }}
          aoFechar={() => setMandando(false)}
        />
      )}
    </section>
  );
}
