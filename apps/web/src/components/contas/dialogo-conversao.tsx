'use client';

import type { GoogleConversionAccount, GoogleConversionAction, GoogleConversionsResponse } from '@liame/contracts';
import { type FormEvent, type RefObject, useCallback, useEffect, useId, useRef, useState } from 'react';
import { Estado } from '@/components/ui/estado';
import { Icone } from '@/components/ui/icone';
import { useDialogo } from '@/components/ui/use-dialogo';
import { api, chamar, mensagemDe, type Problema } from '@/lib/api';
import { disparar } from '@/lib/disparar';
import { ENVIA_AO_GOOGLE, NUNCA_VAI_AO_GOOGLE, notaDaConversao, notaDaEscolha } from './vendas-google';

// "Onde o Google conta essas vendas" (protótipo P14, aprovado em 09/10/2026): as conversões da conta do Google Ads que
// recebem vendas importadas, lidas no Google na hora em que o diálogo abre. A pessoa escolhe uma; o servidor confere a
// escolhida no Google antes de gravar. Antes de qualquer envio, o diálogo mostra o que o Liame envia e o que nunca
// envia. Conta sem conversão: o caminho para criar uma no Google Ads (Ajuda do Google, base de conhecimento §3.2).

type Props = {
  conta: GoogleConversionAccount;
  /** Quantos minutos depois de confirmado o pedido sai. */
  esperaMin: number;
  reserva: RefObject<HTMLElement | null>;
  /** Escolhida: a situação nova das contas da marca (a tela fecha o diálogo e leva o foco ao cartão). */
  aoEscolher: (resposta: GoogleConversionsResponse) => void;
  /** O Google recusou a autorização desta conta: a saída é autorizar de novo. */
  aoAutorizar: () => void;
  aoFechar: () => void;
};

type Lista = { tipo: 'lendo' } | { tipo: 'ok'; itens: GoogleConversionAction[] } | { tipo: 'erro'; problema: Problema };

