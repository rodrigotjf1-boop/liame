'use client';

import type { SecurityEventsResponse, SecuritySummaryResponse, SessionListResponse } from '@liame/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAvisar } from '@/components/ui/avisos';
import { Estado } from '@/components/ui/estado';
import { Icone } from '@/components/ui/icone';
import { useAgora } from '@/lib/agora';
import { api, chamar, mensagemDe, type Problema } from '@/lib/api';
import { disparar } from '@/lib/disparar';
import { quandoComHora } from '@/lib/formato';
import { useSessao } from '@/lib/sessao';
import { CartaoApp } from './cartao-app';
import { DialogoCodigos } from './dialogo-codigos';
import { DialogoTrocarApp } from './dialogo-trocar-app';
import { ItemAparelho } from './item-aparelho';
import { ondeDoEvento, situacaoDoApp, textoDoEvento } from './textos';

// "Segurança da conta" (mockups/prototipo-seguranca.html): como a pessoa entra no Liame e onde a conta
// dela está aberta. Vale para todas as empresas; tudo aqui é da própria pessoa (a API filtra pela RLS).

type Carga<T> = { tipo: 'carregando' } | { tipo: 'ok'; dados: T } | { tipo: 'erro'; problema: Problema };
type Dialogo = 'codigos' | 'trocar' | 'ativar' | null;

