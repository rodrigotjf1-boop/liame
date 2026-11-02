'use client';

import type { MyAccountRecoveryResponse } from '@liame/contracts';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { api, chamar, type Problema } from '@/lib/api';
import { disparar } from '@/lib/disparar';
import { voltaSegura } from '@/lib/entrada';
import { useCena, useLia } from './lia';
import { AvisoProblema, BotaoEnviar } from './pecas';
import { emAndamento } from './recuperacao-textos';

// Segundo fator na entrada (ADR-013): código do app ou um código de recuperação (uso único).

export function TelaSegundoFator() {
  const router = useRouter();
  const volta = voltaSegura(useSearchParams().get('volta'));
  const lia = useLia();
  useCena('Só mais um passo: o código do seu app autenticador.');

  const [pronto, setPronto] = useState(false);
  const [recuperacao, setRecuperacao] = useState(false);
  const [codigo, setCodigo] = useState('');
  const [problema, setProblema] = useState<Problema | null>(null);
  const [enviando, setEnviando] = useState(false);
  const campo = useRef<HTMLInputElement>(null);

  // A recuperação da conta pela DMS (A7, W8, parte 5): se há pedido andando e se dá para pedir. Sem a leitura, o texto
  // de antes ("fale com o suporte").
  const [rec, setRec] = useState<MyAccountRecoveryResponse | null>(null);
  const pedidoAndando = emAndamento(rec?.recovery ?? null);
  const paginaDaRecuperacao = `/segundo-fator/recuperacao?volta=${encodeURIComponent(volta)}`;

  // Só fica aqui quem entrou e ainda não confirmou o app.
  useEffect(() => {
    let viva = true;
    disparar(
      chamar(() => api.GET('/v1/me')).then(async (r) => {
        if (!viva) return;
        if (!r.ok) return router.replace(`/entrar?volta=${encodeURIComponent(volta)}`);
        if (r.data.mfa === 'required') {
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
  function trocarModo() {
    trocou.current = true;
    setRecuperacao((r) => !r);
    setCodigo('');
    setProblema(null);
  }
  // Foco no campo novo depois do commit (sem requestAnimationFrame, ERR-019).
  useEffect(() => {
    if (trocou.current) campo.current?.focus();
    trocou.current = false;
  }, [recuperacao]);

  function falhou(p: Problema) {
    setProblema(p);
    setCodigo('');
    lia.reagir('empathetic', 2800);
    campo.current?.focus();
  }

  async function confirmar(e: FormEvent) {
    e.preventDefault();
    setProblema(null);
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

  async function sair() {
    await chamar(() => api.POST('/v1/auth/logout'));
    router.replace('/entrar');
  }

  if (!pronto) return <p className="rotulo-marca" aria-busy="true">Conferindo a sua sessão…</p>;
  return (
    <section className="tela" aria-labelledby="t-2f">
      <div className="tela-cab">
        <h1 id="t-2f">Digite o código do app</h1>
        <p>Abra o app autenticador (Google Authenticator, Microsoft Authenticator, 1Password ou outro) e digite o código de 6 dígitos do Liame.</p>
      </div>
      <AvisoProblema problema={problema} />
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
              Um dos 10 códigos que você guardou ao ativar o app. Cada um vale uma vez.
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
        <BotaoEnviar enviando={enviando}>Confirmar</BotaoEnviar>
      </form>
      <p className="alternativa">
        <button className="link-bt" type="button" onClick={trocarModo}>
          {recuperacao ? 'Usar o código do app' : 'Usar um código de recuperação'}
        </button>
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
