'use client';

import { useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { api, chamar } from '@/lib/api';
import { disparar } from '@/lib/disparar';
import { useCena } from './lia';
import { Aviso } from './pecas';

// Confirmar o e-mail de resposta de uma agência pelo link (A7, W7, parte 5a; D-A7-69): quem abre lê aquele endereço e
// pode nem ter conta no Liame. Uso único, 24 horas. Depois dele, o "Responder" dos relatórios da agência vem para cá.

type Situacao = { tipo: 'conferindo' } | { tipo: 'confirmado'; agencia: string; email: string } | { tipo: 'vencido' };

export function TelaConfirmarResposta() {
  const token = useSearchParams().get('token') ?? '';
  const [estado, setEstado] = useState<Situacao>({ tipo: 'conferindo' });
  const enviado = useRef(false);
  useCena(
    estado.tipo === 'confirmado'
      ? 'E-mail confirmado. As respostas dos clientes vêm para cá.'
      : estado.tipo === 'vencido'
        ? 'Esse link não vale mais. Peça à agência para mandar outro.'
        : 'Conferindo o seu link…',
    estado.tipo === 'confirmado' ? 'celebrate' : estado.tipo === 'vencido' ? 'empathetic' : 'think',
  );

  useEffect(() => {
    // O link vale uma vez: no modo estrito do React o efeito roda duas vezes, e o segundo não pode gastar o link.
    if (enviado.current) return;
    enviado.current = true;
    if (token.length < 20) {
      setEstado({ tipo: 'vencido' });
      return;
    }
    disparar(
      chamar(() => api.POST('/v1/agency-reply-to/confirm', { body: { token } })).then((r) =>
        setEstado(r.ok ? { tipo: 'confirmado', agencia: r.data.agency_name, email: r.data.email } : { tipo: 'vencido' }),
      ),
    );
  }, [token]);

  if (estado.tipo === 'conferindo') return <p className="rotulo-marca" aria-busy="true">Conferindo o link…</p>;
  if (estado.tipo === 'vencido') {
    return (
      <section className="tela" aria-labelledby="t-resp">
        <div className="tela-cab">
          <h1 id="t-resp">Este link não vale mais</h1>
          <p>O link de confirmação vale 24 horas e uma vez só, e um e-mail salvo depois dele o substitui. Peça à agência para salvar o e-mail de novo: ela manda outro link.</p>
        </div>
      </section>
    );
  }
  return (
    <section className="tela" aria-labelledby="t-resp">
      <Aviso tipo="ok" titulo="E-mail confirmado">
        As respostas aos relatórios da {estado.agencia} vêm para {estado.email}.
      </Aviso>
      <div className="tela-cab">
        <h1 id="t-resp">Pronto</h1>
        <p>Quando um cliente responder ao e-mail do relatório do mês que a {estado.agencia} manda pelo Liame, a resposta chega a este e-mail. Pode fechar esta página.</p>
      </div>
    </section>
  );
}
