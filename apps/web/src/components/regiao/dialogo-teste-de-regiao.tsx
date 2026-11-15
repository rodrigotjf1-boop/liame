'use client';

import { REGION_TEST_DAYS, REGION_TEST_MIN_OTHER_DISTRICTS, REGION_TEST_MIN_WEEKLY_ORDERS, type RegionTestResponse } from '@liame/contracts';
import Link from 'next/link';
import { type RefObject, useEffect, useId, useRef, useState } from 'react';
import { Icone } from '@/components/ui/icone';
import { useDialogo } from '@/components/ui/use-dialogo';
import { api, chamar, type Problema } from '@/lib/api';
import { disparar } from '@/lib/disparar';

// "Testar um bairro sem anúncio" (plano da região, R8; D-RG-81 e D-RG-82): em Minha marca › Região › Sua região, no bairro
// dos pedidos. O pedido vai para Aprovações com o código do app; quando o bairro não pode ser testado, a tela diz o motivo
// da rota e nada vai para Aprovações. Por enquanto, aprovar só deixa o teste pronto (a tela diz).

type Props = {
  brandId: string;
  unitId: string;
  bairro: { code: string; name: string };
  reserva?: RefObject<HTMLElement | null>;
  aoFechar: () => void;
};

type Fase = { tipo: 'pedir' } | { tipo: 'enviando' } | { tipo: 'criado'; t: RegionTestResponse } | { tipo: 'nao-da'; p: Problema };

export function DialogoTesteDeRegiao({ brandId, unitId, bairro, reserva, aoFechar }: Props) {
  const ids = useId();
  const titulo = useRef<HTMLHeadingElement>(null);
  const { ref, fechar, devolverFoco } = useDialogo({ focoInicial: titulo, reserva });
  const [fase, setFase] = useState<Fase>({ tipo: 'pedir' });
  const enviando = fase.tipo === 'enviando';

  // O resultado troca o conteúdo: o foco vai para o título novo.
  useEffect(() => {
    if (fase.tipo === 'criado' || fase.tipo === 'nao-da') titulo.current?.focus();
  }, [fase.tipo]);

  async function pedir() {
    setFase({ tipo: 'enviando' });
    const r = await chamar(() => api.POST('/v1/region-tests', { body: { brand_id: brandId, unit_id: unitId, district_code: bairro.code } }));
    setFase(r.ok ? { tipo: 'criado', t: r.data } : { tipo: 'nao-da', p: r.problema });
  }

  const tituloDaFase = fase.tipo === 'criado' ? 'Pedido criado' : fase.tipo === 'nao-da' ? `Não dá para testar ${bairro.name} agora` : `Testar ${bairro.name} sem anúncio`;

  return (
    <dialog
      ref={ref}
      className="dialogo"
      aria-labelledby={`${ids}-t`}
      onClose={() => {
        aoFechar();
        devolverFoco();
      }}
      onClick={(e) => {
        if (e.target === ref.current && !enviando) fechar();
      }}
    >
      <div className="dialogo-form">
        <div className="dialogo-cab">
          <div className="dlg-titulo">
            <p className="rotulo-marca">Teste de região</p>
            <h2 id={`${ids}-t`} ref={titulo} tabIndex={-1}>
              {tituloDaFase}
            </h2>
          </div>
          <button className="btn btn--icon btn--ghost" type="button" onClick={fechar} aria-label="Fechar" disabled={enviando}>
            <Icone nome="x" />
          </button>
        </div>
        <div className="dialogo-corpo">
          {fase.tipo === 'criado' ? (
            <p>
              <b>{fase.t.name}.</b> O pedido espera a aprovação em Aprovações, com o código do app. Por enquanto, aprovar só deixa o teste pronto: tirar o bairro dos anúncios entra numa próxima etapa do
              Liame.
            </p>
          ) : fase.tipo === 'nao-da' ? (
            <>
              <div className="pd-aviso pd-aviso--perigo" role="alert">
                <Icone nome="alert-circle" />
                <div>
                  <b>{fase.p.title}</b>
                  <span>{fase.p.detail ?? 'O Liame não conseguiu pedir o teste agora. Tente de novo em alguns minutos.'}</span>
                </div>
              </div>
              <p className="rg-nota">
                <Icone nome="shield" pequeno />
                <span>
                  O teste também não é pedido com menos de {REGION_TEST_MIN_WEEKLY_ORDERS} pedidos por semana no bairro, com menos de {REGION_TEST_MIN_OTHER_DISTRICTS} outros bairros para comparar, sem os
                  pedidos por bairro do Regem, ou com outro teste na marca.
                </span>
              </p>
            </>
          ) : (
            <>
              <p className="lite-frase">
                Por {REGION_TEST_DAYS} dias, <b>{bairro.name} fica sem anúncio</b> nas campanhas do Liame. Depois, o Liame compara os pedidos do bairro no caixa com os dos outros bairros, antes e durante: é como se
                descobre quantos pedidos o anúncio traz ali. A verba não muda.
              </p>
              <p className="rg-nota">
                <Icone nome="shield" pequeno />
                <span>O pedido vai para Aprovações, com o código do app. Antes de pedir, o Liame confere os pedidos do bairro, os bairros para comparar e as campanhas que mostram anúncio nele.</span>
              </p>
              <p className="rg-nota">
                <Icone nome="clock" pequeno />
                <span>Por enquanto, aprovar só deixa o teste pronto: tirar o bairro dos anúncios entra numa próxima etapa do Liame. Até lá, nada muda na Meta.</span>
              </p>
            </>
          )}
        </div>
        <div className="dialogo-acoes">
          {fase.tipo === 'criado' ? (
            <>
              <button className="btn" type="button" onClick={fechar}>
                Fechar
              </button>
              {fase.t.action_id && (
                <Link className="btn btn--primary" href={`/aprovacoes?pedido=${fase.t.action_id}`}>
                  Ver em Aprovações
                </Link>
              )}
            </>
          ) : fase.tipo === 'nao-da' ? (
            <button className="btn" type="button" onClick={fechar}>
              Fechar
            </button>
          ) : (
            <>
              <button className="btn" type="button" onClick={fechar} disabled={enviando}>
                Cancelar
              </button>
              <button
                className="btn btn--primary"
                type="button"
                onClick={() => {
                  if (!enviando) disparar(pedir());
                }}
                aria-disabled={enviando || undefined}
              >
                {enviando ? 'Pedindo…' : 'Pedir o teste'}
              </button>
            </>
          )}
        </div>
      </div>
    </dialog>
  );
}
