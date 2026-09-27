'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { api, chamar } from '@/lib/api';
import { disparar } from '@/lib/disparar';
import { useCena } from './lia';
import { Aviso } from './pecas';

// Confirmar e-mail pelo link (uso único, 24 horas).

export function TelaConfirmarEmail() {
  const token = useSearchParams().get('token') ?? '';
  const [estado, setEstado] = useState<'conferindo' | 'confirmado' | 'vencido'>('conferindo');
  const enviado = useRef(false);
  useCena(
    estado === 'confirmado'
      ? 'E-mail confirmado. Agora a conta é sua.'
      : estado === 'vencido'
        ? 'Esse link venceu. Tente entrar que eu mando outro.'
        : 'Conferindo o seu link…',
    estado === 'confirmado' ? 'celebrate' : estado === 'vencido' ? 'empathetic' : 'think',
  );

  useEffect(() => {
    // O link vale uma vez: no modo estrito do React o efeito roda duas vezes, e o segundo não pode gastar o link.
    if (enviado.current) return;
    enviado.current = true;
    if (token.length < 20) {
      setEstado('vencido');
      return;
    }
    disparar(chamar(() => api.POST('/v1/auth/verify-email', { body: { token } })).then((r) => setEstado(r.ok ? 'confirmado' : 'vencido')));
  }, [token]);

  if (estado === 'conferindo') return <p className="rotulo-marca" aria-busy="true">Conferindo o link…</p>;
  if (estado === 'vencido') {
    return (
      <section className="tela" aria-labelledby="t-conf">
        <div className="tela-cab">
          <h1 id="t-conf">Este link não vale mais</h1>
          <p>O link de confirmação vale 24 horas e uma vez só. Entre com o seu e-mail e a senha: mandamos um link novo.</p>
        </div>
        <Link className="btn btn--primary btn--largo" href="/entrar">
          Entrar
        </Link>
      </section>
    );
  }
  return (
    <section className="tela" aria-labelledby="t-conf">
      <Aviso tipo="ok" titulo="E-mail confirmado">
        A sua conta está pronta.
      </Aviso>
      <div className="tela-cab">
        <h1 id="t-conf">Agora é só entrar</h1>
        <p>No primeiro acesso, você ativa o app autenticador.</p>
      </div>
      <Link className="btn btn--primary btn--largo" href="/entrar">
        Entrar
      </Link>
    </section>
  );
}
