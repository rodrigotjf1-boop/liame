'use client';

import type { PartnerRequestResponse, PartnerRole, PasskeyAssertion } from '@liame/contracts';
import { type FormEvent, type RefObject, useId, useRef, useState } from 'react';
import { ConfirmarComChave } from '@/components/seguranca/confirmar-com-chave';
import { ConfirmaNaLinha } from '@/components/ui/confirma-na-linha';
import { Icone } from '@/components/ui/icone';
import { useDialogo } from '@/components/ui/use-dialogo';
import { api, chamar, mensagemDe, novaChave, type Problema } from '@/lib/api';
import type { Prova } from '@/lib/chave-de-acesso';
import { disparar } from '@/lib/disparar';
import { dataCompleta, fimDoDia, hojeSeletor, MICROS } from '@/lib/formato';
import { APROVAM, NIVEIS } from '@/lib/niveis';
import { type FormasDeConfirmar, useFormasDeConfirmar } from '@/lib/sessao';
import { cnpjTxt, daAgencia, NIVEIS_DO_PARCEIRO } from './parceiros';

// "O pedido da agência" (P27 aprovado, gaveta à direita; D-A7-47): o Dono escolhe até onde o time da agência vai, o
// limite por ação, "acima disso, eu também aprovo" e a data de fim, e confirma com o código do app; ou recusa, sem o
// código. O servidor confere tudo de novo; a mensagem dele aparece aqui.

type Props = {
  pedido: PartnerRequestResponse;
  nomeEmpresa: string;
  reserva: RefObject<HTMLElement | null>;
  aoAceitar: (aviso: string, nivel: PartnerRole) => void;
  aoRecusar: () => Promise<boolean>;
  /** O pedido não está mais lá (a agência cancelou, venceu ou outra aba decidiu): a tela lê de novo. */
  aoSumir: (problema: Problema) => void;
  aoFechar: () => void;
  /** Como a pessoa confirma, no lugar da sessão (os testes de desenho). */
  confirmar?: FormasDeConfirmar;
};

