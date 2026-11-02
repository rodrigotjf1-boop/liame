'use client';

import type { AgencyClientResponse, AgencyClientsResponse, AgencyRequestResponse } from '@liame/contracts';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAvisar } from '@/components/ui/avisos';
import { ConfirmaNaLinha } from '@/components/ui/confirma-na-linha';
import { Estado } from '@/components/ui/estado';
import { Icone } from '@/components/ui/icone';
import { api, chamar, mensagemDe, type Problema } from '@/lib/api';
import { disparar } from '@/lib/disparar';
import { useSessao } from '@/lib/sessao';
import { CartaoCliente } from './cartao-cliente';
import { DialogoDeixar } from './dialogo-deixar';
import { GavetaPedir } from './gaveta-pedir';
import { GavetaQuemEntra } from './gaveta-quem-entra';
import { situacaoDoPedido } from './textos';

// Clientes (P27 aprovado; A7, W6, parte 5, e W7, parte 2): as empresas que deram acesso à agência, com o que pede
// atenção em cada uma (D-A7-52), e os pedidos dela. A dona e o administrador pedem acesso, escolhem quem do time entra em
// cada cliente e deixam de cuidar de uma empresa; o membro vê só as empresas em que está, com o acesso dele. "Abrir a
// empresa" troca para ela, como o seletor do alto do menu.

type Estado = { tipo: 'carregando' } | { tipo: 'ok'; dados: AgencyClientsResponse } | { tipo: 'erro'; problema: Problema };
type Painel = { tipo: 'pedir'; email?: string } | { tipo: 'time'; cliente: AgencyClientResponse } | { tipo: 'deixar'; cliente: AgencyClientResponse };

