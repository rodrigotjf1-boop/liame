'use client';

import type { AgencyClientResponse, AgencyClientTeamMember, PartnerRole } from '@liame/contracts';
import { type FormEvent, type RefObject, useEffect, useId, useRef, useState } from 'react';
import { Icone } from '@/components/ui/icone';
import { useDialogo } from '@/components/ui/use-dialogo';
import { api, chamar, mensagemDe, novaChave, type Problema } from '@/lib/api';
import { disparar } from '@/lib/disparar';
import { MICROS, moeda } from '@/lib/formato';
import { APROVAM, NIVEIS, RANK } from '@/lib/niveis';
import { maximoTxt, NIVEIS_DA_AGENCIA } from './textos';

// "Quem entra" num cliente (P27 aprovado, gaveta à direita; D-A7-48): a dona ou um administrador escolhe quem do time
// entra, com o nível e o limite até o máximo do dono. Quem não tem o app autenticador ainda não entra. Salvar manda a
// lista inteira; quem sai dela perde o acesso a este cliente na hora.

type Props = {
  cliente: AgencyClientResponse;
  reserva: RefObject<HTMLElement | null>;
  aoSalvar: (aviso: string) => void;
  aoSumir: (problema: Problema) => void;
  aoFechar: () => void;
};

type Linha = { entra: boolean; nivel: PartnerRole; limite: string; erro: string };

const reais = (micros: number | null) => (micros === null ? '' : String(micros / MICROS));

