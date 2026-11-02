'use client';

import type { MemberResponse, PartnerResponse, PartnerRole } from '@liame/contracts';
import { type FormEvent, type RefObject, useId, useRef, useState } from 'react';
import { Icone } from '@/components/ui/icone';
import { useDialogo } from '@/components/ui/use-dialogo';
import { api, chamar, mensagemDe, novaChave, type Problema } from '@/lib/api';
import { disparar } from '@/lib/disparar';
import { MICROS } from '@/lib/formato';
import { APROVAM, NIVEIS } from '@/lib/niveis';
import { efeitosDaMudanca, type Maximo, NIVEIS_DO_PARCEIRO, sobe } from './parceiros';

// "O que a agência pode" (P27 aprovado, gaveta à direita; D-A7-49): o Dono muda o máximo do time da agência. Baixar vale
// na hora, sem o código, e a tela diz quem do time desce; subir o nível ou o limite, ou tirar o "eu também aprovo",
// pede o código do app. Só o que mudou vai para a API.

type Props = {
  parceiro: PartnerResponse;
  time: MemberResponse[];
  reserva: RefObject<HTMLElement | null>;
  aoSalvar: (aviso: string) => void;
  aoSumir: (problema: Problema) => void;
  aoFechar: () => void;
};

export function GavetaLimites({ parceiro: p, time, reserva, aoSalvar, aoSumir, aoFechar }: Props) {
  const ids = useId();
  const nivelAtual = useRef<HTMLInputElement>(null);
  const campoLimite = useRef<HTMLInputElement>(null);
  const campoCodigo = useRef<HTMLInputElement>(null);
  const { ref, fechar, devolverFoco } = useDialogo({ focoInicial: nivelAtual, reserva });
  const chave = useRef(novaChave());
  const antes: Maximo = { nivel: p.max_role, limite: p.approve_limit_micros, dupla: p.dual_approval };
  const [nivel, setNivel] = useState<PartnerRole>(p.max_role);
  const [limite, setLimite] = useState(p.approve_limit_micros !== null ? String(p.approve_limit_micros / MICROS) : '500');
  const [dupla, setDupla] = useState(p.dual_approval);
  const [codigo, setCodigo] = useState('');
  const [erroLimite, setErroLimite] = useState('');
  const [erroCodigo, setErroCodigo] = useState('');
  const [erroGeral, setErroGeral] = useState('');
  const [enviando, setEnviando] = useState(false);
  const aprova = APROVAM.has(nivel);

  const valor = Number(limite);
  const limiteLido = aprova && limite.trim() !== '' && Number.isFinite(valor) && valor >= 0 ? Math.round(valor * MICROS) : null;
  const depois: Maximo = { nivel, limite: aprova ? (limiteLido ?? antes.limite) : null, dupla: aprova ? dupla : true };
  const pedeCodigo = sobe(antes, depois);
  const efeitos = efeitosDaMudanca(antes, depois, time);

  async function salvar(e: FormEvent) {
    e.preventDefault();
    setErroLimite('');
    setErroCodigo('');
    setErroGeral('');
    if (aprova && limiteLido === null) {
      setErroLimite('Informe até quanto a pessoa da agência aprova sozinha (pode ser zero).');
      campoLimite.current?.focus();
      return;
    }
    const cod = codigo.trim();
    if (pedeCodigo && !/^\d{6}$/.test(cod)) {
      setErroCodigo('Para subir, digite os 6 números do app autenticador.');
      campoCodigo.current?.focus();
      return;
    }
    const mudancas: { max_role?: PartnerRole; approve_limit_micros?: number; dual_approval?: boolean; code?: string } = {};
    if (nivel !== p.max_role) mudancas.max_role = nivel;
    if (aprova && limiteLido !== null && (limiteLido !== p.approve_limit_micros || !APROVAM.has(p.max_role))) mudancas.approve_limit_micros = limiteLido;
    if (aprova && dupla !== p.dual_approval) mudancas.dual_approval = dupla;
    if (!Object.keys(mudancas).length) return fechar();
    if (pedeCodigo) mudancas.code = cod;
    setEnviando(true);
    const r = await chamar(() =>
      api.PATCH('/v1/partners/{id}', { params: { path: { id: p.id } }, headers: { 'Idempotency-Key': chave.current }, body: mudancas }),
    );
    setEnviando(false);
    if (r.ok) {
      aoSalvar('Salvo. A agência recebeu um aviso do que mudou.');
      return fechar();
    }
    chave.current = novaChave();
    if (r.problema.status === 404) return aoSumir(r.problema);
    if (r.problema.code === 'codigo-invalido' || r.problema.errors?.some((x) => x.path === 'code')) {
      setCodigo('');
      setErroCodigo(
        r.problema.code === 'codigo-invalido'
          ? 'O código não confere. Digite o que aparece agora no app autenticador.'
          : 'Para subir, digite os 6 números do app autenticador.',
      );
      campoCodigo.current?.focus();
      return;
    }
    const doLimite = r.problema.errors?.find((x) => x.path === 'approve_limit_micros');
    if (doLimite) {
      setErroLimite(doLimite.message);
      campoLimite.current?.focus();
      return;
    }
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
          <h2 id={`${ids}-t`}>O que {p.agency.name} pode</h2>
          <button className="btn btn--ghost btn--icon" type="button" onClick={fechar} aria-label="Fechar" disabled={enviando}>
            <Icone nome="x" />
          </button>
        </div>
        <div className="dialogo-corpo">
          {erroGeral && (
            <p className="dialogo-erro" role="alert">
              <Icone nome="alert" pequeno />
              <span>{erroGeral}</span>
            </p>
          )}
          <fieldset className="campo">
            <legend>Até onde o time da agência pode ir</legend>
            <div className="niveis">
              {NIVEIS_DO_PARCEIRO.map((k) => (
                <label className="nivel-card" key={k}>
                  <input
                    ref={k === p.max_role ? nivelAtual : undefined}
                    type="radio"
                    name="nivel-limites"
                    value={k}
                    checked={nivel === k}
                    onChange={() => setNivel(k)}
                  />
                  <span className="nivel-card-txt">
                    <b>{NIVEIS[k].nome}</b>
                    <span>{NIVEIS[k].desc}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          {aprova && (
            <div className="campo">
              <label htmlFor={`${ids}-limite`}>Aprova sozinho até, por ação</label>
              <div className="limite-linha">
                <span className="input-prefixo">
                  <span aria-hidden="true">R$</span>
                  <input
                    ref={campoLimite}
                    className="input"
                    type="number"
                    id={`${ids}-limite`}
                    min={0}
                    step={50}
                    inputMode="numeric"
                    value={limite}
                    onChange={(e) => setLimite(e.target.value)}
                    aria-invalid={erroLimite ? true : undefined}
                    aria-describedby={erroLimite ? `${ids}-limite-erro` : undefined}
                  />
                </span>
                <label className="check">
                  <input type="checkbox" checked={dupla} onChange={(e) => setDupla(e.target.checked)} /> Acima disso, eu também aprovo
                </label>
              </div>
              {erroLimite && (
                <p className="campo-erro" id={`${ids}-limite-erro`}>
                  {erroLimite}
                </p>
              )}
            </div>
          )}

          <ul className="ag-lista" aria-live="polite">
            {efeitos.map((t) => (
              <li key={t}>
                <Icone nome="arrow-right" pequeno />
                <span>{t}</span>
              </li>
            ))}
          </ul>

          {pedeCodigo && (
            <div className="campo">
              <label htmlFor={`${ids}-cod`}>Código do app autenticador</label>
              <span className="campo-dica" id={`${ids}-cod-dica`}>
                Subir o nível ou o limite pede os 6 números do app. Baixar, não.
              </span>
              <input
                ref={campoCodigo}
                className="input campo-mono"
                id={`${ids}-cod`}
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                value={codigo}
                onChange={(e) => setCodigo(e.target.value)}
                aria-invalid={erroCodigo ? true : undefined}
                aria-describedby={`${ids}-cod-dica${erroCodigo ? ` ${ids}-cod-erro` : ''}`}
              />
              {erroCodigo && (
                <p className="campo-erro" id={`${ids}-cod-erro`}>
                  {erroCodigo}
                </p>
              )}
            </div>
          )}
        </div>
        <div className="dialogo-acoes">
          <button className="btn" type="button" onClick={fechar} disabled={enviando}>
            Cancelar
          </button>
          <button className="btn btn--primary" type="submit" disabled={enviando} aria-busy={enviando}>
            {enviando ? 'Salvando…' : 'Salvar'}
          </button>
        </div>
      </form>
    </dialog>
  );
}
