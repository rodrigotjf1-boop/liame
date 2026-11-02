'use client';

import type { AgencyReportDetailResponse, AgencyReportSentResponse } from '@liame/contracts';
import { type FormEvent, type RefObject, useId, useRef, useState } from 'react';
import { Icone } from '@/components/ui/icone';
import { useDialogo } from '@/components/ui/use-dialogo';
import { api, chamar, mensagemDe } from '@/lib/api';
import { disparar } from '@/lib/disparar';
import { NIVEIS } from '@/lib/niveis';
import { assuntoDoEmail, comentarioCurto, marcadosDePartida, nomeDoMes } from './relatorios-textos';

// "Mandar ao cliente" (P29 aprovado, gaveta à direita; D-A7-66 a D-A7-68): quem recebe (o Dono sempre; os outros, entre
// quem já pode receber o relatório), o resumo do e-mail (o assunto, o remetente, para onde vai a resposta e o
// comentário) e o que acontece com o e-mail do Liame. Mandar de novo é a versão corrigida.

type Props = {
  vinculo: string;
  detalhe: AgencyReportDetailResponse;
  comentario: string;
  reserva: RefObject<HTMLElement | null>;
  aoMandar: (r: AgencyReportSentResponse) => void;
  aoFechar: () => void;
};

export function GavetaMandar({ vinculo, detalhe: d, comentario, reserva, aoMandar, aoFechar }: Props) {
  const ids = useId();
  const primeiro = useRef<HTMLButtonElement>(null);
  const { ref, fechar, devolverFoco } = useDialogo({ focoInicial: primeiro, reserva });
  const anterior = d.sends[0] ?? null;
  const [marcados, setMarcados] = useState<Set<string>>(() => marcadosDePartida(d.recipients, anterior?.sent_to ?? null));
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState('');
  const marca = d.item.brand?.name ?? d.item.organization.name;
  const mes = d.report.month.from;
  const denovo = anterior !== null;
  const total = d.recipients.filter((p) => p.always || marcados.has(p.user_id)).length;

  async function mandar(e: FormEvent) {
    e.preventDefault();
    setErro('');
    setEnviando(true);
    const r = await chamar(() =>
      api.POST('/v1/agency/clients/{id}/reports/{reportId}/send', {
        params: { path: { id: vinculo, reportId: d.report.id } },
        body: { comment: comentario.trim() || null, recipient_ids: [...marcados] },
      }),
    );
    setEnviando(false);
    if (r.ok) {
      aoMandar(r.data);
      return fechar();
    }
    setErro(mensagemDe(r.problema));
  }

  return (
    <dialog
      ref={ref}
      className="dialogo dialogo--lado"
      aria-labelledby={`${ids}-t`}
      onClose={() => {
        aoFechar();
        devolverFoco();
      }}
    >
      <form className="dialogo-form" onSubmit={(e) => disparar(mandar(e))} noValidate>
        <div className="dialogo-cab">
          <h2 id={`${ids}-t`}>{denovo ? `Mandar de novo à ${marca}` : `Mandar o relatório à ${marca}`}</h2>
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
          <fieldset className="campo">
            <legend>Quem recebe</legend>
            <span className="campo-dica">
              Só gente da {d.item.organization.name} que já pode receber o relatório. Para incluir outra pessoa, o dono convida com o nível "Só relatórios por
              e-mail".
            </span>
            <div className="quem-recebe">
              {d.recipients.map((p) => (
                <label className="check" key={p.user_id}>
                  <input
                    type="checkbox"
                    checked={p.always || marcados.has(p.user_id)}
                    disabled={p.always || enviando}
                    onChange={(e) =>
                      setMarcados((m) => {
                        const novo = new Set(m);
                        if (e.target.checked) novo.add(p.user_id);
                        else novo.delete(p.user_id);
                        return novo;
                      })
                    }
                  />
                  <span>
                    <b>
                      {p.name} · {p.role === 'dono' ? 'Dono' : NIVEIS[p.role].nome}
                    </b>{' '}
                    · <span className="quem-email">{p.email}</span>
                    {p.always && ' · sempre recebe'}
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          <dl className="resumo-pedido">
            <div>
              <dt>Assunto</dt>
              <dd>{assuntoDoEmail(d.agency.name, mes, marca, denovo)}</dd>
            </div>
            <div>
              <dt>De</dt>
              <dd>{d.agency.name} pelo Liame</dd>
            </div>
            <div>
              <dt>Responder vai para</dt>
              <dd>{d.agency.reply_to ?? 'o Liame (a agência ainda não tem o e-mail de resposta confirmado)'}</dd>
            </div>
            <div>
              <dt>O comentário</dt>
              <dd>{comentarioCurto(comentario)}</dd>
            </div>
          </dl>
          <p className="lite-frase">
            {denovo
              ? 'Quem receber ganha outro e-mail, marcado como versão corrigida.'
              : `Quem receber este não recebe o e-mail do Liame de ${nomeDoMes(mes)}, que estava esperando você.`}
          </p>
        </div>
        <div className="dialogo-acoes">
          <button className="btn" type="button" onClick={fechar} disabled={enviando}>
            Cancelar
          </button>
          <button ref={primeiro} className="btn btn--primary" type="submit" disabled={enviando}>
            {enviando ? 'Mandando…' : `${denovo ? 'Mandar de novo' : 'Mandar agora'} (${total})`}
          </button>
        </div>
      </form>
    </dialog>
  );
}
