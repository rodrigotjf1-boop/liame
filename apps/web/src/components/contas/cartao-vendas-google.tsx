'use client';

import type { GoogleConversionAccount } from '@liame/contracts';
import Link from 'next/link';
import { useEffect, useId, useRef, useState } from 'react';
import { ConfirmaNaLinha } from '@/components/ui/confirma-na-linha';
import { Icone } from '@/components/ui/icone';
import { disparar } from '@/lib/disparar';
import { inteiro } from '@/lib/formato';
import { useModo } from '@/lib/modo';
import { idDaConta } from './textos';
import { ENVIA_AO_GOOGLE, esperaPorExtenso, numerosDasVendas, vendasDaConta } from './vendas-google';

// "Vendas informadas ao Google" (protótipo P14, aprovado em 09/10/2026): um cartão por conta do Google Ads da marca
// com a função ligada, depois das autorizações. Diz se o Liame está informando, para qual conversão da conta e quantas
// vendas saíram, esperam, foram corrigidas ou recusadas; deixa escolher e trocar a conversão, parar e voltar; e mostra
// o que o Liame envia. Quem não conecta contas só vê. O motivo como o Google respondeu aparece no Pro.

type Props = {
  conta: GoogleConversionAccount;
  agora: Date;
  /** Quantos minutos depois de confirmado o pedido sai. */
  esperaMin: number;
  /** De quantos dias são as contagens. */
  janelaDias: number;
  /** Quem vê pode escolher, trocar e parar (`contas.conectar`). */
  podeGerir: boolean;
  /** Muda quando a tela quer o foco no cartão (depois de escolher a conversão no diálogo). */
  pedirFoco?: number;
  /** Leva à página do Google para autorizar de novo. Verdadeiro: está indo (o botão segue ocupado até a página trocar). */
  aoAutorizar: () => Promise<boolean>;
  aoEscolher: () => void;
  aoParar: () => Promise<boolean>;
  aoVoltar: () => Promise<boolean>;
};

