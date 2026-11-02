'use client';

import type {
  AccountRecoveryNotice,
  InvitationResponse,
  MemberResponse,
  OwnershipClaimResponse,
  OwnershipResponse,
  OwnershipTransfer,
  PartnerRequestResponse,
  PartnerResponse,
  PartnersResponse,
  PeopleResponse,
} from '@liame/contracts';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAvisar } from '@/components/ui/avisos';
import { Estado } from '@/components/ui/estado';
import { Faixa } from '@/components/ui/faixa';
import { Icone } from '@/components/ui/icone';
import { api, chamar, mensagemDe, novaChave, type Problema } from '@/lib/api';
import { NIVEIS } from '@/lib/niveis';
import { useSessao } from '@/lib/sessao';
import { AvisoDeRecuperacao } from './aviso-de-recuperacao';
import { CaminhoDaDms } from './caminho-da-dms';
import { GavetaPedirPropriedade } from './gaveta-pedir-propriedade';
import { PedidoSobreODono } from './pedido-sobre-o-dono';
import { CartaoAgencia, CartaoProtecao, TabelaNiveis } from './cartoes-informativos';
import { CartaoPedido } from './cartao-pedido';
import { CartaoPropriedade } from './cartao-propriedade';
import { DialogoAcesso, type ModoDialogo } from './dialogo-acesso';
import { DialogoDesfazer } from './dialogo-desfazer';
import { GavetaAceitarPropriedade } from './gaveta-aceitar-propriedade';
import { GavetaDecidir } from './gaveta-decidir';
import { GavetaLimites } from './gaveta-limites';
import { GavetaTransferir } from './gaveta-transferir';
import { ItemAgencia } from './item-agencia';
import { ItemConvite } from './item-convite';
import { ItemPessoa } from './item-pessoa';
import { contagemComAgencias, separarPorAgencia } from './parceiros';
import { PedidoDePropriedade } from './pedido-de-propriedade';
import { primeiroNome } from './propriedade-textos';
import { contagem } from './textos';
import { disparar } from '@/lib/disparar';

// "Pessoas e acessos" (protótipo aprovado, ADR-017): quem pode entrar na conta e o que cada um pode fazer.

type Estado = { tipo: 'carregando' } | { tipo: 'ok'; dados: PeopleResponse } | { tipo: 'erro'; problema: Problema };
/** As agências: lidas junto com as pessoas; a falha delas não esconde a lista (a tela diz que não leu). */
type Agencias = { tipo: 'ok'; dados: PartnersResponse } | { tipo: 'erro'; problema: Problema } | null;
/** As gavetas e o diálogo das agências (P27). */
type Painel =
  | { tipo: 'decidir'; pedido: PartnerRequestResponse }
  | { tipo: 'limites'; parceiro: PartnerResponse }
  | { tipo: 'desfazer'; parceiro: PartnerResponse }
  // A propriedade da conta (P34; A7, W8, parte 3).
  | { tipo: 'transferir' }
  | { tipo: 'aceitar-propriedade'; pedido: OwnershipTransfer }
  // O pedido da propriedade à DMS quando o Dono não está mais (A7, W8, parte 6b).
  | { tipo: 'pedir-propriedade' };
/** A faixa do que acabou de acontecer com uma agência (P27). */
type Resultado = { tipo?: 'acao'; titulo: string; texto: string; verCobranca?: boolean } | null;

