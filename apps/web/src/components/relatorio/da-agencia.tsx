'use client';

import type { MonthlyReportFromAgency } from '@liame/contracts';
import { useState } from 'react';
import { iniciaisDaAgencia } from '@/components/agencia/marca-textos';
import { Icone } from '@/components/ui/icone';
import { quandoComHora } from '@/lib/formato';

// O que a agência mandou deste relatório (P29 aprovado; A7, W7, parte 5a): a faixa no alto do relatório que o dono lê,
// a marca da agência ("preparado por …, com o Liame") e o comentário assinado. Os números são os do relatório do mês.

/** O alto da faixa: "Agência Fogo mandou este relatório hoje, 09:40" (com a versão corrigida, quando é). */
export function tituloDaAgencia(a: MonthlyReportFromAgency, agora = new Date()): string {
  return `${a.agency_name} mandou este relatório ${quandoComHora(a.sent_at, agora)}${a.version > 1 ? ', na versão corrigida' : ''}`;
}

/** A linha de baixo: quem comentou, ou que saiu sozinho. */
export function detalheDaAgencia(a: MonthlyReportFromAgency): string {
  if (!a.sent_by_name) return 'Saiu sozinho, no dia 2, sem comentário.';
  return a.comment ? `Com um comentário de ${a.sent_by_name}.` : `Mandado por ${a.sent_by_name}, sem comentário.`;
}

export function DaAgencia({ agencia: a }: { agencia: MonthlyReportFromAgency }) {
  // O logo é público (o mesmo do e-mail); se não abrir, ficam as iniciais.
  const [semLogo, setSemLogo] = useState(false);
  return (
    <>
      <div className="faixa faixa--acao">
        <span className="faixa-ic">
          <Icone nome="mail" />
        </span>
        <span className="faixa-txt">
          <b>{tituloDaAgencia(a)}</b>
          <span>{detalheDaAgencia(a)}</span>
        </span>
      </div>
      <article className="card rel-agencia" aria-label={`O que ${a.agency_name} mandou`}>
        <div className="rel-agencia-marca">
          {a.logo_url && !semLogo ? (
            <img className="logo-ag-img" src={a.logo_url} alt={`Logo da ${a.agency_name}`} onError={() => setSemLogo(true)} />
          ) : (
            <span className="logo-ag logo-ag--vazio" aria-hidden="true">
              {iniciaisDaAgencia(a.agency_name)}
            </span>
          )}
          <span>
            <b>{a.agency_name}</b>
            <small>preparado por {a.agency_name}, com o Liame</small>
          </span>
        </div>
        {a.comment && (
          <blockquote className="comentario-ag">
            <p>{a.comment}</p>
            <footer>
              {a.sent_by_name ?? a.agency_name}, {a.agency_name}
            </footer>
          </blockquote>
        )}
      </article>
    </>
  );
}