export function CartaoVendasGoogle({ conta: c, agora, esperaMin, janelaDias, podeGerir, pedirFoco = 0, aoAutorizar, aoEscolher, aoParar, aoVoltar }: Props) {
  const { modo } = useModo();
  const ids = useId();
  const [aberto, setAberto] = useState(false);
  const [confirmando, setConfirmando] = useState(false);
  const [ocupado, setOcupado] = useState<'parar' | 'voltar' | 'autorizar' | null>(null);
  // Para onde o foco vai depois que o cartão muda (parou: "Voltar a informar"; voltou ou escolheu: "Parar de informar").
  const focar = useRef<'parar' | 'voltar' | null>(null);
  const botaoParar = useRef<HTMLButtonElement>(null);
  const botaoVoltar = useRef<HTMLButtonElement>(null);
  const focoPedido = useRef(pedirFoco);
  const v = vendasDaConta(c, { agora, esperaMin, janelaDias });
  const acoes = podeGerir ? v.acoes : v.acoes.filter((a) => a === 'equipe');

  useEffect(() => {
    if (pedirFoco !== focoPedido.current) {
      focoPedido.current = pedirFoco;
      focar.current = 'parar';
    }
    // Uma tentativa só: o pedido de foco não fica guardado para um botão que apareça mais tarde.
    const alvo = focar.current === 'parar' ? botaoParar.current : focar.current === 'voltar' ? botaoVoltar.current : null;
    focar.current = null;
    alvo?.focus();
  });

  async function parar() {
    setOcupado('parar');
    const ok = await aoParar();
    // Antes de redesenhar: o efeito que roda depois do redesenho é quem leva o foco.
    focar.current = ok ? 'voltar' : 'parar';
    setOcupado(null);
    setConfirmando(false);
  }

  async function voltar() {
    setOcupado('voltar');
    const ok = await aoVoltar();
    if (ok) focar.current = 'parar';
    setOcupado(null);
  }

  async function autorizar() {
    setOcupado('autorizar');
    if (!(await aoAutorizar())) setOcupado(null);
  }

  return (
    <li className="card autorizacao autorizacao--larga" aria-labelledby={`${ids}-t`}>
      <div className="aut-cab">
        <span className="plat plat--google">Google Ads</span>
        <b id={`${ids}-t`}>Vendas informadas ao Google</b>
        <span className="aut-meta">
          {c.name} · <span className="mono">{idDaConta('google_ads', c.external_id)}</span>
        </span>
        <span className={`st ${v.selo.classe}`}>
          <span className="dot" aria-hidden="true" />
          {v.selo.rotulo}
        </span>
      </div>
      <p className="aut-txt">
        O pedido confirmado no caixa que veio de um clique num anúncio do Google é informado ao Google, com o valor, {esperaPorExtenso(esperaMin)} depois da confirmação. Assim ele
        passa a buscar quem compra, e não só quem clica.
      </p>
      {v.destino && (
        <p className="conv-destino">
          <span>
            Contadas em <b>{v.destino.nome}</b>
          </span>
          <span className="aut-meta">{v.destino.meta}</span>
        </p>
      )}
      {v.avisos.map((a) => (
        <p key={a.texto} className={`aut-txt aut-txt--${a.tom}`}>
          <Icone nome={a.icone} pequeno />
          <span>
            {a.forte && <b>{a.forte} </b>}
            {a.texto}
            {a.tecnico && modo === 'pro' && (
              <span className="conv-so-pro">
                {' '}
                {a.tecnico.rotulo}: <code>{a.tecnico.valor}</code>
              </span>
            )}
          </span>
        </p>
      ))}
      {v.numeros && (
        <div className="conv-nums" role="group" aria-label={`Vendas dos últimos ${janelaDias} dias`}>
          {numerosDasVendas(c.counts, esperaMin).map((n) => (
            <p key={n.rotulo} className={`conv-num${n.atencao ? ' conv-num--atencao' : ''}`}>
              <b className="num">{inteiro(n.valor)}</b> <span>{n.rotulo}</span>
            </p>
          ))}
        </div>
      )}
      {v.passagem && <p className="aut-meta">{v.passagem}</p>}
      {!podeGerir && <p className="aut-txt">Só quem conecta contas na empresa muda isto.</p>}
      <div className="aut-escopos" id={`${ids}-envia`} hidden={!aberto}>
        <ul className="escopos">
          {ENVIA_AO_GOOGLE.map((e) => (
            <li key={e.rotulo} className="escopo">
              <Icone nome="check" pequeno />
              <div>
                <p className="escopo-cab">
                  <b>{e.rotulo}</b>
                </p>
                <p className="escopo-txt">{e.texto}</p>
              </div>
            </li>
          ))}
        </ul>
        <p className="aut-txt">
          <b>Nunca envia:</b> nome, telefone, e-mail ou endereço de quem comprou; o custo, a margem e os itens do pedido.
        </p>
      </div>
      <div className="seg-acoes">
        <button className="btn btn--sm btn-alternar" type="button" aria-expanded={aberto} aria-controls={`${ids}-envia`} onClick={() => setAberto((a) => !a)}>
          O que o Liame envia
          <Icone nome="chevron-down" pequeno />
        </button>
        {acoes.includes('autorizar') && (
          <button className="btn btn--sm btn--primary" type="button" onClick={() => disparar(autorizar())} disabled={ocupado !== null} aria-busy={ocupado === 'autorizar'}>
            {ocupado === 'autorizar' ? 'Indo para o Google…' : 'Autorizar o Google de novo'}
          </button>
        )}
        {acoes.includes('escolher') && (
          <button className="btn btn--sm btn--primary" type="button" aria-haspopup="dialog" onClick={aoEscolher} aria-label={`Escolher a conversão: ${c.name}`}>
            Escolher a conversão
          </button>
        )}
        {acoes.includes('voltar') && (
          <button
            ref={botaoVoltar}
            className="btn btn--sm btn--primary"
            type="button"
            onClick={() => disparar(voltar())}
            disabled={ocupado !== null}
            aria-busy={ocupado === 'voltar'}
            aria-label={ocupado === 'voltar' ? undefined : `Voltar a informar: ${c.name}`}
          >
            {ocupado === 'voltar' ? 'Voltando…' : 'Voltar a informar'}
          </button>
        )}
        {acoes.includes('trocar') && !confirmando && (
          <button className="btn btn--sm" type="button" aria-haspopup="dialog" onClick={aoEscolher} aria-label={`Trocar a conversão: ${c.name}`}>
            Trocar a conversão
          </button>
        )}
        {acoes.includes('parar') &&
          (confirmando ? (
            <ConfirmaNaLinha
              texto="Nenhuma venda nova é informada, nem as que esperam a vez. As que já foram informadas continuam no Google."
              rotulo="Parar agora"
              rotuloOcupado="Parando…"
              ocupado={ocupado === 'parar'}
              aoConfirmar={() => disparar(parar())}
              aoCancelar={() => {
                setConfirmando(false);
                focar.current = 'parar';
              }}
            />
          ) : (
            <button
              ref={botaoParar}
              className="btn btn--sm btn--perigo"
              type="button"
              onClick={() => setConfirmando(true)}
              disabled={ocupado !== null}
              aria-label={`Parar de informar: ${c.name}`}
            >
              Parar de informar
            </button>
          ))}
        {acoes.includes('equipe') && (
          <Link className="btn btn--sm" href="/equipe">
            Abrir Sua equipe
          </Link>
        )}
      </div>
    </li>
  );
}
