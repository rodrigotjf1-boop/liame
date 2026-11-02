'use client';

import type { MyAccountRecoveryResponse } from '@liame/contracts';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { Icone } from '@/components/ui/icone';
import { api, chamar, type Problema } from '@/lib/api';
import { fraseDoMotivo, usarAChave } from '@/lib/chave-de-acesso';
import { disparar } from '@/lib/disparar';
import { voltaSegura } from '@/lib/entrada';
import { useCena, useLia } from './lia';
import { AvisoProblema, BotaoEnviar } from './pecas';
import { emAndamento } from './recuperacao-textos';

// Segundo fator na entrada (ADR-013): código do app ou um código de recuperação (uso único). Quem tem chave de acesso
// (A7, W9, parte 9c2; P28; D-A7-56) vê "Confirme que é você" com a chave primeiro; os códigos abrem por baixo.

type Codigo = 'app' | 'rec';

export function TelaSegundoFator() {
  const router = useRouter();
  const volta = voltaSegura(useSearchParams().get('volta'));
  const lia = useLia();

  const [pronto, setPronto] = useState(false);
  const [metodos, setMetodos] = useState<readonly string[]>([]);
  // Sem chave, o código do app aparece direto (como antes); com chave, os códigos abrem por escolha.
  const [visivel, setVisivel] = useState<Codigo | null>('app');
  const [codigo, setCodigo] = useState('');
  const [problema, setProblema] = useState<Problema | null>(null);
  const [enviando, setEnviando] = useState(false);
  const [usandoChave, setUsandoChave] = useState(false);
  const campo = useRef<HTMLInputElement>(null);
  const temChave = metodos.includes('chave');
  const temApp = metodos.includes('totp');
  useCena(temChave ? 'Só mais um passo: confirmar que é você.' : 'Só mais um passo: o código do seu app autenticador.');

  // A recuperação da conta pela DMS (A7, W8, parte 5): se há pedido andando e se dá para pedir. Sem a leitura, o texto
  // de antes ("fale com o suporte").
  const [rec, setRec] = useState<MyAccountRecoveryResponse | null>(null);
  const pedidoAndando = emAndamento(rec?.recovery ?? null);
  const paginaDaRecuperacao = `/segundo-fator/recuperacao?volta=${encodeURIComponent(volta)}`;

  // Só fica aqui quem entrou e ainda não confirmou o segundo fator.
  useEffect(() => {
    let viva = true;
    disparar(
      chamar(() => api.GET('/v1/me')).then(async (r) => {
        if (!viva) return;
        if (!r.ok) return router.replace(`/entrar?volta=${encodeURIComponent(volta)}`);
        if (r.data.mfa === 'required') {
          const m = r.data.mfa_methods ?? [];
          setMetodos(m);
          if (m.includes('chave')) setVisivel(null);
          setPronto(true);
          const l = await chamar(() => api.GET('/v1/me/account-recovery'));
          if (viva && l.ok) setRec(l.data);
          return;
        }
        if (r.data.mfa_enrollment_required) return router.replace(`/segundo-fator/ativar?volta=${encodeURIComponent(volta)}`);
        router.replace(volta);
      }),
    );
    return () => {
      viva = false;
    };
  }, [router, volta]);

  const trocou = useRef(false);
  function mostrarCodigo(qual: Codigo | null) {
    trocou.current = true;
    setVisivel(qual);
    setCodigo('');
    setProblema(null);
  }
  // Foco no campo novo depois do commit (sem requestAnimationFrame, ERR-019).
  useEffect(() => {
    if (trocou.current) campo.current?.focus();
    trocou.current = false;
  }, [visivel]);

  function falhou(p: Problema) {
    setProblema(p);
    setCodigo('');
    lia.reagir('empathetic', 2800);
    campo.current?.focus();
  }

  async function confirmar(e: FormEvent) {
    e.preventDefault();
    setProblema(null);
    const recuperacao = visivel === 'rec';
    const valor = recuperacao ? codigo.trim().toUpperCase() : codigo.replace(/\D/g, '');
    if (!recuperacao && valor.length !== 6)
      return falhou({ status: 0, code: 'codigo', title: 'O código tem 6 dígitos', detail: 'Digite ou cole o código que aparece no app agora.' });
    // Base32 (A–Z, 2–7); 0 e 1 no lugar de O e I são aceitos (a API normaliza).
    if (recuperacao && !/^[A-Z0-7]{5}-?[A-Z0-7]{5}$/.test(valor.replace(/\s/g, '')))
      return falhou({ status: 0, code: 'codigo', title: 'Código de recuperação inválido', detail: 'Ele tem 10 letras e números, como 7KQ2M-XH4RP.' });
    setEnviando(true);
    lia.reagir('think');
    const r = await chamar(() => api.POST('/v1/me/mfa/verify', { body: { code: valor } }));
    setEnviando(false);
    if (!r.ok) return falhou(r.problema);
    lia.reagir('happy', 1500);
    router.replace(volta);
  }

  /** A chave de acesso no lugar do código (D-A7-56): o desafio, a janela do aparelho e a confirmação. */
  async function comChave() {
    setProblema(null);
    setUsandoChave(true);
    lia.reagir('think');
    try {
      const o = await chamar(() => api.POST('/v1/me/mfa/passkey-options'));
      if (!o.ok) return falhou(o.problema);
      const chave = await usarAChave(o.data.options);
      if (!chave.ok) return falhou({ status: 0, code: 'chave', title: 'A chave não foi usada', detail: fraseDoMotivo(chave.motivo, 'use um código') });
      const r = await chamar(() => api.POST('/v1/me/mfa/passkey', { body: { challenge_id: o.data.challenge_id, response: chave.resposta } }));
      if (!r.ok) return falhou(r.problema);
      lia.reagir('happy', 1500);
      router.replace(volta);
    } finally {
      setUsandoChave(false);
    }
  }

  async function sair() {
    await chamar(() => api.POST('/v1/auth/logout'));
    router.replace('/entrar');
  }

  if (!pronto) return <p className="rotulo-marca" aria-busy="true">Conferindo a sua sessão…</p>;
  const recuperacao = visivel === 'rec';
  return (
    <section className="tela" aria-labelledby="t-2f">
      <div className="tela-cab">
        <h1 id="t-2f">{temChave ? 'Confirme que é você' : 'Digite o código do app'}</h1>
        <p>
          {temChave
            ? 'A senha está certa. Falta a segunda confirmação.'
            : 'Abra o app autenticador (Google Authenticator, Microsoft Authenticator, 1Password ou outro) e digite o código de 6 dígitos do Liame.'}
        </p>
      </div>
      <AvisoProblema problema={problema} />
      {temChave && (
        <button className="btn btn--primary btn--largo" type="button" onClick={() => disparar(comChave())} disabled={usandoChave || enviando} aria-busy={usandoChave}>
          <Icone nome="key" />
          {usandoChave ? 'Esperando o aparelho…' : 'Confirmar com a chave de acesso'}
        </button>
      )}
      {visivel && (
        <form className="form" onSubmit={(e) => disparar(confirmar(e))} noValidate>
          {recuperacao ? (
            <div className="campo">
              <label htmlFor="c-rec">Código de recuperação</label>
              <input
                ref={campo}
                className="input codigo-rec"
                id="c-rec"
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                placeholder="7KQ2M-XH4RP"
                value={codigo}
                onChange={(e) => setCodigo(e.target.value)}
                aria-invalid={problema ? true : undefined}
                aria-describedby="c-rec-dica"
              />
              <span className="campo-dica" id="c-rec-dica">
                Um dos 10 códigos que você guardou ao ativar o app ou ao criar a primeira chave. Cada um vale uma vez.
              </span>
            </div>
          ) : (
            <div className="campo">
              <label htmlFor="c-app">Código de 6 dígitos</label>
              <input
                ref={campo}
                className="input codigo"
                id="c-app"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]*"
                maxLength={7}
                placeholder="000000"
                value={codigo}
                onChange={(e) => {
                  // Colar funciona (WCAG 2.2 SC 3.3.8): fica só com os dígitos.
                  setCodigo(e.target.value.replace(/\D/g, '').slice(0, 6));
                  lia.reagir('listen');
                }}
                aria-invalid={problema ? true : undefined}
                aria-describedby="c-app-dica"
              />
              <span className="campo-dica" id="c-app-dica">
                Dá para colar o código.
              </span>
            </div>
          )}
          {temChave ? (
            <button className="btn segundo-fator-codigo" type="submit" disabled={enviando || usandoChave} aria-busy={enviando}>
              {enviando ? 'Conferindo…' : 'Confirmar com o código'}
            </button>
          ) : (
            <BotaoEnviar enviando={enviando}>Confirmar</BotaoEnviar>
          )}
        </form>
      )}
      <p className="alternativa segundo-fator-alt">
        {temChave ? (
          <>
            {temApp && (
              <button className="link-bt" type="button" aria-expanded={visivel === 'app'} onClick={() => mostrarCodigo(visivel === 'app' ? null : 'app')}>
                Usar o código do app
              </button>
            )}
            <button className="link-bt" type="button" aria-expanded={visivel === 'rec'} onClick={() => mostrarCodigo(visivel === 'rec' ? null : 'rec')}>
              Usar um código de recuperação
            </button>
          </>
        ) : (
          <button className="link-bt" type="button" onClick={() => mostrarCodigo(recuperacao ? 'app' : 'rec')}>
            {recuperacao ? 'Usar o código do app' : 'Usar um código de recuperação'}
          </button>
        )}
      </p>
      <details className="ajuda" open={pedidoAndando || undefined}>
        <summary>Perdeu o celular?</summary>
        <div>
          <p>
            Entre com um dos seus códigos de recuperação. Depois de entrar, peça a troca do app: por segurança, a troca vale em 24 horas e avisamos
            você por e-mail.
          </p>
          {pedidoAndando ? (
            <p>
              Você tem um pedido de recuperação em andamento (<span className="num">{rec?.recovery?.protocol}</span>).{' '}
              <Link className="link-bt" href={paginaDaRecuperacao}>
                Ver o pedido
              </Link>
            </p>
          ) : rec?.cannot_request === null ? (
            <>
              <p>
                <b>Sem o celular e sem os códigos?</b> Peça a recuperação da conta. A DMS confere quem você é e, depois de uma espera de segurança, você
                cadastra o app de novo.
              </p>
              <Link className="btn" href={paginaDaRecuperacao}>
                Pedir a recuperação da conta
              </Link>
            </>
          ) : (
            <p>Sem o celular e sem os códigos, fale com o suporte{rec ? `: ${rec.support.email}` : ''}.</p>
          )}
        </div>
      </details>
      <p className="alternativa">
        Não é você?{' '}
        <button className="link-bt" type="button" onClick={() => disparar(sair())}>
          Sair
        </button>
      </p>
    </section>
  );
}
