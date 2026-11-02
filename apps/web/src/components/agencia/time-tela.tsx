'use client';

import type { AgencyClientResponse, AgencyInvitationResponse, AgencyMemberResponse, AgencyTeamResponse } from '@liame/contracts';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAvisar } from '@/components/ui/avisos';
import { ConfirmaNaLinha } from '@/components/ui/confirma-na-linha';
import { Estado } from '@/components/ui/estado';
import { Icone } from '@/components/ui/icone';
import { api, chamar, mensagemDe, type Problema } from '@/lib/api';
import { disparar } from '@/lib/disparar';
import { dia, iniciais, vencimento } from '@/lib/formato';
import { useSessao } from '@/lib/sessao';
import { GavetaConvidar } from './gaveta-convidar';
import { clientesDaPessoa, contagemDoTime, DESC_PAPEL, PAPEL_CURTO } from './textos';

// Time da agência (P27 aprovado; A7, W6, parte 5; D-A7-51): quem trabalha na agência, em que clientes está, os papéis e
// o convite. A dona e o administrador convidam e tiram do time; quem sai do time sai também de todos os clientes.

type Estado = { tipo: 'carregando' } | { tipo: 'ok'; dados: AgencyTeamResponse } | { tipo: 'erro'; problema: Problema };

const CHIP: Record<AgencyMemberResponse['role'], string> = { agencia_dona: 'dono', agencia_admin: 'admin', agencia_membro: 'leitura' };