export function ClientesTela() {
  const { empresa, pode, trocarEmpresa } = useSessao();
  const avisar = useAvisar();
  const router = useRouter();
  const [estado, setEstado] = useState<Estado>({ tipo: 'carregando' });
  const [painel, setPainel] = useState<Painel | null>(null);
  const titulo = useRef<HTMLHeadingElement>(null);

  const carregar = useCallback(async () => {
    const r = await chamar(() => api.GET('/v1/agency/clients'));
    setEstado(r.ok ? { tipo: 'ok', dados: r.data } : { tipo: 'erro', problema: r.problema });
  }, []);

  useEffect(() => {
    if (pode('agencia.ver')) disparar(carregar());
  }, [carregar, pode]);

  if (!pode('agencia.ver')) {
    return (
      <Estado icone="lock" titulo="Esta tela é de quem está numa agência">
        Os clientes aparecem aqui com a agência ativa no seletor do alto do menu.
      </Estado>
    );
  }

  // A dona e o administrador cuidam dos clientes; o membro só trabalha nos clientes em que está.
  const cuida = pode('agencia.clientes');
  const agencia = empresa?.name ?? 'a agência';
  const dados = estado.tipo === 'ok' ? estado.dados : null;
  const vivos = dados?.clients.filter((c) => c.status === 'ativo') ?? [];
  const pedidos = dados?.requests ?? [];

  async function abrir(c: AgencyClientResponse) {
    const problema = await trocarEmpresa(c.organization.id);
    if (problema) return avisar(mensagemDe(problema), { tipo: 'perigo' });
    avisar(`Agora você está em ${c.organization.name}.`);
    router.push('/');
  }

  return (
    <section aria-labelledby="h-clientes">
      <div className="view-cab anima" style={{ ['--i' as string]: 0 }}>
        <div>
          <h1 id="h-clientes" ref={titulo} tabIndex={-1}>
            Clientes
          </h1>
          <p>
            {cuida
              ? `As empresas que deram acesso à ${agencia}. Cada dono decide até onde o time vai e pode desfazer o vínculo quando quiser.`
              : `As empresas em que você está, pela ${agencia}. Quem escolhe os clientes de cada pessoa é a dona ou um administrador da agência.`}
          </p>
        </div>
        {cuida && (
          <button className="btn btn--primary" type="button" aria-haspopup="dialog" onClick={() => setPainel({ tipo: 'pedir' })}>
            <Icone nome="user-plus" />
            Pedir acesso a um cliente
          </button>
        )}
      </div>

      {estado.tipo === 'carregando' && (
        <p className="sr-only" role="status">
          Carregando os clientes…
        </p>
      )}
      {estado.tipo === 'erro' && (
        <Estado
          icone="alert"
          perigo
          titulo="Não deu para carregar os clientes"
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

      {dados && cuida && pedidos.length > 0 && (
        <>
          <div className="secao-t">
            <h2 id="pdl-t">Pedidos</h2>
            <span className="campo-dica">Cada pedido vale 7 dias.</span>
          </div>
          <article className="card" aria-labelledby="pdl-t">
            <ul className="pedidos">
              {pedidos.map((p) => (
                <LinhaPedido
                  key={p.id}
                  pedido={p}
                  aoPedirDeNovo={() => setPainel({ tipo: 'pedir', email: p.owner_email })}
                  aoCancelado={() => {
                    avisar('Pedido cancelado.');
                    disparar(carregar());
                    titulo.current?.focus({ preventScroll: true });
                  }}
                />
              ))}
            </ul>
          </article>
        </>
      )}

      {dados && vivos.length > 0 && (
        <>
          <div className="secao-t">
            <h2 id="cls-t">Empresas</h2>
            <span className="campo-dica">
              {vivos.length} {vivos.length === 1 ? 'empresa' : 'empresas'}
            </span>
          </div>
          <div className="clientes" role="list" aria-labelledby="cls-t">
            {vivos.map((c) => (
              <CartaoCliente
                key={c.id}
                cliente={c}
                cuida={cuida}
                escolhe={cuida && pode('agencia.time')}
                aoAbrir={() => disparar(abrir(c))}
                aoEscolher={() => setPainel({ tipo: 'time', cliente: c })}
                aoDeixar={() => setPainel({ tipo: 'deixar', cliente: c })}
              />
            ))}
          </div>
        </>
      )}

      {dados && !vivos.length && !pedidos.length && cuida && (
        <div className="card vazio">
          <span className="pessoa-av pessoa-av--ag" aria-hidden="true">
            <Icone nome="users" />
          </span>
          <h2>Nenhum cliente ainda</h2>
          <p className="lite-frase">Peça acesso pelo e-mail do dono da empresa. Ele escolhe até onde o time da agência vai, e a conta continua dele.</p>
          <button className="btn btn--primary" type="button" aria-haspopup="dialog" onClick={() => setPainel({ tipo: 'pedir' })}>
            Pedir acesso a um cliente
          </button>
        </div>
      )}
      {dados && !vivos.length && !cuida && (
        <div className="card vazio">
          <span className="pessoa-av pessoa-av--ag" aria-hidden="true">
            <Icone nome="briefcase" />
          </span>
          <h2>Você ainda não está em nenhum cliente</h2>
          <p className="lite-frase">A dona ou um administrador da agência coloca você nos clientes em que vai trabalhar.</p>
        </div>
      )}
      {dados && !vivos.length && pedidos.length > 0 && (
        <p className="lite-frase clientes-depois">Quando o dono aceitar, a empresa aparece aqui.</p>
      )}

      {painel?.tipo === 'pedir' && (
        <GavetaPedir
          email={painel.email ?? ''}
          reserva={titulo}
          aoEnviar={(aviso) => {
            avisar(aviso);
            disparar(carregar());
          }}
          aoFechar={() => setPainel(null)}
        />
      )}
      {painel?.tipo === 'time' && (
        <GavetaQuemEntra
          cliente={painel.cliente}
          reserva={titulo}
          aoSalvar={(aviso) => {
            avisar(aviso);
            disparar(carregar());
          }}
          aoSumir={(problema) => {
            setPainel(null);
            avisar(problema.status === 404 ? 'Este cliente não está mais com a agência. A lista foi lida de novo.' : mensagemDe(problema), { tipo: 'perigo' });
            disparar(carregar());
          }}
          aoFechar={() => setPainel(null)}
        />
      )}
      {painel?.tipo === 'deixar' && (
        <DialogoDeixar
          cliente={painel.cliente}
          reserva={titulo}
          aoDeixar={(aviso) => {
            avisar(aviso, { tipo: 'perigo' });
            disparar(carregar());
            titulo.current?.focus({ preventScroll: true });
          }}
          aoFechar={() => setPainel(null)}
        />
      )}
    </section>
  );
}

/** Um pedido: o e-mail, a situação e "Cancelar o pedido" (confirmado na linha) ou "Pedir de novo". */
function LinhaPedido({ pedido: p, aoPedirDeNovo, aoCancelado }: { pedido: AgencyRequestResponse; aoPedirDeNovo: () => void; aoCancelado: () => void }) {
  const avisar = useAvisar();
  const [cancelando, setCancelando] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const s = situacaoDoPedido(p, new Date());

  async function cancelar() {
    setEnviando(true);
    const r = await chamar(() => api.DELETE('/v1/agency/requests/{id}', { params: { path: { id: p.id } } }));
    setEnviando(false);
    if (r.ok || r.problema.status === 404) return aoCancelado();
    setCancelando(false);
    avisar(mensagemDe(r.problema), { tipo: 'perigo' });
  }

  return (
    <li className="pedido-linha">
      <div className="pedido-linha-txt">
        <b>{p.owner_email}</b>
        <span>{s.texto}</span>
      </div>
      <span className={`st st--${s.tom}`}>
        <span className="dot" aria-hidden="true" />
        {s.rotulo}
      </span>
      {p.status === 'esperando' ? (
        cancelando ? (
          <ConfirmaNaLinha
            texto="Cancelar o pedido?"
            rotulo="Cancelar o pedido"
            rotuloOcupado="Cancelando…"
            voltar="Manter"
            ocupado={enviando}
            aoConfirmar={() => disparar(cancelar())}
            aoCancelar={() => setCancelando(false)}
          />
        ) : (
          <button className="btn btn--sm" type="button" onClick={() => setCancelando(true)}>
            Cancelar o pedido
          </button>
        )
      ) : (
        <button className="btn btn--sm" type="button" aria-haspopup="dialog" onClick={aoPedirDeNovo}>
          Pedir de novo
        </button>
      )}
    </li>
  );
}

