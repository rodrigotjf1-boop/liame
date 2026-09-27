'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { api, chamar, type Problema } from '@/lib/api';
import { disparar } from '@/lib/disparar';
import { destinoDepoisDeEntrar, voltaSegura } from '@/lib/entrada';
import { useCena, useLia } from './lia';
import { AvisoProblema, BotaoEnviar, CampoSenha } from './pecas';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

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
  const refEmail = useRef<HTMLInputElement>(null);

  // Já tem sessão: segue direto para onde ia (ou para o segundo fator, se faltar).
  useEffect(() => {
    let viva = true;
    disparar(
      chamar(() => api.GET('/v1/me')).then((r) => {
        if (viva && r.ok) router.replace(destinoDepoisDeEntrar(r.data, volta));
      }),
    );
    return () => {
      viva = false;
    };
  }, [router, volta]);

  function falhou(p: Problema, qual: 'email' | 'senha' | null) {
    setProblema(p);
    setCampo(qual);
    lia.reagir('empathetic', 2800);
    if (qual === 'email') refEmail.current?.focus();
    else if (qual === 'senha') document.getElementById('en-senha')?.focus();
  }

  async function entrar(e: FormEvent) {
    e.preventDefault();
    setProblema(null);
    setCampo(null);
    const normalizado = email.trim();
    if (!EMAIL.test(normalizado)) return falhou({ status: 0, code: 'email', title: 'E-mail inválido', detail: 'Confira o endereço, como nome@empresa.com.br.' }, 'email');
    if (!senha) return falhou({ status: 0, code: 'senha', title: 'Falta a senha', detail: 'Digite a senha da sua conta.' }, 'senha');
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

  return (
    <section className="tela" aria-labelledby="t-entrar">
      <div className="tela-cab">
        <h1 id="t-entrar">Entrar no Liame</h1>
        <p>Use o e-mail e a senha da sua conta.</p>
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
            autoComplete="username"
            inputMode="email"
            required
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              lia.reagir('listen');
            }}
            aria-invalid={campo === 'email' ? true : undefined}
          />
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
      <p className="alternativa">
        Ainda não tem conta? <Link href="/criar-conta">Criar conta</Link>
      </p>
    </section>
  );
}
