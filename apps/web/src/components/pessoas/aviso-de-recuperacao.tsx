'use client';

import type { AccountRecoveryNotice, AccountRecoveryNoticeResponse } from '@liame/contracts';
import { useState } from 'react';
import { useAvisar } from '@/components/ui/avisos';
import { ConfirmaNaLinha } from '@/components/ui/confirma-na-linha';
import { Faixa } from '@/components/ui/faixa';
import { Icone } from '@/components/ui/icone';
import { api, chamar, mensagemDe } from '@/lib/api';
import { disparar } from '@/lib/disparar';
import { diaHora, quandoComHora } from '@/lib/formato';
import { primeiroNome } from './propriedade-textos';

// O aviso aos Administradores na espera da recuperação da conta do Dono (P34 aprovado; A7, W8, parte 5; D-A7-62,
// D-A7-64), no alto de Pessoas e acessos: quem pediu, quando a DMS conferiu e quando o app é trocado, com "Não reconheço
// este pedido". Parado, a faixa diz que a DMS fala com o Dono antes de seguir.

type Props = { aviso: AccountRecoveryNotice; aoMudar: (r: AccountRecoveryNoticeResponse) => void };

export function AvisoDeRecuperacao({ aviso: a, aoMudar }: Props) {
  const avisar = useAvisar();
  const [parando, setParando] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const nome = primeiroNome(a.owner_name);

  async function parar() {
    setEnviando(true);
    const r = await chamar(() => api.POST('/v1/account-recovery/{id}/stop', { params: { path: { id: a.id } } }));
    setEnviando(false);
    setParando(false);
    if (!r.ok) return avisar(mensagemDe(r.problema), { tipo: 'perigo' });
    avisar(`Pedido parado. Avisamos a DMS e ${nome}.`);
    aoMudar(r.data);
  }

  if (a.status === 'parado') {
    return (
      <Faixa
        tipo="atencao"
        icone={<Icone nome="alert" />}
        titulo={a.stopped_by_me ? `Você parou o pedido de recuperação da conta de ${nome}` : `O pedido de recuperação da conta de ${nome} está parado`}
        texto={`Avisamos a DMS. O pedido só volta a andar depois que a DMS falar com ${nome} pelo e-mail e pelo telefone cadastrados. Nada mudou na conta.`}
      />
    );
  }

  return (
    <article className="card pedido-prop" aria-labelledby="rv-t">
      <div className="pedido-prop-cab">
        <span className="st st--aguardando">
          <span className="dot" aria-hidden="true" />
          Pedido de recuperação
        </span>
        <span className="campo-dica">
          Protocolo <span className="num">{a.protocol}</span>
        </span>
      </div>
      <h2 id="rv-t">{nome} pediu à DMS para recuperar a entrada na conta</h2>
      <p className="lite-frase">
        {nome} disse que perdeu o celular e os códigos de recuperação. A DMS conferiu o documento, o quadro de sócios na Receita e fez uma videochamada.{' '}
        {a.applies_at && <b>Se nada mudar, em {diaHora(a.applies_at)}, o app autenticador de {nome} é trocado.</b>}
      </p>
      <dl className="pedido-prop-dados">
        <div>
          <dt>Pedido em</dt>
          <dd className="num">{quandoComHora(a.created_at)}</dd>
        </div>
        <div>
          <dt>Conferido pela DMS em</dt>
          <dd className="num">{quandoComHora(a.checked_at)}</dd>
        </div>
        {a.applies_at && (
          <div>
            <dt>O app de {nome} é trocado em</dt>
            <dd className="num">{quandoComHora(a.applies_at)}</dd>
          </div>
        )}
      </dl>
      <p className="lite-frase">
        Este aviso foi para os Administradores e para o e-mail de {nome}. Só {nome} cancela o pedido. Se você não reconhece, pare o pedido: a DMS fala com {nome}{' '}
        antes de seguir.
      </p>
      <div className="pedido-prop-acoes">
        {parando ? (
          <ConfirmaNaLinha
            texto={`Parar o pedido? A DMS fala com ${nome} antes de seguir.`}
            rotulo="Parar o pedido"
            rotuloOcupado="Parando…"
            voltar="Voltar"
            ocupado={enviando}
            aoConfirmar={() => disparar(parar())}
            aoCancelar={() => setParando(false)}
          />
        ) : (
          <button className="btn btn--perigo" type="button" onClick={() => setParando(true)}>
            Não reconheço este pedido
          </button>
        )}
      </div>
    </article>
  );
}