export function GavetaDecidir({ pedido: p, nomeEmpresa, reserva, aoAceitar, aoRecusar, aoSumir, aoFechar, confirmar }: Props) {
  const ids = useId();
  const nivelInicial = useRef<HTMLInputElement>(null);
  const campoLimite = useRef<HTMLInputElement>(null);
  const campoCodigo = useRef<HTMLInputElement>(null);
  const { ref, fechar, devolverFoco } = useDialogo({ focoInicial: nivelInicial, reserva });
  const chave = useRef(novaChave());
  const [nivel, setNivel] = useState<PartnerRole>(p.requested_role);
  const [limite, setLimite] = useState('500');
  const [dupla, setDupla] = useState(true);
  const [ate, setAte] = useState('');
  const [codigo, setCodigo] = useState('');
  const [erroLimite, setErroLimite] = useState('');
  const [erroCodigo, setErroCodigo] = useState('');
  const [erroGeral, setErroGeral] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [recusando, setRecusando] = useState(false);
  const aprova = APROVAM.has(nivel);
  // A confirmação: a chave de acesso primeiro, para quem tem, e o código do app ao lado (A7, W9, parte 9c3; D-A7-56).
  const { temApp, temChave } = useFormasDeConfirmar(confirmar);

  /** O limite, antes de qualquer confirmação: os micros (ou nada, quem não aprova); `null` = o limite não serve. */
  function conferirLimite(): { micros: number | undefined } | null {
    setErroLimite('');
    setErroCodigo('');
    setErroGeral('');
    if (!aprova) return { micros: undefined };
    const valor = Number(limite);
    if (limite.trim() === '' || !Number.isFinite(valor) || valor < 0) {
      setErroLimite('Informe até quanto a pessoa da agência aprova sozinha (pode ser zero).');
      campoLimite.current?.focus();
      return null;
    }
    return { micros: Math.round(valor * MICROS) };
  }

  async function aceitar(e: FormEvent) {
    e.preventDefault();
    if (!temApp) return;
    const lim = conferirLimite();
    if (!lim) return;
    const cod = codigo.trim();
    if (!/^\d{6}$/.test(cod)) {
      setErroCodigo('O código tem 6 números. Abra o app autenticador e digite o que aparece agora.');
      campoCodigo.current?.focus();
      return;
    }
    await mandar({ code: cod }, lim.micros);
  }

  async function comChave(passkey: PasskeyAssertion) {
    const lim = conferirLimite();
    if (lim) await mandar({ passkey }, lim.micros);
  }

  async function mandar(prova: Prova, limiteMicros: number | undefined) {
    setEnviando(true);
    const r = await chamar(() =>
      api.POST('/v1/partners/requests/{id}/accept', {
        params: { path: { id: p.id } },
        headers: { 'Idempotency-Key': chave.current },
        body: {
          max_role: nivel,
          ...(aprova ? { approve_limit_micros: limiteMicros } : {}),
          dual_approval: aprova ? dupla : true,
          ...(ate ? { ends_at: fimDoDia(ate) } : {}),
          ...prova,
        },
      }),
    );
    setEnviando(false);
    if (r.ok) {
      aoAceitar(`Pronto: ${p.agency.name} entrou como parceira, até ${NIVEIS[nivel].nome}.`, nivel);
      return fechar();
    }
    chave.current = novaChave();
    if (r.problema.status === 404) return aoSumir(r.problema);
    if ('code' in prova && (r.problema.code === 'codigo-invalido' || r.problema.errors?.some((x) => x.path === 'code'))) {
      setCodigo('');
      setErroCodigo('O código não confere. Digite o que aparece agora no app autenticador.');
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

  async function recusarAgora() {
    const ok = await aoRecusar();
    if (ok) fechar();
    else setRecusando(false);
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
      <form className="dialogo-form" onSubmit={(e) => disparar(aceitar(e))} noValidate>
        <div className="dialogo-cab">
          <h2 id={`${ids}-t`}>O pedido {daAgencia(p.agency.name)}</h2>
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
          <dl className="pedido-dados">
            <div>
              <dt>Quem pede</dt>
              <dd>
                {p.requested_by_name}, {daAgencia(p.agency.name)}
              </dd>
            </div>
            {p.agency.cnpj && (
              <div>
                <dt>CNPJ informado pela agência</dt>
                <dd className="campo-mono">{cnpjTxt(p.agency.cnpj)}</dd>
              </div>
            )}
            <div>
              <dt>A agência pede</dt>
              <dd>{NIVEIS[p.requested_role].nome}</dd>
            </div>
            <div>
              <dt>Vale até</dt>
              <dd>{dataCompleta(p.expires_at)}</dd>
            </div>
          </dl>
          {p.message && <blockquote className="pedido-msg">“{p.message}”</blockquote>}

          <fieldset className="campo">
            <legend>Até onde o time da agência pode ir</legend>
            <span className="campo-dica">É o máximo: a agência coloca cada pessoa neste nível ou abaixo.</span>
            <div className="niveis">
              {NIVEIS_DO_PARCEIRO.map((k) => (
                <label className="nivel-card" key={k}>
                  <input
                    ref={k === p.requested_role ? nivelInicial : undefined}
                    type="radio"
                    name="nivel-parceiro"
                    value={k}
                    checked={nivel === k}
                    onChange={() => setNivel(k)}
                  />
                  <span className="nivel-card-txt">
                    <b>{NIVEIS[k].nome}</b>
                    <span>
                      {NIVEIS[k].desc}
                      {k === p.requested_role ? ' É o que a agência pediu.' : ''}
                    </span>
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
                    aria-describedby={`${ids}-limite-dica${erroLimite ? ` ${ids}-limite-erro` : ''}`}
                  />
                </span>
                <label className="check">
                  <input type="checkbox" checked={dupla} onChange={(e) => setDupla(e.target.checked)} /> Acima disso, eu também aprovo
                </label>
              </div>
              <span className="campo-dica" id={`${ids}-limite-dica`}>
                Nenhuma pessoa da agência passa deste valor.
              </span>
              {erroLimite && (
                <p className="campo-erro" id={`${ids}-limite-erro`}>
                  {erroLimite}
                </p>
              )}
            </div>
          )}

          <div className="campo">
            <label htmlFor={`${ids}-ate`}>
              Acesso até <span className="campo-dica">Opcional</span>
            </label>
            <input
              className="input"
              type="date"
              id={`${ids}-ate`}
              min={hojeSeletor()}
              value={ate}
              onChange={(e) => setAte(e.target.value)}
              aria-describedby={`${ids}-ate-dica`}
            />
            <span className="campo-dica" id={`${ids}-ate-dica`}>
              Em branco, o vínculo fica até você desfazer.
            </span>
          </div>

          <p className="ag-fixo">
            <Icone nome="lock" pequeno />
            <span>
              <b>A cobrança fica com você.</b> O time da agência não vê nem paga a cobrança, e não convida nem remove pessoas da{' '}
              {nomeEmpresa}.
            </span>
          </p>

          {temChave && (
            <ConfirmarComChave
              rotulo="Aceitar com a chave"
              impedido={enviando}
              alternativa={temApp ? 'use o código do app' : 'tente de novo'}
              antes={() => conferirLimite() !== null}
              aoErro={setErroGeral}
              aoProvar={comChave}
            />
          )}
          {temApp && (
            <div className="campo">
              <label htmlFor={`${ids}-cod`}>{temChave ? 'Ou o código do app autenticador' : 'Código do app autenticador'}</label>
              <span className="campo-dica" id={`${ids}-cod-dica`}>
                Dar acesso a uma agência pede a sua confirmação: a chave de acesso ou os 6 números do app.
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
          {recusando ? (
            <ConfirmaNaLinha
              texto="Recusar o pedido? A agência fica sabendo, sem o motivo."
              rotulo="Recusar o pedido"
              rotuloOcupado="Recusando…"
              voltar="Voltar"
              ocupado={false}
              aoConfirmar={() => disparar(recusarAgora())}
              aoCancelar={() => setRecusando(false)}
            />
          ) : (
            <>
              <button className="btn btn--perigo" type="button" onClick={() => setRecusando(true)} disabled={enviando}>
                Recusar
              </button>
              {temApp && (
                <button className={`btn${temChave ? '' : ' btn--primary'}`} type="submit" disabled={enviando} aria-busy={enviando}>
                  {enviando ? 'Aceitando…' : temChave ? 'Aceitar com o código' : 'Aceitar o vínculo'}
                </button>
              )}
            </>
          )}
        </div>
      </form>
    </dialog>
  );
}
