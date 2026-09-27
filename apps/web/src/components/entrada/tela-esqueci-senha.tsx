'use client';

import Link from 'next/link';
import { type FormEvent, useState } from 'react';
import { api, chamar, type Problema } from '@/lib/api';
import { disparar } from '@/lib/disparar';
import { useCena, useLia } from './lia';
import { AvisoProblema, BotaoEnviar } from './pecas';

// Esqueci a senha: a resposta é a mesma exista ou não a conta (não revela e-mails).

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function TelaEsqueciSenha() {
  const lia = useLia();
  const [email, setEmail] = useState('');
  const [erro, setErro] = useState('');
  const [problema, setProblema] = useState<Problema | null>(null);
  const [enviando, setEnviando] = useState(false);
  const [enviado, setEnviado] = useState(false);
  useCena(
    enviado ? 'Se a conta existir, o link chega em instantes.' : 'Acontece com todo mundo. Mando um link para você criar outra.',
    enviado ? 'happy' : 'empathetic',
  );

  async function enviar(e: FormEvent) {
    e.preventDefault();
    setErro('');
    setProblema(null);
    const normalizado = email.trim().toLowerCase();
    if (!EMAIL.test(normalizado)) {
      setErro('Digite um e-mail válido, como nome@empresa.com.br.');
      return document.getElementById('es-email')?.focus();
    }
    setEnviando(true);
    lia.reagir('think');
    const r = await chamar(() => api.POST('/v1/auth/password/forgot', { body: { email: normalizado } }));
    setEnviando(false);
    if (!r.ok) {
      lia.reagir('empathetic', 2800);
      return setProblema(r.problema);
    }
    setEnviado(true);
  }

  if (enviado) {
    return (
      <section className="tela" aria-labelledby="t-esq">
        <div className="tela-cab">
          <h1 id="t-esq">Confira seu e-mail</h1>
          <p>Se houver uma conta com esse e-mail, o link chega em instantes. Ele vale 1 hora e uma vez só.</p>
        </div>
        <Link className="btn" href="/entrar">
          Voltar para a entrada
        </Link>
      </section>
    );
  }
  return (
    <section className="tela" aria-labelledby="t-esq">
      <div className="tela-cab">
        <h1 id="t-esq">Esqueceu a senha?</h1>
        <p>Digite o e-mail da conta. Mandamos um link para criar uma senha nova.</p>
      </div>
      <AvisoProblema problema={problema} />
      <form className="form" onSubmit={(e) => disparar(enviar(e))} noValidate>
        <div className="campo">
          <label htmlFor="es-email">E-mail</label>
          <input
            className="input"
            id="es-email"
            type="email"
            autoComplete="username"
            inputMode="email"
            required
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              lia.reagir('listen');
            }}
            aria-invalid={erro ? true : undefined}
            aria-describedby={erro ? 'es-email-erro' : undefined}
          />
          {erro && (
            <span className="campo-erro" id="es-email-erro">
              {erro}
            </span>
          )}
        </div>
        <BotaoEnviar enviando={enviando}>Enviar link</BotaoEnviar>
      </form>
      <p className="alternativa">
        <Link href="/entrar">Voltar para a entrada</Link>
      </p>
    </section>
  );
}
