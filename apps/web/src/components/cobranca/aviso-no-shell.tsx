'use client';

import type { BillingContactsResponse, BillingInvoice } from '@liame/contracts';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { Faixa } from '@/components/ui/faixa';
import { Icone } from '@/components/ui/icone';
import { api, chamar } from '@/lib/api';
import { disparar } from '@/lib/disparar';
import { useSessao } from '@/lib/sessao';
import { DialogoPix } from './dialogo-pix';
import { diaMesDe, faixaDoAtraso, faturaDaFaixa, quemResolve } from './textos';

// O atraso nas outras telas (A7 · W5, parte 4; D-A7-15; P26): a faixa no alto de todas as telas da empresa — para quem
// paga, desde o 1º dia, com o botão de pagar; para o resto da equipe, a partir do 10º dia, dizendo quem resolve — e,
// com todas as marcas suspensas, a tela da conta suspensa no lugar do conteúdo para quem não é o Dono (D-A7-40). Em
// Plano e cobrança a faixa não aparece: a situação da tela já diz o mesmo. A situação é lida ao abrir e ao trocar de
// empresa; enquanto há atraso, de novo a cada tela (pagou, a faixa sai na tela seguinte).

type Situacao = BillingContactsResponse | null;

export function AvisoDaCobranca({ children }: { children: ReactNode }) {
  const { empresa, pode } = useSessao();
  const caminho = usePathname();
  const [situacao, setSituacao] = useState<Situacao>(null);
  const [pix, setPix] = useState<{ fatura: BillingInvoice; marca: string; brandId: string } | null>(null);
  const reserva = useRef<HTMLDivElement>(null);
  const seq = useRef(0);
  const empresaId = empresa?.id ?? null;
  const comAtraso = Boolean(situacao && (situacao.overdue.length || situacao.all_suspended));

  const ler = useCallback(async () => {
    const id = ++seq.current;
    const r = await chamar(() => api.GET('/v1/billing/contacts'));
    if (id === seq.current) setSituacao(r.ok ? r.data : null);
  }, []);

  useEffect(() => {
    setSituacao(null);
    if (empresaId) disparar(ler());
  }, [empresaId, ler]);

  // Enquanto há atraso, a situação é lida de novo a cada tela (o caminho muda): o pagamento tira a faixa.
  const caminhoLido = useRef(caminho);
  useEffect(() => {
    if (caminhoLido.current === caminho) return;
    caminhoLido.current = caminho;
    if (comAtraso && empresaId) disparar(ler());
  }, [caminho, comAtraso, empresaId, ler]);

  if (!empresa || !situacao?.enabled) return <>{children}</>;
  const souDono = empresa.role === 'dono';
  const resolve = quemResolve(situacao.items);

  // A conta inteira suspensa: quem não é o Dono não entra em nada da empresa (D-A7-40); a tela diz desde quando e quem
  // resolve (P26). Nada foi apagado: o que acontece com os dados depois é a W3, parte 4.
  if (situacao.all_suspended && !souDono) {
    const marca = situacao.suspended[0];
    return (
      <section aria-labelledby="h-conta-suspensa">
        <div className="card">
          <div className="vazio">
            <span className="vazio-ic vazio-ic--perigo" aria-hidden="true">
              <Icone nome="lock" />
            </span>
            <h2 id="h-conta-suspensa" tabIndex={-1}>
              {marca ? `A conta da ${marca.brand_name} está suspensa` : 'A conta está suspensa'}
            </h2>
            <p>
              {marca ? `Desde ${diaMesDe(marca.since)}, por uma mensalidade em aberto.` : 'Por uma mensalidade em aberto.'} Só o Dono entra, para pagar ou exportar os dados. Quem resolve:{' '}
              {resolve}.
            </p>
            <p>Nada foi apagado. Pagou, a equipe entra de novo na hora.</p>
          </div>
        </div>
      </section>
    );
  }

  const naCobranca = caminho === '/cobranca' || caminho.startsWith('/cobranca/');
  const primeira = situacao.overdue[0];
  const paga = pode('cobranca.pagar');
  const faixa = primeira && !naCobranca ? faixaDoAtraso(primeira, { paga, souDono, resolve }) : null;
  const fatura = primeira && faixa?.pagar ? faturaDaFaixa(primeira) : null;

  return (
    <>
      {faixa && primeira && (
        <div className="cob-faixa" ref={reserva} tabIndex={-1}>
          <Faixa
            tipo={faixa.tipo}
            icone={<Icone nome={faixa.tipo === 'perigo' ? (primeira.status === 'suspensa' ? 'lock' : 'pause') : 'alert'} />}
            titulo={faixa.titulo}
            texto={faixa.texto}
            acao={
              paga ? (
                <div className="cob-faixa-acoes">
                  {fatura && (
                    <button className="btn btn--primary btn--sm" type="button" aria-haspopup="dialog" onClick={() => setPix({ fatura, marca: primeira.brand_name, brandId: primeira.brand_id })}>
                      Pagar com PIX
                    </button>
                  )}
                  {pode('cobranca.ver') && (
                    <Link className="btn btn--sm" href={`/cobranca?marca=${primeira.brand_id}`}>
                      Ver a cobrança
                    </Link>
                  )}
                </div>
              ) : undefined
            }
          />
        </div>
      )}
      {children}
      {pix && (
        <DialogoPix
          brandId={pix.brandId}
          marca={pix.marca}
          fatura={pix.fatura}
          assinando={false}
          reserva={reserva}
          aoFechar={() => {
            setPix(null);
            disparar(ler());
          }}
          aoAtualizar={() => undefined}
        />
      )}
    </>
  );
}