export function DialogoConversao({ conta, esperaMin, reserva, aoEscolher, aoAutorizar, aoFechar }: Props) {
  const { ref, fechar, devolverFoco } = useDialogo({ reserva });
  const ids = useId();
  const caixa = useRef<HTMLDivElement>(null);
  const resposta = useRef<GoogleConversionsResponse | null>(null);
  const informando = conta.destination !== null && conta.destination.stopped_at === null;
  const [lista, setLista] = useState<Lista>({ tipo: 'lendo' });
  // Com a conta informando, a conversão de hoje já vem marcada (é a troca); senão, a pessoa escolhe.
  const [escolhida, setEscolhida] = useState(informando ? (conta.destination?.conversion_action_id ?? '') : '');
  const [faltou, setFaltou] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState('');
  const contaId = conta.connected_account_id;

  const ler = useCallback(async () => {
    setLista({ tipo: 'lendo' });
    const r = await chamar(() => api.GET('/v1/conversions/google/actions', { params: { query: { connected_account_id: contaId } } }));
    if (!r.ok) return setLista({ tipo: 'erro', problema: r.problema });
    setLista({ tipo: 'ok', itens: r.data.items });
    // A conversão que estava marcada pode não existir mais no Google: nada fica marcado às escondidas.
    setEscolhida((atual) => (r.data.items.some((a) => a.id === atual) ? atual : ''));
  }, [contaId]);

  useEffect(() => {
    disparar(ler());
  }, [ler]);

  // A lista chegou (ou falhou): o foco vai para a primeira escolha, ou para o título do aviso.
  const chegou = lista.tipo;
  useEffect(() => {
    if (chegou === 'lendo') return;
    caixa.current?.querySelector<HTMLElement>('input[type="radio"]:checked, input[type="radio"], h3')?.focus();
  }, [chegou]);

  async function comecar(e: FormEvent) {
    e.preventDefault();
    if (lista.tipo !== 'ok' || !lista.itens.length) return;
    if (!escolhida) {
      setFaltou(true);
      caixa.current?.querySelector<HTMLElement>('input[type="radio"]')?.focus();
      return;
    }
    setErro('');
    setEnviando(true);
    const r = await chamar(() => api.PUT('/v1/conversions/google/destination', { body: { connected_account_id: contaId, conversion_action_id: escolhida } }));
    setEnviando(false);
    if (!r.ok) {
      setErro(mensagemDe(r.problema));
      // A conversão saiu do Google entre a leitura e a escolha: a lista é lida de novo.
      if (r.problema.code === 'conversao-nao-encontrada') disparar(ler());
      return;
    }
    resposta.current = r.data;
    fechar();
  }

  const itens = lista.tipo === 'ok' ? lista.itens : [];
  const semPermissao = lista.tipo === 'erro' && lista.problema.code === 'google-sem-permissao';
  return (
    <dialog
      ref={ref}
      className="dialogo"
      aria-labelledby={`${ids}-t`}
      onClose={() => {
        if (resposta.current) return aoEscolher(resposta.current);
        aoFechar();
        devolverFoco();
      }}
      onClick={(e) => {
        if (e.target === ref.current && !enviando) fechar();
      }}
    >
      <form className="dialogo-form" onSubmit={(e) => disparar(comecar(e))} noValidate>
        <div className="dialogo-cab">
          <h2 id={`${ids}-t`}>Onde o Google conta essas vendas</h2>
          <button className="btn btn--ghost btn--icon" type="button" onClick={fechar} aria-label="Fechar" disabled={enviando}>
            <Icone nome="x" />
          </button>
        </div>
        <div className="dialogo-corpo">
          {erro && (
            <p className="dialogo-erro" role="alert">
              <Icone nome="alert" pequeno />
              <span>{erro}</span>
            </p>
          )}
          <p className="dlg-lead">Escolha a conversão da conta {conta.name} que vai receber as vendas confirmadas no caixa.</p>
          <div ref={caixa}>
            {lista.tipo === 'lendo' && (
              <p className="conv-lendo" role="status">
                <span className="girando" aria-hidden="true" />
                Lendo as conversões da conta no Google…
              </p>
            )}
            {lista.tipo === 'erro' && (
              <div role="alert">
                <Estado
                  compacto
                  perigo
                  icone="alert-circle"
                  titulo={semPermissao ? 'O Google pede uma nova autorização' : 'Não foi possível ler as conversões desta conta'}
                  acao={
                    <div className="vazio-acoes">
                      {semPermissao ? (
                        <button
                          className="btn btn--sm btn--primary"
                          type="button"
                          onClick={() => {
                            fechar();
                            aoAutorizar();
                          }}
                        >
                          Autorizar o Google de novo
                        </button>
                      ) : (
                        <button className="btn btn--sm btn--primary" type="button" onClick={() => disparar(ler())}>
                          Tentar de novo
                        </button>
                      )}
                    </div>
                  }
                >
                  {mensagemDe(lista.problema)}
                </Estado>
              </div>
            )}
            {lista.tipo === 'ok' && !itens.length && (
              <Estado
                compacto
                icone="info"
                titulo="Esta conta ainda não tem uma conversão para vendas importadas"
                acao={
                  <div className="vazio-acoes">
                    <button className="btn btn--sm" type="button" onClick={() => disparar(ler())}>
                      <Icone nome="refresh" pequeno />
                      Ler a lista de novo
                    </button>
                  </div>
                }
              >
                Crie uma no Google Ads e volte aqui. Lá, no menu <b>Metas</b>, em <b>Resumo</b>, use <b>Criar ação de conversão</b> e escolha <b>Conversões off-line</b>.
              </Estado>
            )}
            {itens.length > 0 && (
              <fieldset className="campo">
                <legend>Conversões da conta que recebem vendas importadas</legend>
                <div className="conv-lista">
                  {itens.map((a) => (
                    <label className="escolha" key={a.id}>
                      <input
                        type="radio"
                        name={`${ids}-conv`}
                        value={a.id}
                        checked={escolhida === a.id}
                        disabled={enviando}
                        aria-describedby={faltou ? `${ids}-falta` : undefined}
                        onChange={() => {
                          setEscolhida(a.id);
                          setFaltou(false);
                        }}
                      />
                      <span>
                        <b>{a.name}</b>
                        <span className="mono">{a.id}</span>
                      </span>
                      <span className="lite-chip">{notaDaConversao(a)}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
            )}
          </div>
          {faltou && (
            <p className="campo-erro" id={`${ids}-falta`} role="alert">
              Escolha uma conversão para continuar.
            </p>
          )}
          <section className="bloco-dlg" aria-labelledby={`${ids}-envia`}>
            <h3 className="rotulo-marca" id={`${ids}-envia`}>
              O que o Liame envia
            </h3>
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
          </section>
          <section className="bloco-dlg" aria-labelledby={`${ids}-nunca`}>
            <h3 className="rotulo-marca" id={`${ids}-nunca`}>
              O que o Liame nunca envia
            </h3>
            <ul className="nao-vem">
              {NUNCA_VAI_AO_GOOGLE.map((texto) => (
                <li key={texto}>
                  <Icone nome="lock" pequeno />
                  <span>{texto}</span>
                </li>
              ))}
            </ul>
          </section>
          <p className="dialogo-nota">
            <Icone nome="clock" pequeno />
            <span>{notaDaEscolha(esperaMin, informando)}</span>
          </p>
        </div>
        <div className="dialogo-acoes">
          <button className="btn" type="button" onClick={fechar} disabled={enviando}>
            Agora não
          </button>
          {itens.length > 0 && (
            <button className="btn btn--primary" type="submit" disabled={enviando} aria-busy={enviando}>
              {enviando ? 'Começando…' : 'Começar a informar'}
            </button>
          )}
        </div>
      </form>
    </dialog>
  );
}
