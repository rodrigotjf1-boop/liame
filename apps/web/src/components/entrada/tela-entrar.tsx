'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { Icone } from '@/components/ui/icone';
import type { PasskeyCeremony } from '@liame/contracts';
import { api, chamar, type Problema } from '@/lib/api';
import { campoOfereceChave, cancelarAJanela, fraseDoMotivo, type MotivoDaChave, usarAChave, usarAChaveNoCampo } from '@/lib/chave-de-acesso';
import { disparar } from '@/lib/disparar';
import { destinoDepoisDeEntrar, voltaSegura } from '@/lib/entrada';
import { useCena, useLia } from './lia';
import { AvisoProblema, BotaoEnviar, CampoSenha } from './pecas';

// Entrar no Liame: o e-mail e a senha, ou a chave de acesso (A7, W9, parte 9c2; P28; D-A7-55). A chave vale pela senha e
// pelo código do app: quem entra com ela já sai com a sessão verificada. O navegador oferece a chave no próprio campo do
// e-mail quando o aparelho tem uma (o preenchimento, `autocomplete="username webauthn"`).

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** A chave não veio: a frase de cada motivo, com a senha como alternativa. */
function problemaDaChave(motivo: MotivoDaChave): Problema {
  return { status: 0, code: 'chave', title: 'A chave não foi usada', detail: fraseDoMotivo(motivo, 'entre com a senha') };
}