export function PessoasTela() {
  const { me, empresa, pode, trocarEmpresa } = useSessao();
  const avisar = useAvisar();
  const [estado, setEstado] = useState<Estado>({ tipo: 'carregando' });
  const [dialogo, setDialogo] = useState<ModoDialogo | null>(null);
  const [agencias, setAgencias] = useState<Agencias>(null);
  const [painel, setPainel] = useState<Painel | null>(null);
  const [resultado, setResultado] = useState<Resultado>(null);
  // A propriedade da conta: lida junto; a falha dela não esconde a lista (o cartão só não aparece).
  const [propriedade, setPropriedade] = useState<OwnershipResponse | null>(null);
  // O pedido de recuperação do Dono na espera, para os Administradores (A7, W8, parte 5): a falha dele não esconde nada.
  const [avisoRec, setAvisoRec] = useState<AccountRecoveryNotice | null>(null);
  // O pedido da propriedade à DMS (A7, W8, parte 6b): o de quem lê, ou, para o Dono, o pedido sobre ele na espera.
  const [pedidoDms, setPedidoDms] = useState<OwnershipClaimResponse | null>(null);
  const titulo = useRef<HTMLHeadingElement>(null);

  const carregar = useCallback(async () => {
    const [r, a, d, v, c] = await Promise.all([
      chamar(() => api.GET('/v1/people')),
      chamar(() => api.GET('/v1/partners')),
      chamar(() => api.GET('/v1/ownership')),
      chamar(() => api.GET('/v1/account-recovery/notice')),
      chamar(() => api.GET('/v1/ownership/claim')),
    ]);
    setEstado(r.ok ? { tipo: 'ok', dados: r.data } : { tipo: 'erro', problema: r.problema });
    setAgencias(a.ok ? { tipo: 'ok', dados: a.data } : { tipo: 'erro', problema: a.problema });
    setPropriedade(d.ok ? d.data : null);
    setAvisoRec(v.ok ? v.data.notice : null);
    setPedidoDms(c.ok ? c.data : null);
  }, []);

  useEffect(() => {
    if (pode('pessoas.ver')) disparar(carregar());
  }, [carregar, pode]);

  const dados = estado.tipo === 'ok' ? estado.dados : null;
  const parceiros = agencias?.tipo === 'ok' ? agencias.dados : null;
  const comAgencias = parceiros?.enabled === true || (parceiros?.partners.length ?? 0) > 0;
  // Quem vem de uma agência aparece dentro da linha dela; sem a agência na lista (o vínculo acabou), fica com as outras.
  const { diretas, porVinculo } = useMemo(() => {
    const s = separarPorAgencia(dados?.members ?? []);
    const vivas = new Set((parceiros?.partners ?? []).map((x) => x.id));
    for (const [link, time] of s.porVinculo) if (!vivas.has(link)) s.diretas.push(...time);
    return s;
  }, [dados, parceiros]);
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

  async function recusarPedido(p: PartnerRequestResponse): Promise<boolean> {
    const r = await chamar(() => api.POST('/v1/partners/requests/{id}/refuse', { params: { path: { id: p.id } } }));
    if (!r.ok && r.problema.status !== 404) {
      avisar(mensagemDe(r.problema), { tipo: 'perigo' });
      return false;
    }
    if (r.ok) {
      avisar('Pedido recusado. A agência recebeu um e-mail.');
      setResultado({
        titulo: `Você recusou o pedido de ${p.agency.name}`,
        texto: 'A agência recebeu um e-mail dizendo que o pedido não foi aceito, sem o motivo. Ela pode pedir de novo, e você decide outra vez.',
      });
    } else avisar('Este pedido não está mais esperando: a agência cancelou, ou ele venceu.');
    await carregar();
    titulo.current?.focus({ preventScroll: true });
    return true;
  }

  function painelSumiu(problema: Problema) {
    setPainel(null);
    avisar(problema.status === 404 ? 'Isso mudou enquanto a gaveta estava aberta. A lista foi lida de novo.' : mensagemDe(problema), { tipo: 'perigo' });
    disparar(carregar());
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

      {resultado && (
        <Faixa
          tipo={resultado.tipo}
          icone={<Icone nome={resultado.tipo ? 'check-circle' : 'info'} />}
          titulo={resultado.titulo}
          texto={resultado.texto}
          acao={
            resultado.verCobranca ? (
              <Link className="btn btn--sm" href="/cobranca">
                Ver a cobrança
              </Link>
            ) : undefined
          }
        />
      )}
      {agencias?.tipo === 'erro' && (
        <Faixa
          tipo="atencao"
          icone={<Icone nome="alert" />}
          titulo="Não deu para ler as agências"
          texto={`Os pedidos e as agências com acesso não apareceram agora. ${mensagemDe(agencias.problema)}`}
          acao={
            <button className="btn btn--sm" type="button" onClick={() => disparar(carregar())}>
              Tentar de novo
            </button>
          }
        />
      )}
      {avisoRec && <AvisoDeRecuperacao aviso={avisoRec} aoMudar={(r) => setAvisoRec(r.notice)} />}
      {pedidoDms?.about_me && pedidoDms.claim && <PedidoSobreODono pedido={pedidoDms.claim} empresa={nomeEmpresa} aoMudar={setPedidoDms} />}
      {propriedade?.addressed_to_me && propriedade.pending && (
        <PedidoDePropriedade
          pedido={propriedade.pending}
          empresa={nomeEmpresa}
          aoVerEAceitar={() => propriedade.pending && setPainel({ tipo: 'aceitar-propriedade', pedido: propriedade.pending })}
          aoRecusado={() => {
            const de = primeiroNome(propriedade.pending?.from.name ?? '');
            avisar(`Você recusou. ${de} recebeu um e-mail.`);
            setResultado({ titulo: 'Você recusou a propriedade', texto: `${de} recebeu um e-mail dizendo que você não aceitou. A conta continua com ele, e o seu acesso não mudou.` });
            disparar(carregar());
            titulo.current?.focus({ preventScroll: true });
          }}
        />
      )}
      {souDono &&
        parceiros?.requests.map((p) => (
          <CartaoPedido
            key={p.id}
            pedido={p}
            nomeEmpresa={nomeEmpresa}
            agora={new Date()}
            aoDecidir={() => setPainel({ tipo: 'decidir', pedido: p })}
            aoRecusar={() => recusarPedido(p)}
          />
        ))}

      <div className="acessos-grid">
        <article className="card anima" style={{ ['--i' as string]: 1 }} aria-labelledby="ac-t" aria-busy={estado.tipo === 'carregando'}>
          <div className="card-cab">
            <div>
              <h2 id="ac-t">Com acesso</h2>
              <p className="card-sub">
                {dados
                  ? parceiros && (parceiros.partners.length || parceiros.requests.length)
                    ? contagemComAgencias(
                        diretas.length,
                        dados.invitations.length,
                        souDono ? parceiros.requests.length : 0,
                        parceiros.partners.map((x) => ({ nome: x.agency.name, pessoas: porVinculo.get(x.id)?.length ?? 0 })),
                      )
                    : contagem(dados.members.length, dados.invitations.length)
                  : ' '}
              </p>
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
              {diretas.map((p) => (
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
              {parceiros?.partners.map((x) => (
                <ItemAgencia
                  key={x.id}
                  parceiro={x}
                  time={porVinculo.get(x.id) ?? []}
                  nomeEmpresa={nomeEmpresa}
                  meuId={me.user.id}
                  souDono={souDono}
                  podeRemover={pode('pessoas.remover')}
                  aoMudar={() => setPainel({ tipo: 'limites', parceiro: x })}
                  aoDesfazer={() => setPainel({ tipo: 'desfazer', parceiro: x })}
                  aoRemoverPessoa={remover}
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
          {propriedade && (
            <CartaoPropriedade
              propriedade={propriedade}
              souDono={propriedade.owner.user_id === me.user.id}
              empresa={nomeEmpresa}
              aoTransferir={() => setPainel({ tipo: 'transferir' })}
              aoMudar={(aviso) => {
                avisar(aviso);
                disparar(carregar());
              }}
              caminhoDaDms={
                <CaminhoDaDms
                  pedido={pedidoDms}
                  dono={primeiroNome(propriedade.owner.name)}
                  aoPedir={() => setPainel({ tipo: 'pedir-propriedade' })}
                  aoMudar={setPedidoDms}
                />
              }
            />
          )}
          <CartaoProtecao comAgencias={comAgencias} />
          <CartaoAgencia comAgencias={comAgencias} />
        </div>
      </div>
      <TabelaNiveis comAgencias={comAgencias} />

      {painel?.tipo === 'transferir' && propriedade && dados && (
        <GavetaTransferir
          membros={dados.members}
          propriedade={propriedade}
          empresa={nomeEmpresa}
          reserva={titulo}
          aoPedir={(r) => {
            setPropriedade(r);
            avisar(`Pedido enviado. ${primeiroNome(r.pending?.to.name ?? '')} recebeu um e-mail; até o aceite, nada muda.`);
          }}
          aoConvidar={() => setDialogo({ tipo: 'convidar' })}
          aoFechar={() => setPainel(null)}
        />
      )}
      {painel?.tipo === 'pedir-propriedade' && propriedade && (
        <GavetaPedirPropriedade
          dono={primeiroNome(propriedade.owner.name)}
          empresa={nomeEmpresa}
          rascunho={pedidoDms?.mine && pedidoDms.claim?.status === 'rascunho' ? pedidoDms.claim : null}
          reserva={titulo}
          aoEnviado={(r) => {
            setPedidoDms(r);
            setResultado({
              titulo: `Pedido enviado à DMS · protocolo ${r.claim?.protocol ?? ''}`,
              texto: `A DMS confere os documentos e marca a videochamada pelo seu e-mail. Depois, avisamos ${primeiroNome(propriedade.owner.name)} no e-mail e esperamos 14 dias antes de decidir.`,
            });
            titulo.current?.focus({ preventScroll: true });
          }}
          aoFechar={() => setPainel(null)}
        />
      )}
      {painel?.tipo === 'aceitar-propriedade' && (
        <GavetaAceitarPropriedade
          pedido={painel.pedido}
          empresa={nomeEmpresa}
          reserva={titulo}
          aoAceitar={(r) => {
            const de = primeiroNome(painel.pedido.from.name);
            setPropriedade(r);
            setResultado({
              tipo: 'acao',
              titulo: `Agora você é a dona da ${nomeEmpresa}`,
              texto: `${de} passou a propriedade${painel.pedido.old_owner_stays ? ' e ficou como Administrador, sem a cobrança' : ' e saiu da empresa'}. Confira: a próxima fatura vai para o seu e-mail, e as contas conectadas continuam ligadas.`,
              verCobranca: true,
            });
            // As permissões mudaram (agora com a cobrança e quem tem acesso): a sessão lê de novo.
            if (empresa) disparar(trocarEmpresa(empresa.id).then(() => carregar()));
          }}
          aoFechar={() => setPainel(null)}
        />
      )}
      {painel?.tipo === 'decidir' && (
        <GavetaDecidir
          pedido={painel.pedido}
          nomeEmpresa={nomeEmpresa}
          reserva={titulo}
          aoAceitar={(aviso, nivel) => {
            avisar(aviso);
            setResultado({
              tipo: 'acao',
              titulo: `${painel.pedido.agency.name} entrou como parceira`,
              texto: `Agora a agência escolhe quem do time entra, até ${NIVEIS[nivel].nome}. Você recebe um aviso de cada pessoa nova.`,
            });
            disparar(carregar());
          }}
          aoRecusar={() => recusarPedido(painel.pedido)}
          aoSumir={painelSumiu}
          aoFechar={() => setPainel(null)}
        />
      )}
      {painel?.tipo === 'limites' && (
        <GavetaLimites
          parceiro={painel.parceiro}
          time={porVinculo.get(painel.parceiro.id) ?? []}
          reserva={titulo}
          aoSalvar={(aviso) => {
            avisar(aviso);
            disparar(carregar());
          }}
          aoSumir={painelSumiu}
          aoFechar={() => setPainel(null)}
        />
      )}
      {painel?.tipo === 'desfazer' && (
        <DialogoDesfazer
          parceiro={painel.parceiro}
          pessoas={porVinculo.get(painel.parceiro.id)?.length ?? 0}
          nomeEmpresa={nomeEmpresa}
          reserva={titulo}
          aoDesfazer={(aviso) => {
            avisar(aviso, { tipo: 'perigo' });
            setResultado({
              titulo: `Você desfez o vínculo com ${painel.parceiro.agency.name}`,
              texto: 'As pessoas da agência saíram na hora. O que elas fizeram continua no registro de atividades, com o nome da agência. A agência recebeu um e-mail.',
            });
            disparar(carregar());
            titulo.current?.focus({ preventScroll: true });
          }}
          aoFechar={() => setPainel(null)}
        />
      )}
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
