'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import { api, chamar, type Problema } from '@/lib/api';
import { disparar } from '@/lib/disparar';
import { useCena, useLia } from './lia';
import { Aviso, AvisoProblema, BotaoEnviar, CampoSenha, SENHA_MIN } from './pecas';

// Senha nova pelo link do e-mail (1 hora, uso único). Salvar derruba todas as sessões da pessoa.

export function TelaSenhaNova() {
  const token = useSearchParams().get('token') ?? '';
  const lia = useLia();
  const [senha, setSenha] = useState('');
  const [mostrar, setMostrar] = useState(false);
  const [erro, setErro] = useState('');
  const [problema, setProblema] = useState<Problema | null>(null);
  const [enviando, setEnviando] = useState(false);
  const [estado, setEstado] = useState<'formulario' | 'salva' | 'vencido'>(token.length < 20 ? 'vencido' : 'formulario');
  useCena(
    estado === 'salva'
      ? 'Senha nova salva. Por segurança, saímos de todos os aparelhos.'
      : estado === 'vencido'
        ? 'Esse link venceu. Peça outro que eu mando.'
        : 'Escolha uma frase fácil de lembrar e difícil de adivinhar.',
    estado === 'salva' ? 'happy' : estado === 'vencido' ? 'empathetic' : 'idle',
  );

  async function salvar(e: FormEvent) {
    e.preventDefault();
    setErro('');
    setProblema(null);
    if (senha.length < SENHA_MIN) {
      setErro(`Use pelo menos ${SENHA_MIN} caracteres (uma frase serve).`);
      return document.getElementById('nv-senha')?.focus();
    }
    setEnviando(true);
    lia.reagir('think');
    const r = await chamar(() => api.POST('/v1/auth/password/reset', { body: { token, password: senha } }));
    setEnviando(false);
    if (!r.ok) {
      lia.reagir('empathetic', 2800);
      const doCampo = r.problema.errors?.find((x) => x.path === 'password');
      if (doCampo) {
        setErro(doCampo.message);
        return document.getElementById('nv-senha')?.focus();
      }
      if (r.problema.code === 'link-invalido') return setEstado('vencido');
      return setProblema(r.problema);
    }
    setEstado('salva');
  }

  if (estado === 'vencido') {
    return (
      <section className="tela" aria-labelledby="t-nova">
        <div className="tela-cab">
          <h1 id="t-nova">Este link não vale mais</h1>
          <p>O link para criar a senha nova vale 1 hora e uma vez só. Peça outro.</p>
        </div>
        <Link className="btn btn--primary btn--largo" href="/esqueci-a-senha">
          Pedir um link novo
        </Link>
      </section>
    );
  }
  if (estado === 'salva') {
    return (
      <section className="tela" aria-labelledby="t-nova">
        <Aviso tipo="ok" titulo="Senha nova salva">
          Saímos da sua conta em todos os aparelhos.
        </Aviso>
        <h1 id="t-nova" className="sr-only">
          Senha nova salva
        </h1>
        <Link className="btn btn--primary btn--largo" href="/entrar">
          Entrar
        </Link>
      </section>
    );
  }
  return (
    <section className="tela" aria-labelledby="t-nova">
      <div className="tela-cab">
        <h1 id="t-nova">Crie uma senha nova</h1>
        <p>Ao salvar, saímos da sua conta em todos os aparelhos, por segurança.</p>
      </div>
      <AvisoProblema problema={problema} />
      <form className="form" onSubmit={(e) => disparar(salvar(e))} noValidate>
        <CampoSenha
          id="nv-senha"
          rotulo="Senha nova"
          nova
          valor={senha}
          aoMudar={setSenha}
          aoFocar={() => lia.reagir('shy')}
          mostrar={mostrar}
          aoMostrar={() => setMostrar((m) => !m)}
          erro={erro || undefined}
        />
        <BotaoEnviar enviando={enviando}>Salvar senha nova</BotaoEnviar>
      </form>
    </section>
  );
}