export function GavetaQuemEntra({ cliente: c, reserva, aoSalvar, aoSumir, aoFechar }: Props) {
  const ids = useId();
  const fecharBt = useRef<HTMLButtonElement>(null);
  const { ref, fechar, devolverFoco } = useDialogo({ focoInicial: fecharBt, reserva });
  const chave = useRef(novaChave());
  const [time, setTime] = useState<AgencyClientTeamMember[] | null>(null);
  const [linhas, setLinhas] = useState<Record<string, Linha>>({});
  const [erroGeral, setErroGeral] = useState('');
  const [enviando, setEnviando] = useState(false);
  // Quem chama passa uma função nova a cada render: a leitura do time roda uma vez por cliente, não a cada render.
  const sumiu = useRef(aoSumir);
  useEffect(() => {
    sumiu.current = aoSumir;
  });

  useEffect(() => {
    let vivo = true;
    disparar(
      (async () => {
        const r = await chamar(() => api.GET('/v1/agency/clients/{id}/team', { params: { path: { id: c.id } } }));
        if (!vivo) return;
        if (!r.ok) {
          if (r.problema.status === 404) return sumiu.current(r.problema);
          return setErroGeral(mensagemDe(r.problema));
        }
        setTime(r.data.team);
        setLinhas(
          Object.fromEntries(
            r.data.team.map((t) => [
              t.user_id,
              {
                entra: Boolean(t.in_client),
                nivel: t.in_client?.role ?? c.max_role,
                limite: reais(t.in_client?.approve_limit_micros ?? c.approve_limit_micros),
                erro: '',
              },
            ]),
          ),
        );
      })(),
    );
    return () => {
      vivo = false;
    };
  }, [c.id, c.max_role, c.approve_limit_micros]);

  const mudar = (id: string, parte: Partial<Linha>) => setLinhas((ls) => ({ ...ls, [id]: { ...ls[id]!, ...parte, erro: '' } }));

  async function salvar(e: FormEvent) {
    e.preventDefault();
    if (!time) return;
    setErroGeral('');
    const membros: Array<{ user_id: string; role: PartnerRole; approve_limit_micros?: number | null }> = [];
    const erros: Record<string, string> = {};
    for (const t of time) {
      const quem = t.user_id;
      const l = linhas[quem]!;
      if (!l.entra) continue;
      if (!APROVAM.has(l.nivel)) {
        membros.push({ user_id: t.user_id, role: l.nivel });
        continue;
      }
      const valor = Number(l.limite);
      if (l.limite.trim() === '' || !Number.isFinite(valor) || valor < 0) {
        erros[quem] = 'Informe até quanto a pessoa aprova sozinha (pode ser zero).';
        continue;
      }
      const micros = Math.round(valor * MICROS);
      if (c.approve_limit_micros !== null && micros > c.approve_limit_micros) {
        erros[quem] = `Até ${moeda(c.approve_limit_micros)}: é o que o dono deu à agência.`;
        continue;
      }
      membros.push({ user_id: t.user_id, role: l.nivel, approve_limit_micros: micros });
    }
    if (Object.keys(erros).length) {
      setLinhas((ls) => Object.fromEntries(Object.entries(ls).map(([id, l]) => [id, { ...l, erro: erros[id] ?? '' }])));
      const primeiro = time.find((t) => erros[t.user_id]);
      if (primeiro) document.getElementById(`${ids}-l-${primeiro.user_id}`)?.focus();
      return;
    }
    setEnviando(true);
    const antes = new Set(time.filter((t) => t.in_client).map((t) => t.user_id));
    const r = await chamar(() =>
      api.PUT('/v1/agency/clients/{id}/team', { params: { path: { id: c.id } }, headers: { 'Idempotency-Key': chave.current }, body: { members: membros } }),
    );
    setEnviando(false);
    if (r.ok) {
      const novos = membros.filter((m) => !antes.has(m.user_id)).length;
      aoSalvar(novos ? `Salvo. O dono da ${c.organization.name} recebe um aviso de cada pessoa nova.` : 'Salvo.');
      return fechar();
    }
    chave.current = novaChave();
    if (r.problema.status === 404 && r.problema.code === 'nao-encontrado') return aoSumir(r.problema);
    setErroGeral(mensagemDe(r.problema));
  }

  return (
    <dialog
      ref={ref}
      className="dialogo dialogo--lado"
      aria-labelledby={`${ids}-t`}
      onClose={() => {
        aoFechar();
        devolverFoco();
      }}
    >
      <form className="dialogo-form" onSubmit={(e) => disparar(salvar(e))} noValidate>
        <div className="dialogo-cab">
          <h2 id={`${ids}-t`}>Quem entra na {c.organization.name}</h2>
          <button ref={fecharBt} className="btn btn--ghost btn--icon" type="button" onClick={fechar} aria-label="Fechar" disabled={enviando}>
            <Icone nome="x" />
          </button>
        </div>
        <div className="dialogo-corpo" aria-busy={time === null}>
          {erroGeral && (
            <p className="dialogo-erro" role="alert">
              <Icone nome="alert" pequeno />
              <span>{erroGeral}</span>
            </p>
          )}
          <p className="dialogo-nota">
            <Icone nome="info" pequeno />
            <span>{maximoTxt(c)}</span>
          </p>
          {time === null && !erroGeral && <p className="campo-dica">Carregando o time…</p>}
          {time && (
            <div className="time-esc">
              {time.map((t) => {
                const l = linhas[t.user_id]!;
                const primeiro = t.name.split(/\s+/)[0];
                return (
                  <div className="time-esc-linha" key={t.user_id}>
                    <label className="check">
                      <input type="checkbox" checked={l.entra} disabled={!t.mfa_enabled} onChange={(e) => mudar(t.user_id, { entra: e.target.checked })} />{' '}
                      {t.name}
                    </label>
                    <div className="campo-mini">
                      <label className="rot-mini" htmlFor={`${ids}-n-${t.user_id}`}>
                        Nível
                      </label>
                      <select
                        className="input"
                        id={`${ids}-n-${t.user_id}`}
                        value={l.nivel}
                        disabled={!t.mfa_enabled}
                        onChange={(e) => mudar(t.user_id, { nivel: e.target.value as PartnerRole })}
                      >
                        {NIVEIS_DA_AGENCIA.map((n) => {
                          const acima = RANK[n] > RANK[c.max_role];
                          return (
                            <option key={n} value={n} disabled={acima}>
                              {NIVEIS[n].nome}
                              {acima ? ' (acima do que o dono deu)' : ''}
                            </option>
                          );
                        })}
                      </select>
                    </div>
                    {APROVAM.has(l.nivel) && (
                      <div className="campo-mini">
                        <label className="rot-mini" htmlFor={`${ids}-l-${t.user_id}`}>
                          Aprova até, por ação (R$)
                        </label>
                        <input
                          className="input campo-mono"
                          id={`${ids}-l-${t.user_id}`}
                          type="number"
                          min={0}
                          step={50}
                          inputMode="numeric"
                          value={l.limite}
                          disabled={!t.mfa_enabled}
                          onChange={(e) => mudar(t.user_id, { limite: e.target.value })}
                          aria-invalid={l.erro ? true : undefined}
                          aria-describedby={l.erro ? `${ids}-e-${t.user_id}` : undefined}
                        />
                      </div>
                    )}
                    {!t.mfa_enabled && <span className="campo-dica time-esc-nota">{primeiro} ainda não ativou o app autenticador: entra depois de ativar.</span>}
                    {l.erro && (
                      <p className="campo-erro time-esc-nota" id={`${ids}-e-${t.user_id}`}>
                        {l.erro}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          <p className="campo-dica">O dono da empresa recebe um aviso de cada pessoa nova da agência.</p>
        </div>
        <div className="dialogo-acoes">
          <button className="btn" type="button" onClick={fechar} disabled={enviando}>
            Cancelar
          </button>
          <button className="btn btn--primary" type="submit" disabled={enviando || time === null} aria-busy={enviando}>
            {enviando ? 'Salvando…' : 'Salvar quem entra'}
          </button>
        </div>
      </form>
    </dialog>
  );
}