export function TimeTela() {
  const { me, pode } = useSessao();
  const avisar = useAvisar();
  const [estado, setEstado] = useState<Estado>({ tipo: 'carregando' });
  const [clientes, setClientes] = useState<AgencyClientResponse[]>([]);
  const [convidando, setConvidando] = useState(false);
  const titulo = useRef<HTMLHeadingElement>(null);
  const cuidaDoTime = pode('agencia.time');

  const carregar = useCallback(async () => {
    const [r, c] = await Promise.all([
      chamar(() => api.GET('/v1/agency/team')),
      pode('agencia.clientes') ? chamar(() => api.GET('/v1/agency/clients')) : Promise.resolve(null),
    ]);
    setEstado(r.ok ? { tipo: 'ok', dados: r.data } : { tipo: 'erro', problema: r.problema });
    if (c?.ok) setClientes(c.data.clients);
  }, [pode]);

  useEffect(() => {
    if (pode('agencia.ver')) disparar(carregar());
  }, [carregar, pode]);

  const dados = estado.tipo === 'ok' ? estado.dados : null;
  const ocupados = useMemo(
    () => new Set([...(dados?.members ?? []).map((m) => m.email), ...(dados?.invitations ?? []).map((v) => v.email)]),
    [dados],
  );

  if (!pode('agencia.ver')) {
    return (
      <Estado icone="lock" titulo="Esta tela é do time de uma agência">
        Troque para a agência no seletor do alto do menu.
      </Estado>
    );
  }

  async function tirar(m: AgencyMemberResponse): Promise<boolean> {
    const r = await chamar(() => api.DELETE('/v1/agency/members/{id}', { params: { path: { id: m.id } } }));
    if (!r.ok) {
      avisar(mensagemDe(r.problema), { tipo: 'perigo' });
      return false;
    }
    avisar(`${m.name} saiu da agência e de todos os clientes, agora.`, { tipo: 'perigo' });
    await carregar();
    titulo.current?.focus({ preventScroll: true });
    return true;
  }

  async function cancelarConvite(v: AgencyInvitationResponse): Promise<boolean> {
    const r = await chamar(() => api.DELETE('/v1/agency/invitations/{id}', { params: { path: { id: v.id } } }));
    if (!r.ok && r.problema.status !== 404) {
      avisar(mensagemDe(r.problema), { tipo: 'perigo' });
      return false;
    }
    avisar(`Convite para ${v.email} cancelado. O link deixou de funcionar.`);
    await carregar();
    titulo.current?.focus({ preventScroll: true });
    return true;
  }

  return (
    <section aria-labelledby="h-time">
      <div className="view-cab anima" style={{ ['--i' as string]: 0 }}>
        <div>
          <h1 id="h-time" ref={titulo} tabIndex={-1}>
            Time da agência
          </h1>
          <p>
            Quem trabalha na {dados?.agency.name ?? 'agência'}. Cada pessoa entra só nos clientes em que for colocada, até o que o dono de cada
            empresa deu.
          </p>
        </div>
        {cuidaDoTime && (
          <button className="btn btn--primary" type="button" aria-haspopup="dialog" onClick={() => setConvidando(true)} disabled={!dados}>
            <Icone nome="user-plus" />
            Convidar para a agência
          </button>
        )}
      </div>

      <article className="card anima" style={{ ['--i' as string]: 1 }} aria-labelledby="tm-t" aria-busy={estado.tipo === 'carregando'}>
        <div className="card-cab">
          <div>
            <h2 id="tm-t">No time</h2>
            <p className="card-sub">{dados ? contagemDoTime(dados.members.length, dados.invitations.length) : ' '}</p>
          </div>
        </div>
        {estado.tipo === 'erro' && (
          <Estado
            icone="alert"
            perigo
            titulo="Não deu para carregar o time"
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
        {dados && (
          <ul className="pessoas">
            {dados.members.map((m) => (
              <PessoaDoTime
                key={m.id}
                pessoa={m}
                voce={m.user_id === me.user.id}
                clientes={pode('agencia.clientes') ? clientesDaPessoa(m, clientes) : null}
                podeTirar={cuidaDoTime && m.role !== 'agencia_dona' && m.user_id !== me.user.id}
                aoTirar={() => tirar(m)}
              />
            ))}
            {dados.invitations.map((v) => (
              <ConviteDoTime key={v.id} convite={v} podeCancelar={cuidaDoTime} aoCancelar={() => cancelarConvite(v)} />
            ))}
          </ul>
        )}
      </article>

      <article className="card anima" style={{ ['--i' as string]: 2, marginTop: 'var(--sp-4)' }} aria-labelledby="pp-t">
        <div className="card-cab">
          <div>
            <h2 id="pp-t">Os papéis na agência</h2>
          </div>
        </div>
        <div className="table-wrap">
          <table className="tabela tabela-niveis papeis">
            <caption className="sr-only">O que cada papel na agência pode fazer</caption>
            <thead>
              <tr>
                <th scope="col">Papel</th>
                <th scope="col">Pedir acesso e deixar um cliente</th>
                <th scope="col">Convidar o time e escolher quem entra</th>
                <th scope="col">Trabalhar nos clientes</th>
              </tr>
            </thead>
            <tbody>
              {(
                [
                  ['Dona da agência', 'Sim', 'Sim'],
                  ['Administrador', 'Sim', 'Sim'],
                  ['Membro', 'Não', 'Não'],
                ] as const
              ).map(([papel, pedir, convidar]) => (
                <tr key={papel}>
                  <th scope="row">{papel}</th>
                  <td data-rot="Pedir acesso e deixar um cliente">
                    <span className={pedir === 'Sim' ? 'sim' : 'nao'}>{pedir}</span>
                  </td>
                  <td data-rot="Convidar o time e escolher quem entra">
                    <span className={convidar === 'Sim' ? 'sim' : 'nao'}>{convidar}</span>
                  </td>
                  <td data-rot="Trabalhar nos clientes">
                    <span className="parcial">Onde estiver</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="tabela-nota">
          Só a dona fecha a conta da agência. Em cada cliente, o nível de cada pessoa nunca passa do que o dono daquela empresa deu à agência.
        </p>
      </article>

      {convidando && (
        <GavetaConvidar
          ocupados={ocupados}
          reserva={titulo}
          aoConvidar={(aviso) => {
            avisar(aviso);
            disparar(carregar());
          }}
          aoFechar={() => setConvidando(false)}
        />
      )}
    </section>
  );
}

function PessoaDoTime({
  pessoa: m,
  voce,
  clientes,
  podeTirar,
  aoTirar,
}: {
  pessoa: AgencyMemberResponse;
  voce: boolean;
  clientes: string | null;
  podeTirar: boolean;
  aoTirar: () => Promise<boolean>;
}) {
  const [confirmando, setConfirmando] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const tirar = useRef<HTMLButtonElement>(null);
  const perguntou = useRef(false);

  useEffect(() => {
    if (confirmando) perguntou.current = true;
    else if (perguntou.current) {
      perguntou.current = false;
      tirar.current?.focus();
    }
  }, [confirmando]);

  async function tirarAgora() {
    setEnviando(true);
    const ok = await aoTirar();
    if (!ok) {
      setEnviando(false);
      setConfirmando(false);
    }
  }

  return (
    <li className="pessoa">
      <span className="pessoa-av" aria-hidden="true">
        {iniciais(m.name)}
      </span>
      <div className="pessoa-txt">
        <p className="pessoa-nome">
          {m.name}
          <span className={`nivel-chip nivel-chip--${CHIP[m.role]}`}>{PAPEL_CURTO[m.role]}</span>
          {voce && <span className="lite-chip">Você</span>}
        </p>
        <p className="pessoa-email">{m.email}</p>
        <p className="pessoa-det">{DESC_PAPEL[m.role]}</p>
        <p className="pessoa-meta">
          {clientes && <span>{clientes}</span>}
          {!m.mfa_enabled && (
            <span className="st st--aguardando">
              <span className="dot" aria-hidden="true" />
              Falta ativar o app autenticador
            </span>
          )}
        </p>
      </div>
      {podeTirar && (
        <div className="pessoa-acoes">
          {confirmando ? (
            <ConfirmaNaLinha
              texto="Tem certeza? A pessoa sai da agência e de todos os clientes na hora."
              rotulo="Remover da agência"
              rotuloOcupado="Removendo…"
              ocupado={enviando}
              aoConfirmar={() => disparar(tirarAgora())}
              aoCancelar={() => setConfirmando(false)}
            />
          ) : (
            <button ref={tirar} className="btn btn--sm btn--perigo" type="button" onClick={() => setConfirmando(true)}>
              Remover da agência
            </button>
          )}
        </div>
      )}
    </li>
  );
}

function ConviteDoTime({ convite: v, podeCancelar, aoCancelar }: { convite: AgencyInvitationResponse; podeCancelar: boolean; aoCancelar: () => Promise<boolean> }) {
  const [confirmando, setConfirmando] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const enviado = dia(v.created_at);
  return (
    <li className="pessoa">
      <span className="pessoa-av pessoa-av--convite" aria-hidden="true">
        @
      </span>
      <div className="pessoa-txt">
        <p className="pessoa-nome">
          {v.email}
          <span className="nivel-chip">{PAPEL_CURTO[v.role]}</span>
        </p>
        <p className="pessoa-det">
          Convite enviado {enviado === 'hoje' ? 'hoje' : `em ${enviado}`} · {vencimento(v.expires_at)}
        </p>
      </div>
      {podeCancelar && (
        <div className="pessoa-acoes">
          {confirmando ? (
            <ConfirmaNaLinha
              texto="Cancelar o convite? O link deixa de funcionar."
              rotulo="Cancelar o convite"
              rotuloOcupado="Cancelando…"
              voltar="Manter"
              ocupado={enviando}
              aoConfirmar={() =>
                disparar(
                  (async () => {
                    setEnviando(true);
                    if (!(await aoCancelar())) {
                      setEnviando(false);
                      setConfirmando(false);
                    }
                  })(),
                )
              }
              aoCancelar={() => setConfirmando(false)}
            />
          ) : (
            <button className="btn btn--sm" type="button" onClick={() => setConfirmando(true)}>
              Cancelar o convite
            </button>
          )}
        </div>
      )}
    </li>
  );
}
