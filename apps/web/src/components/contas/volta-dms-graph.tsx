'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { Icone } from '@/components/ui/icone';
import { api, chamar, mensagemDe } from '@/lib/api';
import { disparar } from '@/lib/disparar';

// A volta do "Conectar ao DMS Graph": repassa ao servidor o que veio (é ele que confere e troca o código pela ligação) e
// tira o código da barra de endereço.

type Estado = { fase: 'concluindo' } | { fase: 'conectado'; conta: string | null } | { fase: 'recusado' } | { fase: 'erro'; mensagem: string };

const TITULOS: Record<Estado['fase'], string> = {
  concluindo: 'Concluindo a conexão…',
  conectado: 'Pronto: DMS Graph conectado',
  recusado: 'Nada foi ligado',
  erro: 'Não deu para concluir',
};

export function VoltaDmsGraph() {
  const [estado, setEstado] = useState<Estado>({ fase: 'concluindo' });
  const feito = useRef(false);

  useEffect(() => {
    // Uma vez só: o código vale uma vez (o modo estrito do React roda o efeito duas vezes em desenvolvimento).
    if (feito.current) return;
    feito.current = true;
    const q = new URLSearchParams(window.location.search);
    const campo = (nome: string) => q.get(nome) ?? undefined;
    const body = { code: campo('code'), state: campo('state'), iss: campo('iss'), error: campo('error') };
    window.history.replaceState(null, '', window.location.pathname);
    disparar(
      chamar(() => api.POST('/v1/dms-graph/callback', { body })).then((r) => {
        if (!r.ok) setEstado({ fase: 'erro', mensagem: mensagemDe(r.problema) });
        else setEstado(r.data.connected ? { fase: 'conectado', conta: r.data.account_name } : { fase: 'recusado' });
      }),
    );
  }, []);

  return (
    <div className="pagina">
      <header className="pagina-cab">
        <h1>Conectar ao DMS Graph</h1>
      </header>
      <section className="card autorizacao dg-cartao" aria-live="polite">
        <h2 className="sub-titulo">{TITULOS[estado.fase]}</h2>
        {estado.fase === 'concluindo' && (
          <p className="aut-txt" role="status">
            Conferindo a autorização com o DMS Graph…
          </p>
        )}
        {estado.fase === 'conectado' && (
          <p className="aut-txt">
            {estado.conta ? (
              <>
                A conta <b>{estado.conta}</b> do DMS Graph está ligada ao Liame.
              </>
            ) : (
              'O DMS Graph está ligado ao Liame.'
            )}{' '}
            Para usar, abra uma foto em Fotos e clique em Editar foto.
          </p>
        )}
        {estado.fase === 'recusado' && <p className="aut-txt">Você não autorizou no DMS Graph. Nada mudou aqui; quando quiser, comece de novo em Contas conectadas.</p>}
        {estado.fase === 'erro' && (
          <p className="aut-txt aut-txt--perigo" role="alert">
            <Icone nome="alert-circle" pequeno />
            <span>{estado.mensagem}</span>
          </p>
        )}
        {estado.fase !== 'concluindo' && (
          <div className="dg-acoes">
            <Link className={`btn btn--sm ${estado.fase === 'conectado' ? 'btn--primary' : ''}`} href={estado.fase === 'conectado' ? '/fotos' : '/contas'}>
              {estado.fase === 'conectado' ? 'Ir para Fotos' : 'Voltar a Contas conectadas'}
            </Link>
          </div>
        )}
      </section>
    </div>
  );
}
