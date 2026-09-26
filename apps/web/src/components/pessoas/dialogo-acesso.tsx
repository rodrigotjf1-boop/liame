'use client';

import type { MemberResponse, RoleKey } from '@liame/contracts';
import { type FormEvent, useEffect, useId, useRef, useState } from 'react';
import { Icone } from '@/components/ui/icone';
import { api, chamar, mensagemDe, novaChave, type Problema } from '@/lib/api';
import { fimDoDia, hojeSeletor, MICROS, moeda, paraSeletor } from '@/lib/formato';
import { APROVAM, CONVIDAVEIS, NIVEIS, type NivelConvidavel, RANK } from '@/lib/niveis';
import { disparar } from '@/lib/disparar';

// Convidar pessoa ou alterar o acesso de quem já está (protótipo aprovado, ADR-017). A tela só evita
// pedir o que o servidor recusaria; ele confere tudo de novo e a mensagem dele aparece aqui.

export type ModoDialogo = { tipo: 'convidar' } | { tipo: 'alterar'; pessoa: MemberResponse };

type Props = {
  modo: ModoDialogo;
  /** Quem concede: o próprio nível e limite na empresa. */
  eu: { role: RoleKey; limite: number | null };
  /** E-mails que já têm acesso ou convite em aberto (o convite repetido se faz pelo "Reenviar"). */
  emailsOcupados: Set<string>;
  aoFechar: () => void;
  aoConcluir: (aviso: string) => void;
};

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function DialogoAcesso({ modo, eu, emailsOcupados, aoFechar, aoConcluir }: Props) {
  const dialogo = useRef<HTMLDialogElement>(null);
  const campoEmail = useRef<HTMLInputElement>(null);
  const origem = useRef<Element | null>(null);
  const chave = useRef(novaChave());
  const ids = useId();

  const p = modo.tipo === 'alterar' ? modo.pessoa : null;
  const souDono = eu.role === 'dono';
  const inicial = {
    nivel: (p ? p.role : 'administrador') as NivelConvidavel,
    limite: p?.approve_limit_micros != null ? String(p.approve_limit_micros / MICROS) : '500',
    dupla: p ? p.dual_approval : true,
    cobranca: p ? p.billing_access : false,
    ate: p?.expires_at ? paraSeletor(p.expires_at) : '',
  };

  const [email, setEmail] = useState(p?.email ?? '');
  const [nivel, setNivel] = useState<NivelConvidavel>(RANK[inicial.nivel] > RANK[eu.role] ? 'somente_leitura' : inicial.nivel);
  const [limite, setLimite] = useState(inicial.limite);
  const [dupla, setDupla] = useState(inicial.dupla);
  const [cobranca, setCobranca] = useState(inicial.cobranca);
  const [ate, setAte] = useState(inicial.ate);
  const [erroEmail, setErroEmail] = useState('');
  const [erroLimite, setErroLimite] = useState('');
  const [erroGeral, setErroGeral] = useState('');
  const [enviando, setEnviando] = useState(false);

  const aprova = APROVAM.has(nivel);
  const limiteMax = !souDono && eu.limite !== null ? eu.limite / MICROS : undefined;

  // Abre uma vez, ao montar (o modo estrito do React roda o efeito duas vezes: por isso a guarda).
  const editando = p !== null;
  useEffect(() => {
    const d = dialogo.current;
    if (!d || d.open) return;
    origem.current = document.activeElement;
    d.showModal();
    if (editando) d.querySelector<HTMLInputElement>('input[name="nivel"]:checked')?.focus();
    else campoEmail.current?.focus();
  }, [editando]);

  function fechar() {
    dialogo.current?.close();
  }

  function aoFecharDialogo() {
    const alvo = origem.current;
    aoFechar();
    if (alvo instanceof HTMLElement && alvo.isConnected) alvo.focus({ preventScroll: true });
  }

  function mostrarProblema(problema: Problema) {
    const doEmail = problema.errors?.find((e) => e.path === 'email');
    if (doEmail || problema.code === 'ja-tem-acesso') {
      setErroEmail(doEmail?.message ?? mensagemDe(problema));
      campoEmail.current?.focus();
      return;
    }
    const doLimite = problema.errors?.find((e) => e.path === 'approve_limit_micros');
    if (doLimite || problema.code === 'limite-acima-do-seu') {
      setErroLimite(doLimite?.message ?? mensagemDe(problema));
      return;
    }
    setErroGeral(mensagemDe(problema));
  }

  async function enviar(e: FormEvent) {
    e.preventDefault();
    setErroEmail('');
    setErroLimite('');
    setErroGeral('');

    const normalizado = email.trim().toLowerCase();
    if (!p) {
      const problema = !EMAIL.test(normalizado)
        ? 'Digite um e-mail válido, como nome@empresa.com.br.'
        : emailsOcupados.has(normalizado)
          ? 'Essa pessoa já tem acesso ou um convite esperando resposta.'
          : '';
      if (problema) {
        setErroEmail(problema);
        campoEmail.current?.focus();
        return;
      }
    }
    let limiteMicros: number | undefined;
    if (aprova) {
      const valor = Number(limite);
      if (limite.trim() === '' || !Number.isFinite(valor) || valor < 0) {
        setErroLimite('Informe até quanto a pessoa aprova sozinha (pode ser zero).');
        return;
      }
      if (limiteMax !== undefined && valor > limiteMax) {
        setErroLimite(`O seu limite é ${moeda(eu.limite!)}: você não pode dar um limite maior.`);
        return;
      }
      limiteMicros = Math.round(valor * MICROS);
    }

    setEnviando(true);
    const cobrancaFinal = cobranca && nivel === 'administrador';
    if (!p) {
      const r = await chamar(() =>
        api.POST('/v1/invitations', {
          headers: { 'Idempotency-Key': chave.current },
          body: {
            email: normalizado,
            role: nivel,
            ...(aprova ? { approve_limit_micros: limiteMicros } : {}),
            dual_approval: aprova ? dupla : true,
            billing_access: cobrancaFinal,
            ...(ate ? { access_expires_at: fimDoDia(ate) } : {}),
          },
        }),
      );
      setEnviando(false);
      if (!r.ok) {
        chave.current = novaChave();
        return mostrarProblema(r.problema);
      }
      aoConcluir(`Convite enviado para ${normalizado}. Vale 7 dias e só funciona para esse e-mail.`);
      return fechar();
    }

    // Alterar: só o que mudou vai para a API (o que o dono já concedeu continua valendo).
    const mudancas: {
      role?: NivelConvidavel;
      approve_limit_micros?: number;
      dual_approval?: boolean;
      billing_access?: boolean;
      expires_at?: string | null;
    } = {};
    if (nivel !== p.role) mudancas.role = nivel;
    if (aprova && (limiteMicros !== p.approve_limit_micros || !APROVAM.has(p.role))) mudancas.approve_limit_micros = limiteMicros;
    if (aprova && dupla !== p.dual_approval) mudancas.dual_approval = dupla;
    if (cobrancaFinal !== p.billing_access) mudancas.billing_access = cobrancaFinal;
    if (ate !== inicial.ate) mudancas.expires_at = ate ? fimDoDia(ate) : null;
    if (!Object.keys(mudancas).length) {
      setEnviando(false);
      return fechar();
    }
    const r = await chamar(() =>
      api.PATCH('/v1/members/{id}', {
        params: { path: { id: p.id } },
        headers: { 'Idempotency-Key': chave.current },
        body: mudancas,
      }),
    );
    setEnviando(false);
    if (!r.ok) {
      chave.current = novaChave();
      return mostrarProblema(r.problema);
    }
    aoConcluir(`Acesso de ${p.name} atualizado.`);
    fechar();
  }

  const titulo = p ? `Alterar o acesso de ${p.name}` : 'Convidar pessoa';
  return (
    <dialog
      ref={dialogo}
      className="dialogo"
      aria-labelledby={`${ids}-t`}
      onClose={aoFecharDialogo}
      onClick={(e) => {
        if (e.target === dialogo.current && !enviando) fechar();
      }}
    >
      <form className="dialogo-form" onSubmit={(e) => disparar(enviar(e))} noValidate>
        <div className="dialogo-cab">
          <h2 id={`${ids}-t`}>{titulo}</h2>
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
          <div className="campo">
            <label htmlFor={`${ids}-email`}>E-mail da pessoa</label>
            <input
              ref={campoEmail}
              className="input"
              type="email"
              id={`${ids}-email`}
              autoComplete="off"
              placeholder="nome@empresa.com.br"
              value={email}
              readOnly={!!p}
              onChange={(e) => setEmail(e.target.value)}
              aria-invalid={erroEmail ? true : undefined}
              aria-describedby={erroEmail ? `${ids}-email-erro` : undefined}
            />
            {erroEmail && (
              <p className="campo-erro" id={`${ids}-email-erro`}>
                {erroEmail}
              </p>
            )}
          </div>

          <fieldset className="campo">
            <legend>Nível de acesso</legend>
            <div className="niveis">
              {CONVIDAVEIS.map((k) => {
                const acima = RANK[k] > RANK[eu.role];
                return (
                  <label className="nivel-card" key={k}>
                    <input type="radio" name="nivel" value={k} checked={nivel === k} disabled={acima} onChange={() => setNivel(k)} />
                    <span className="nivel-card-txt">
                      <b>{NIVEIS[k].nome}</b>
                      <span>{acima ? 'Acima do seu nível: só quem tem esse nível ou mais pode dar.' : NIVEIS[k].desc}</span>
                    </span>
                  </label>
                );
              })}
            </div>
          </fieldset>

          {aprova && (
            <fieldset className="campo">
              <legend>Limites</legend>
              <div className="campo-linha">
                <label htmlFor={`${ids}-limite`}>Pode aprovar gastos sozinho até</label>
                <span className="input-prefixo">
                  <span aria-hidden="true">R$</span>
                  <input
                    className="input"
                    type="number"
                    id={`${ids}-limite`}
                    min={0}
                    max={limiteMax}
                    step={50}
                    inputMode="numeric"
                    value={limite}
                    onChange={(e) => setLimite(e.target.value)}
                    aria-invalid={erroLimite ? true : undefined}
                    aria-describedby={`${ids}-limite-dica${erroLimite ? ` ${ids}-limite-erro` : ''}`}
                  />
                </span>
                <span className="campo-dica" id={`${ids}-limite-dica`}>
                  por ação{limiteMax !== undefined ? ` (o seu limite é ${moeda(eu.limite!)})` : ''}
                </span>
              </div>
              {erroLimite && (
                <p className="campo-erro" id={`${ids}-limite-erro`}>
                  {erroLimite}
                </p>
              )}
              <label className="check">
                <input type="checkbox" checked={dupla} disabled={!souDono && dupla} onChange={(e) => setDupla(e.target.checked)} />
                {souDono ? 'Acima disso, eu também preciso aprovar' : 'Acima disso, o dono também aprova (só ele dispensa)'}
              </label>
              {nivel === 'administrador' && souDono && (
                <label className="check">
                  <input type="checkbox" checked={cobranca} onChange={(e) => setCobranca(e.target.checked)} /> Pode ver e pagar a cobrança
                </label>
              )}
            </fieldset>
          )}

          <div className="campo">
            <label htmlFor={`${ids}-ate`}>
              Acesso até <span className="campo-dica">(opcional; sem data, vale até você remover)</span>
            </label>
            <input className="input" type="date" id={`${ids}-ate`} min={hojeSeletor()} value={ate} onChange={(e) => setAte(e.target.value)} />
          </div>

          {!p && (
            <p className="dialogo-nota">
              <Icone nome="shield" pequeno />
              <span>
                O convite vale 7 dias e só funciona para esse e-mail. A pessoa cria o próprio login, com app autenticador. Você remove o
                acesso quando quiser.
              </span>
            </p>
          )}
        </div>
        <div className="dialogo-acoes">
          <button className="btn" type="button" onClick={fechar} disabled={enviando}>
            Cancelar
          </button>
          <button className="btn btn--primary" type="submit" disabled={enviando} aria-busy={enviando}>
            {enviando ? (p ? 'Salvando…' : 'Enviando…') : p ? 'Salvar' : 'Enviar convite'}
          </button>
        </div>
      </form>
    </dialog>
  );
}
