'use client';

import type { DmsGraphSituation } from '@liame/contracts';
import { useCallback, useEffect, useId, useState } from 'react';
import { Icone } from '@/components/ui/icone';
import { api, chamar, mensagemDe } from '@/lib/api';
import { disparar } from '@/lib/disparar';

// O DMS Graph em Contas conectadas (F4; protótipo aprovado em 22/11/2026): só aparece com a função ligada para a empresa.
// Quem pode conectar contas liga e desliga; a ligação vale para a empresa inteira.

const RECURSO = 'Ajusta a luz, o fundo e o enquadramento de uma foto real, sem texto na arte.';
const PAGO = 'Recurso pago: a empresa começa com franquia 0, e a DMS libera.';

function dia(iso: string): string {
  return new Date(iso).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
}

/** Só endereço https (ou da própria máquina, em teste): o servidor monta, a tela confere. */
function paginaDoGraph(url: string): string | null {
  try {
    const u = new URL(url);
    const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
    return u.protocol === 'https:' || (u.protocol === 'http:' && local) ? u.toString() : null;
  } catch {
    return null;
  }
}

export function CartaoDmsGraph() {
  const ids = useId();
  const [s, setS] = useState<DmsGraphSituation | null>(null);
  const [erroDeLeitura, setErroDeLeitura] = useState('');
  const [erro, setErro] = useState('');
  const [aviso, setAviso] = useState('');
  const [indo, setIndo] = useState(false);
  const [confirmando, setConfirmando] = useState(false);
  const [desligando, setDesligando] = useState(false);
  const [cnpj, setCnpj] = useState('');
  const [salvando, setSalvando] = useState(false);

  const carregar = useCallback(async () => {
    setErroDeLeitura('');
    const r = await chamar(() => api.GET('/v1/dms-graph'));
    if (r.ok) setS(r.data);
    else setErroDeLeitura(mensagemDe(r.problema));
  }, []);

  useEffect(() => {
    disparar(carregar());
  }, [carregar]);

  async function conectar() {
    setErro('');
    setAviso('');
    setIndo(true);
    const r = await chamar(() => api.POST('/v1/dms-graph/authorize'));
    if (!r.ok) {
      setErro(mensagemDe(r.problema));
      setIndo(false);
      return;
    }
    const destino = paginaDoGraph(r.data.authorize_url);
    if (!destino) {
      setErro('O endereço do DMS Graph veio errado. Fale com o suporte.');
      setIndo(false);
      return;
    }
    window.location.assign(destino);
  }

  async function salvarCnpj() {
    setErro('');
    setSalvando(true);
    const r = await chamar(() => api.PUT('/v1/dms-graph/cnpj', { body: { cnpj: cnpj.trim() } }));
    setSalvando(false);
    if (!r.ok) {
      setErro(mensagemDe(r.problema));
      return;
    }
    setCnpj('');
    setAviso('CNPJ salvo.');
    await carregar();
  }

  async function desligar() {
    setErro('');
    setDesligando(true);
    const r = await chamar(() => api.POST('/v1/dms-graph/disconnect'));
    setDesligando(false);
    if (!r.ok) {
      setErro(mensagemDe(r.problema));
      return;
    }
    setConfirmando(false);
    setAviso('DMS Graph desligado.');
    await carregar();
  }

  if (erroDeLeitura && !s) {
    return (
      <div className="anima">
        <h2 className="sub-titulo">DMS Graph</h2>
        <div className="card autorizacao">
          <p className="aut-txt aut-txt--perigo" role="alert">
            <Icone nome="alert-circle" pequeno />
            <span>{erroDeLeitura}</span>
          </p>
          <div>
            <button className="btn btn--sm" type="button" onClick={() => disparar(carregar())}>
              Tentar de novo
            </button>
          </div>
        </div>
      </div>
    );
  }
  // Desligado para a empresa (ou ainda lendo): a tela fica como sempre foi.
  if (!s?.enabled) return null;

  const ligada = s.link;
  const tirado = !ligada && Boolean(s.revoked_by_graph_at);
  const q = s.quota;

  return (
    <div className="anima">
      <h2 className="sub-titulo">DMS Graph</h2>
      <p className="sub-desc">Melhore a foto real da sua loja antes de publicar.</p>
      <section className="card autorizacao dg-cartao" aria-label="DMS Graph">
        <div className="aut-cab">
          <span className="plat">DMS Graph</span>
          <span className={`st ${ligada ? 'st--concluido' : tirado ? 'st--perigo' : 'st--espera'}`}>{ligada ? 'Conectado' : tirado ? 'Acesso tirado' : 'Não conectado'}</span>
        </div>
        {aviso && (
          <p className="aut-txt" role="status">
            {aviso}
          </p>
        )}
        {erro && (
          <p className="aut-txt aut-txt--perigo" role="alert">
            <Icone nome="alert-circle" pequeno />
            <span>{erro}</span>
          </p>
        )}
        {ligada ? (
          <>
            <div className="dg-recurso">
              <Icone nome="check-circle" pequeno />
              <span>
                <b>Editar foto</b>
                <small>{RECURSO}</small>
              </span>
            </div>
            {q && (
              <div className="dg-franquia">
                <span className="dg-linha">
                  <span>Edições de foto neste mês</span>
                  <b>
                    {q.used} de {q.total}
                  </b>
                </span>
                <span className="dg-barra" aria-hidden="true">
                  <i style={{ width: `${q.total ? Math.min(Math.round((q.used / q.total) * 100), 100) : 0}%` }} />
                </span>
              </div>
            )}
            <p className="aut-txt">
              Conectado desde {dia(ligada.connected_at)}
              {ligada.connected_by ? ` por ${ligada.connected_by}` : ''}
              {ligada.account_name ? `, na conta ${ligada.account_name} do DMS Graph` : ''}. A franquia é da empresa e vale para o Regem e o Liame.
            </p>
            {s.can_connect &&
              (confirmando ? (
                <div className="dg-confirma" role="alertdialog" aria-label="Desligar o DMS Graph">
                  <p>
                    <b>Desligar o DMS Graph do Liame?</b> O Liame para de editar fotos. As fotos editadas que já estão em Fotos continuam lá, e o que já foi publicado não muda. A
                    ligação de outros produtos da empresa continua.
                  </p>
                  <div className="dg-acoes">
                    <button className="btn btn--perigo btn--sm" type="button" disabled={desligando} onClick={() => disparar(desligar())}>
                      {desligando ? 'Desligando…' : 'Desligar'}
                    </button>
                    <button className="btn btn--sm" type="button" disabled={desligando} onClick={() => setConfirmando(false)}>
                      Manter ligado
                    </button>
                  </div>
                </div>
              ) : (
                <div className="dg-acoes">
                  <button
                    className="btn btn--sm"
                    type="button"
                    onClick={() => {
                      setAviso('');
                      setConfirmando(true);
                    }}
                  >
                    Desligar
                  </button>
                </div>
              ))}
          </>
        ) : (
          <>
            {tirado ? (
              <p className="aut-txt aut-txt--perigo">
                <Icone nome="alert-circle" pequeno />
                <span>O acesso foi tirado no DMS Graph. O Liame parou de editar fotos. Conecte de novo para voltar.</span>
              </p>
            ) : (
              <div className="dg-recurso">
                <Icone nome="check-circle" pequeno />
                <span>
                  <b>O Liame vai pedir: editar foto</b>
                  <small>
                    Necessária. {RECURSO} {PAGO}
                  </small>
                </span>
              </div>
            )}
            {!s.can_connect ? (
              <p className="aut-txt">Só quem conecta contas liga o DMS Graph. Peça para o Dono ou o Administrador abrir esta tela.</p>
            ) : !s.company_has_cnpj ? (
              <>
                <p className="aut-txt aut-txt--atencao">
                  <Icone nome="alert" pequeno />
                  <span>Falta o CNPJ da empresa. A conta da empresa no DMS Graph nasce pelo CNPJ. Informe uma vez.</span>
                </p>
                <div className="campo dg-cnpj">
                  <label htmlFor={`${ids}-cnpj`}>CNPJ da empresa</label>
                  <input className="input" id={`${ids}-cnpj`} inputMode="numeric" value={cnpj} onChange={(e) => setCnpj(e.target.value)} placeholder="00.000.000/0000-00" />
                </div>
                <div className="dg-acoes">
                  <button className="btn btn--primary btn--sm" type="button" disabled={salvando || cnpj.replace(/\D/g, '').length !== 14} onClick={() => disparar(salvarCnpj())}>
                    {salvando ? 'Salvando…' : 'Salvar CNPJ'}
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="dg-acoes">
                  <button className="btn btn--primary btn--sm" type="button" disabled={indo} onClick={() => disparar(conectar())}>
                    {indo ? 'Indo para o DMS Graph…' : tirado ? 'Conectar de novo' : 'Conectar ao DMS Graph'}
                  </button>
                </div>
                <p className="aut-txt">Abre a página do DMS Graph. Lá, você entra com o DMS ID, vê o que o Liame vai usar e confirma.</p>
              </>
            )}
          </>
        )}
      </section>
    </div>
  );
}
