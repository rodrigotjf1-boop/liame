'use client';

import type { InvitationResponse, MemberResponse, PeopleResponse } from '@liame/contracts';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAvisar } from '@/components/ui/avisos';
import { Estado } from '@/components/ui/estado';
import { Icone } from '@/components/ui/icone';
import { api, chamar, mensagemDe, novaChave, type Problema } from '@/lib/api';
import { useSessao } from '@/lib/sessao';
import { CartaoAgencia, CartaoProtecao, TabelaNiveis } from './cartoes-informativos';
import { DialogoAcesso, type ModoDialogo } from './dialogo-acesso';
import { ItemConvite } from './item-convite';
import { ItemPessoa } from './item-pessoa';
import { contagem } from './textos';
import { disparar } from '@/lib/disparar';

// "Pessoas e acessos" (protótipo aprovado, ADR-017): quem pode entrar na conta e o que cada um pode fazer.

type Estado = { tipo: 'carregando' } | { tipo: 'ok'; dados: PeopleResponse } | { tipo: 'erro'; problema: Problema };

export function PessoasTela() {
  const { me, empresa, pode } = useSessao();
  const avisar = useAvisar();
  const [estado, setEstado] = useState<Estado>({ tipo: 'carregando' });
  const [dialogo, setDialogo] = useState<ModoDialogo | null>(null);
  const titulo = useRef<HTMLHeadingElement>(null);

  const carregar = useCallback(async () => {
    const r = await chamar(() => api.GET('/v1/people'));
    setEstado(r.ok ? { tipo: 'ok', dados: r.data } : { tipo: 'erro', problema: r.problema });
  }, []);

  useEffect(() => {
    if (pode('pessoas.ver')) disparar(carregar());
  }, [carregar, pode]);

  const dados = estado.tipo === 'ok' ? estado.dados : null;
  const euMembro = dados?.members.find((m) => m.user_id === me.user.id) ?? null;
  const ocupados = useMemo(
    () => new Set([...(dados?.members ?? []).map((m) => m.email), ...(dados?.invitations ?? []).map((c) => c.email)]),
    [dados],
  );

  if (!pode('pessoas.ver')) {
    return (
      <Estado icone="lock" titulo="Esta tela é de quem cuida dos acessos">
        O seu nível nesta empresa não mostra quem tem acesso. Se precisar, peça ao dono da conta.
      </Estado>
    );
  }

  const nomeEmpresa = empresa?.name ?? 'sua empresa';
  const souDono = empresa?.role === 'dono';

  async function remover(p: MemberResponse): Promise<boolean> {
    const r = await chamar(() => api.DELETE('/v1/members/{id}', { params: { path: { id: p.id } } }));
    if (!r.ok) {
      avisar(mensagemDe(r.problema), { tipo: 'perigo' });
      return false;
    }
    avisar(`Acesso de ${p.name} removido. A pessoa perdeu o acesso agora, em todas as sessões.`, { tipo: 'perigo' });
    await carregar();
    titulo.current?.focus({ preventScroll: true });
    return true;
  }

  async function cancelarConvite(c: InvitationResponse) {
    const r = await chamar(() => api.DELETE('/v1/invitations/{id}', { params: { path: { id: c.id } } }));
    if (!r.ok) return avisar(mensagemDe(r.problema), { tipo: 'perigo' });
    avisar(`Convite para ${c.email} cancelado. O link deixou de funcionar.`);
    await carregar();
    titulo.current?.focus({ preventScroll: true });
  }

  // Reenviar = convidar de novo com os mesmos dados: o link antigo deixa de valer e o prazo recomeça.
  async function reenviar(c: InvitationResponse) {
    const r = await chamar(() =>
      api.POST('/v1/invitations', {
        headers: { 'Idempotency-Key': novaChave() },
        body: {
          email: c.email,
          role: c.role,
          ...(c.approve_limit_micros !== null ? { approve_limit_micros: c.approve_limit_micros } : {}),
          dual_approval: c.dual_approval,
          billing_access: c.billing_access,
          ...(c.access_expires_at ? { access_expires_at: c.access_expires_at } : {}),
        },
      }),
    );
    if (!r.ok) return avisar(mensagemDe(r.problema), { tipo: 'perigo' });
    avisar(`Convite reenviado para ${c.email}. O prazo de 7 dias recomeça.`);
    await carregar();
  }

  const podeConvidar = pode('pessoas.convidar');
  return (
    <section aria-labelledby="h-acessos">
      <div className="view-cab anima" style={{ ['--i' as string]: 0 }}>
        <div>
          <h1 id="h-acessos" ref={titulo} tabIndex={-1}>
            Pessoas e acessos
          </h1>
          <p>
            Quem pode entrar na conta da {nomeEmpresa} e o que cada um pode fazer. Ninguém recebe a sua senha: cada pessoa entra com o
            próprio e-mail e o app autenticador.
          </p>
        </div>
        {podeConvidar && (
          <button className="btn btn--primary" type="button" onClick={() => setDialogo({ tipo: 'convidar' })} disabled={!dados}>
            <Icone nome="user-plus" />
            Convidar pessoa
          </button>
        )}
      </div>

      <div className="acessos-grid">
        <article className="card anima" style={{ ['--i' as string]: 1 }} aria-labelledby="ac-t" aria-busy={estado.tipo === 'carregando'}>
          <div className="card-cab">
            <div>
              <h2 id="ac-t">Com acesso</h2>
              <p className="card-sub">{dados ? contagem(dados.members.length, dados.invitations.length) : ' '}</p>
            </div>
          </div>
          {estado.tipo === 'carregando' && <Carregando />}
          {estado.tipo === 'erro' && (
            <Estado
              icone="alert"
              perigo
              titulo="Não deu para carregar quem tem acesso"
              acao={
                <button className="btn" type="button" onClick={() => disparar(carregar())}>
                  <Icone nome="refresh" />
                  Tentar de novo
                </button>
              }
            >
              {mensagemDe(estado.problema)}
            </Estado>
          )}
          {dados && (
            <ul className="pessoas">
              {dados.members.map((p) => (
                <ItemPessoa
                  key={p.id}
                  pessoa={p}
                  voce={p.user_id === me.user.id}
                  souDono={souDono}
                  podeAlterar={pode('pessoas.alterar_nivel')}
                  podeRemover={pode('pessoas.remover')}
                  aoAlterar={() => setDialogo({ tipo: 'alterar', pessoa: p })}
                  aoRemover={() => remover(p)}
                />
              ))}
              {dados.invitations.map((c) => (
                <ItemConvite
                  key={c.id}
                  convite={c}
                  podeGerenciar={podeConvidar}
                  aoReenviar={() => reenviar(c)}
                  aoCancelar={() => cancelarConvite(c)}
                />
              ))}
            </ul>
          )}
        </article>
        <div className="acessos-lado">
          <CartaoProtecao />
          <CartaoAgencia />
        </div>
      </div>
      <TabelaNiveis />

      {dialogo && euMembro && (
        <DialogoAcesso
          modo={dialogo}
          eu={{ role: euMembro.role, limite: euMembro.role === 'dono' ? null : euMembro.approve_limit_micros }}
          emailsOcupados={ocupados}
          aoFechar={() => setDialogo(null)}
          aoConcluir={(aviso) => {
            avisar(aviso);
            disparar(carregar());
          }}
        />
      )}
    </section>
  );
}

function Carregando() {
  return (
    <ul className="pessoas" aria-label="Carregando quem tem acesso">
      {[0, 1, 2].map((i) => (
        <li key={i} className="pessoa-esq" aria-hidden="true">
          <span className="esqueleto" style={{ width: 40, height: 40, borderRadius: '50%' }} />
          <span style={{ display: 'grid', gap: 8 }}>
            <span className="esqueleto" style={{ width: '40%', height: 14 }} />
            <span className="esqueleto" style={{ width: '65%', height: 12 }} />
            <span className="esqueleto" style={{ width: '30%', height: 20 }} />
          </span>
        </li>
      ))}
    </ul>
  );
}