export function TelaEntrar() {
  const router = useRouter();
  const volta = voltaSegura(useSearchParams().get('volta'));
  const lia = useLia();
  useCena('Oi! Que bom te ver de novo. Enquanto você entra, a equipe continua trabalhando.', 'wave');

  const [email, setEmail] = useState('');
  const [senha, setSenha] = useState('');
  const [mostrar, setMostrar] = useState(false);
  const [problema, setProblema] = useState<Problema | null>(null);
  const [campo, setCampo] = useState<'email' | 'senha' | null>(null);
  const [enviando, setEnviando] = useState(false);
  const [comChave, setComChave] = useState(false);
  const [noCampo, setNoCampo] = useState(false);
  // A chave na entrada só com a flag ligada para todos (A7, W9, parte 9d): a tela pergunta à API ao abrir.
  const [chaveLigada, setChaveLigada] = useState(false);
  const refEmail = useRef<HTMLInputElement>(null);
  const montada = useRef(true);

  function falhou(p: Problema, qual: 'email' | 'senha' | null) {
    setProblema(p);
    setCampo(qual);
    lia.reagir('empathetic', 2800);
    if (qual === 'email') refEmail.current?.focus();
    else if (qual === 'senha') document.getElementById('en-senha')?.focus();
  }

  /** O que o aparelho assinou vai para a API; a sessão já vem verificada. */
  async function concluirComChave(desafio: string, resposta: Record<string, unknown>): Promise<boolean> {
    const r = await chamar(() => api.POST('/v1/auth/passkey', { body: { challenge_id: desafio, response: resposta } }));
    if (!r.ok) {
      falhou(r.problema, null);
      return false;
    }
    lia.reagir('happy', 1500);
    router.replace(destinoDepoisDeEntrar(r.data, volta));
    return true;
  }

  /**
   * O preenchimento do navegador: pede o desafio e espera a pessoa escolher a chave no campo do e-mail. Fechar, trocar
   * pelo botão ou sair da tela encerram a espera sem aviso; a recusa da API aparece e a oferta volta.
   */
  async function esperarNoCampo(primeira?: PasskeyCeremony) {
    let desafio = primeira;
    if (!desafio) {
      const o = await chamar(() => api.POST('/v1/auth/passkey-options'));
      if (!o.ok || !montada.current) return;
      desafio = o.data;
    }
    if (!montada.current) return;
    const chave = await usarAChaveNoCampo(desafio.options);
    if (!chave.ok || !montada.current) return;
    setProblema(null);
    setComChave(true);
    const entrou = await concluirComChave(desafio.challenge_id, chave.resposta);
    setComChave(false);
    if (!entrou && montada.current) disparar(esperarNoCampo());
  }

  // Já tem sessão: segue direto para onde ia (ou para o segundo fator, se faltar). Sem sessão, o navegador pode
  // oferecer a chave no campo do e-mail.
  useEffect(() => {
    montada.current = true;
    let viva = true;
    disparar(
      chamar(() => api.GET('/v1/me')).then(async (r) => {
        if (!viva) return;
        if (r.ok) return router.replace(destinoDepoisDeEntrar(r.data, volta));
        // Desligada (409) ou sem resposta: a entrada fica só com a senha.
        const o = await chamar(() => api.POST('/v1/auth/passkey-options'));
        if (!viva || !o.ok) return;
        setChaveLigada(true);
        if ((await campoOfereceChave()) && viva) {
          setNoCampo(true);
          disparar(esperarNoCampo(o.data));
        }
      }),
    );
    return () => {
      viva = false;
      montada.current = false;
      cancelarAJanela();
    };
    // `esperarNoCampo` lê só refs e funções estáveis da tela; a oferta começa uma vez por visita.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router, volta]);

  async function entrar(e: FormEvent) {
    e.preventDefault();
    setProblema(null);
    setCampo(null);
    const normalizado = email.trim();
    if (!EMAIL.test(normalizado)) return falhou({ status: 0, code: 'email', title: 'E-mail inválido', detail: 'Confira o endereço, como nome@empresa.com.br.' }, 'email');
    if (!senha) return falhou({ status: 0, code: 'senha', title: 'Falta a senha', detail: chaveLigada ? 'Digite a senha, ou entre com a chave de acesso.' : 'Digite a senha da sua conta.' }, 'senha');
    setEnviando(true);
    lia.reagir('think');
    const r = await chamar(() => api.POST('/v1/auth/login', { body: { email: normalizado, password: senha } }));
    setEnviando(false);
    if (!r.ok) {
      if (r.problema.code === 'credenciais-invalidas') setSenha('');
      return falhou(r.problema, r.problema.code === 'credenciais-invalidas' ? 'senha' : null);
    }
    lia.reagir('happy', 1500);
    router.replace(destinoDepoisDeEntrar(r.data, volta));
  }

  /** O botão: a janela do aparelho com as chaves dele (sem chave no aparelho, o próprio sistema oferece o celular pelo QR). */
  async function entrarComChave() {
    setProblema(null);
    setCampo(null);
    setComChave(true);
    lia.reagir('think');
    let entrou = false;
    try {
      const o = await chamar(() => api.POST('/v1/auth/passkey-options'));
      if (!o.ok) return falhou(o.problema, null);
      const chave = await usarAChave(o.data.options);
      if (!chave.ok) return falhou(problemaDaChave(chave.motivo), null);
      entrou = await concluirComChave(o.data.challenge_id, chave.resposta);
    } finally {
      setComChave(false);
      // O botão encerrou a oferta do campo: ela volta se a pessoa ainda não entrou.
      if (!entrou && noCampo && montada.current) disparar(esperarNoCampo());
    }
  }

  return (
    <section className="tela" aria-labelledby="t-entrar">
      <div className="tela-cab">
        <h1 id="t-entrar">Entrar no Liame</h1>
        <p>Use o e-mail da sua conta.</p>
      </div>
      <AvisoProblema problema={problema} />
      <form className="form" onSubmit={(e) => disparar(entrar(e))} noValidate>
        <div className="campo">
          <label htmlFor="en-email">E-mail</label>
          <input
            ref={refEmail}
            className="input"
            id="en-email"
            type="email"
            autoComplete="username webauthn"
            inputMode="email"
            required
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              lia.reagir('listen');
            }}
            aria-invalid={campo === 'email' ? true : undefined}
            aria-describedby={noCampo ? 'en-email-dica' : undefined}
          />
          {noCampo && (
            <span className="campo-dica" id="en-email-dica">
              O navegador oferece a chave de acesso no próprio campo.
            </span>
          )}
        </div>
        <CampoSenha
          id="en-senha"
          rotulo="Senha"
          valor={senha}
          aoMudar={setSenha}
          aoFocar={() => lia.reagir('shy')}
          mostrar={mostrar}
          aoMostrar={() => setMostrar((m) => !m)}
          invalido={campo === 'senha'}
          extraCab={
            <Link href="/esqueci-a-senha" className="campo-dica">
              Esqueci a senha
            </Link>
          }
        />
        <BotaoEnviar enviando={enviando}>Entrar</BotaoEnviar>
      </form>
      {chaveLigada && (
        <>
          <p className="entrada-ou" aria-hidden="true">
            ou
          </p>
          <button className="btn entrada-com-chave" type="button" onClick={() => disparar(entrarComChave())} disabled={comChave || enviando} aria-busy={comChave}>
            <Icone nome="key" />
            {comChave ? 'Esperando o aparelho…' : 'Entrar com chave de acesso'}
          </button>
        </>
      )}
      <p className="alternativa">
        Ainda não tem conta? <Link href="/criar-conta">Criar conta</Link>
      </p>
    </section>
  );
}