export function SegurancaTela() {
  const { me } = useSessao();
  const avisar = useAvisar();
  const titulo = useRef<HTMLHeadingElement>(null);
  const [resumo, setResumo] = useState<Carga<SecuritySummaryResponse>>({ tipo: 'carregando' });
  const [sessoes, setSessoes] = useState<Carga<SessionListResponse>>({ tipo: 'carregando' });
  const [eventos, setEventos] = useState<Carga<SecurityEventsResponse>>({ tipo: 'carregando' });
  const [dialogo, setDialogo] = useState<Dialogo>(null);
  const [pedindo, setPedindo] = useState(false);
  const [enviandoSenha, setEnviandoSenha] = useState(false);
  const [saindoOutros, setSaindoOutros] = useState(false);
  const agora = useAgora(60_000, resumo);

  const carregarResumo = useCallback(async () => {
    const r = await chamar(() => api.GET('/v1/me/security'));
    setResumo(r.ok ? { tipo: 'ok', dados: r.data } : { tipo: 'erro', problema: r.problema });
  }, []);
  const carregarSessoes = useCallback(async () => {
    const r = await chamar(() => api.GET('/v1/me/sessions'));
    setSessoes(r.ok ? { tipo: 'ok', dados: r.data } : { tipo: 'erro', problema: r.problema });
  }, []);
  const carregarEventos = useCallback(async () => {
    const r = await chamar(() => api.GET('/v1/me/security/events'));
    setEventos(r.ok ? { tipo: 'ok', dados: r.data } : { tipo: 'erro', problema: r.problema });
  }, []);

  useEffect(() => {
    disparar(carregarResumo());
    disparar(carregarSessoes());
    disparar(carregarEventos());
  }, [carregarResumo, carregarSessoes, carregarEventos]);

  const dados = resumo.tipo === 'ok' ? resumo.dados : null;
  const situacao = dados ? situacaoDoApp(dados) : null;

  async function pedirTroca() {
    setPedindo(true);
    const r = await chamar(() => api.POST('/v1/me/mfa/change-request'));
    setPedindo(false);
    if (!r.ok) return avisar(mensagemDe(r.problema), { tipo: 'perigo' });
    avisar('Pedido feito. A troca libera em 24 horas; mandamos um aviso por e-mail.');
    await Promise.all([carregarResumo(), carregarEventos()]);
  }

  async function trocarSenha() {
    setEnviandoSenha(true);
    const r = await chamar(() => api.POST('/v1/auth/password/forgot', { body: { email: me.user.email } }));
    setEnviandoSenha(false);
    if (!r.ok) return avisar(mensagemDe(r.problema), { tipo: 'perigo' });
    avisar(`Link enviado para ${me.user.email}. Ele vale 1 hora.`);
  }

  async function encerrar(id: string): Promise<boolean> {
    const r = await chamar(() => api.DELETE('/v1/me/sessions/{id}', { params: { path: { id } } }));
    if (!r.ok) {
      avisar(mensagemDe(r.problema), { tipo: 'perigo' });
      return false;
    }
    avisar('Aparelho desconectado. Ele precisa entrar de novo.');
    await Promise.all([carregarSessoes(), carregarEventos()]);
    titulo.current?.focus({ preventScroll: true });
    return true;
  }

  async function sairDosOutros() {
    setSaindoOutros(true);
    const r = await chamar(() => api.POST('/v1/me/sessions/revoke-others'));
    setSaindoOutros(false);
    if (!r.ok) return avisar(mensagemDe(r.problema), { tipo: 'perigo' });
    avisar('Pronto: a sua conta ficou aberta só neste aparelho.');
    await Promise.all([carregarSessoes(), carregarEventos()]);
  }

  const outros = sessoes.tipo === 'ok' ? sessoes.dados.sessions.filter((s) => !s.current).length : 0;
  return (
    <section aria-labelledby="h-seg">
      <div className="view-cab anima" style={{ ['--i' as string]: 0 }}>
        <div>
          <h1 id="h-seg" ref={titulo} tabIndex={-1}>
            Segurança da conta
          </h1>
          <p>Como você entra no Liame e onde a sua conta está aberta. Vale para todas as empresas em que você tem acesso.</p>
        </div>
      </div>

      {situacao === 'recuperacao' && (
        <div className="aviso-seg aviso-seg--atencao" role="status">
          <b>Você entrou com um código de recuperação.</b>
          <span>Se perdeu o celular, peça a troca do app abaixo. Por segurança, ela vale em 24 horas e avisamos por e-mail.</span>
        </div>
      )}

      <div className="seg-grid">
        {resumo.tipo === 'carregando' && <CartaoCarregando id="t-app-c" titulo="App autenticador" />}
        {resumo.tipo === 'erro' && (
          <article className="card" aria-labelledby="t-app-e">
            <h2 className="sr-only" id="t-app-e">
              App autenticador
            </h2>
            <Estado
              icone="alert"
              perigo
              titulo="Não deu para carregar o app e os códigos"
              acao={
                <button className="btn" type="button" onClick={() => disparar(carregarResumo())}>
                  <Icone nome="refresh" />
                  Tentar de novo
                </button>
              }
            >
              {mensagemDe(resumo.problema)}
            </Estado>
          </article>
        )}
        {dados && situacao && (
          <CartaoApp
            resumo={dados}
            situacao={situacao}
            agora={agora}
            pedindo={pedindo}
            aoTrocar={() => setDialogo('trocar')}
            aoAtivar={() => setDialogo('ativar')}
            aoPedirTroca={() => disparar(pedirTroca())}
          />
        )}

        {dados?.mfa_enabled_since && (
          <article className="card anima" style={{ ['--i' as string]: 2 }} aria-labelledby="t-cod">
            <div className="card-cab">
              <div>
                <h2 id="t-cod">Códigos de recuperação</h2>
                <p className="card-sub">Abrem a conta se você perder o celular. Cada um vale uma vez.</p>
              </div>
            </div>
            <p className="seg-num">
              <span className="mono">{dados.recovery_codes_left}</span> de 10 ainda {dados.recovery_codes_left === 1 ? 'vale' : 'valem'}
            </p>
            <p className="seg-txt">
              Usou vários ou acha que alguém viu? Gere códigos novos: os antigos deixam de valer na hora. Pedimos o código do app para
              confirmar.
            </p>
            <div className="seg-acoes">
              <button className="btn" type="button" onClick={() => setDialogo('codigos')}>
                Gerar códigos novos
              </button>
            </div>
          </article>
        )}

        <article className="card anima" style={{ ['--i' as string]: 3 }} aria-labelledby="t-senha">
          <div className="card-cab">
            <div>
              <h2 id="t-senha">Senha</h2>
              <p className="card-sub">A troca é pelo link que mandamos para o seu e-mail.</p>
            </div>
          </div>
          <p className="seg-txt">
            Mandamos um link para <b>{me.user.email}</b> (vale 1 hora). Ao salvar a senha nova, saímos da sua conta em todos os aparelhos.
          </p>
          <div className="seg-acoes">
            <button className="btn" type="button" onClick={() => disparar(trocarSenha())} disabled={enviandoSenha} aria-busy={enviandoSenha}>
              {enviandoSenha ? 'Enviando…' : 'Trocar a senha'}
            </button>
          </div>
        </article>
      </div>

      <article className="card seg-largo anima" style={{ ['--i' as string]: 4 }} aria-labelledby="t-apar" aria-busy={sessoes.tipo === 'carregando'}>
        <div className="card-cab">
          <div>
            <h2 id="t-apar">Aparelhos conectados</h2>
            <p className="card-sub">Onde a sua conta está aberta agora. Encerrar tira o acesso daquele aparelho na hora.</p>
          </div>
          {outros > 0 && (
            <button className="btn btn--sm" type="button" onClick={() => disparar(sairDosOutros())} disabled={saindoOutros} aria-busy={saindoOutros}>
              {saindoOutros ? 'Saindo…' : 'Sair de todos os outros'}
            </button>
          )}
        </div>
        {sessoes.tipo === 'carregando' && <ListaCarregando rotulo="Carregando os aparelhos" />}
        {sessoes.tipo === 'erro' && (
          <Estado
            icone="alert"
            perigo
            titulo="Não deu para carregar os aparelhos"
            acao={
              <button className="btn" type="button" onClick={() => disparar(carregarSessoes())}>
                <Icone nome="refresh" />
                Tentar de novo
              </button>
            }
          >
            {mensagemDe(sessoes.problema)}
          </Estado>
        )}
        {sessoes.tipo === 'ok' && (
          <ul className="aparelhos">
            {sessoes.dados.sessions.map((s) => (
              <ItemAparelho key={s.id} sessao={s} agora={agora} aoEncerrar={() => encerrar(s.id)} />
            ))}
          </ul>
        )}
      </article>

      <article className="card seg-largo anima" style={{ ['--i' as string]: 5 }} aria-labelledby="t-ativ" aria-busy={eventos.tipo === 'carregando'}>
        <div className="card-cab">
          <div>
            <h2 id="t-ativ">Atividade de segurança</h2>
            <p className="card-sub">Os últimos 30 dias. Não reconhece algo? Troque a senha e encerre os aparelhos.</p>
          </div>
        </div>
        {eventos.tipo === 'carregando' && <ListaCarregando rotulo="Carregando a atividade" />}
        {eventos.tipo === 'erro' && (
          <Estado
            icone="alert"
            perigo
            titulo="Não deu para carregar a atividade"
            acao={
              <button className="btn" type="button" onClick={() => disparar(carregarEventos())}>
                <Icone nome="refresh" />
                Tentar de novo
              </button>
            }
          >
            {mensagemDe(eventos.problema)}
          </Estado>
        )}
        {eventos.tipo === 'ok' && !eventos.dados.events.length && (
          <p className="seg-txt">Nenhuma atividade de segurança nos últimos 30 dias.</p>
        )}
        {eventos.tipo === 'ok' && eventos.dados.events.length > 0 && (
          <div className="table-wrap">
            <table className="tabela tabela-atividade">
              <caption className="sr-only">Atividade de segurança dos últimos 30 dias</caption>
              <thead>
                <tr>
                  <th scope="col">Quando</th>
                  <th scope="col">O que aconteceu</th>
                  <th scope="col">Onde</th>
                </tr>
              </thead>
              <tbody>
                {eventos.dados.events.map((e, i) => {
                  const { texto, alerta } = textoDoEvento(e);
                  return (
                    <tr key={`${e.occurred_at}-${e.action}-${i}`}>
                      <td className="mono">{quandoComHora(e.occurred_at, agora)}</td>
                      <td>
                        {alerta ? (
                          <span className="st st--aguardando">
                            <span className="dot" aria-hidden="true" />
                            {texto}
                          </span>
                        ) : (
                          texto
                        )}
                      </td>
                      <td>{ondeDoEvento(e)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </article>

      {dialogo === 'codigos' && dados && (
        <DialogoCodigos
          restantes={dados.recovery_codes_left}
          reserva={titulo}
          aoGerar={() => {
            avisar('Códigos novos gerados. Os antigos deixaram de valer.');
            disparar(Promise.all([carregarResumo(), carregarEventos()]));
          }}
          aoFechar={() => setDialogo(null)}
        />
      )}
      {(dialogo === 'trocar' || dialogo === 'ativar') && (
        <DialogoTrocarApp
          modo={dialogo}
          reserva={titulo}
          aoConcluir={() => {
            avisar(dialogo === 'trocar' ? 'App autenticador trocado. O antigo deixou de valer.' : 'App autenticador ativado.');
            disparar(Promise.all([carregarResumo(), carregarEventos()]));
          }}
          aoFechar={() => setDialogo(null)}
        />
      )}
    </section>
  );
}

function CartaoCarregando({ id, titulo }: { id: string; titulo: string }) {
  return (
    <article className="card" aria-labelledby={id} aria-busy="true">
      <h2 className="sr-only" id={id}>
        {titulo}
      </h2>
      <span className="esqueleto" style={{ width: '55%', height: 16 }} aria-hidden="true" />
      <span className="esqueleto" style={{ width: '90%', height: 12 }} aria-hidden="true" />
      <span className="esqueleto" style={{ width: '75%', height: 12 }} aria-hidden="true" />
      <span className="esqueleto" style={{ width: 140, height: 38 }} aria-hidden="true" />
    </article>
  );
}

function ListaCarregando({ rotulo }: { rotulo: string }) {
  return (
    <ul className="aparelhos" aria-label={rotulo}>
      {[0, 1].map((i) => (
        <li key={i} className="aparelho" aria-hidden="true">
          <span className="esqueleto" style={{ width: 44, height: 44, borderRadius: 12 }} />
          <span style={{ display: 'grid', gap: 8 }}>
            <span className="esqueleto" style={{ width: '40%', height: 14 }} />
            <span className="esqueleto" style={{ width: '70%', height: 12 }} />
          </span>
        </li>
      ))}
    </ul>
  );
}
