'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { Icone } from '@/components/ui/icone';
import { useAvisar } from '@/components/ui/avisos';
import { mensagemDe } from '@/lib/api';
import { iniciais } from '@/lib/formato';
import { NIVEIS } from '@/lib/niveis';
import { useSessao } from '@/lib/sessao';
import { disparar } from '@/lib/disparar';

// Seletor do alto do menu: quem administra várias empresas (agência, consultor) troca entre elas aqui,
// como na conta de administrador do Google Ads. Com uma empresa só, ele apenas mostra qual é.

export function SeletorEmpresa() {
  const { me, empresa, trocarEmpresa } = useSessao();
  const avisar = useAvisar();
  const [aberto, setAberto] = useState(false);
  const caixa = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const varias = me.organizations.length > 1;

  useEffect(() => {
    if (!aberto) return;
    const fora = (e: PointerEvent) => {
      if (!caixa.current?.contains(e.target as Node)) setAberto(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setAberto(false);
        caixa.current?.querySelector<HTMLButtonElement>('.ctx')?.focus();
      }
    };
    document.addEventListener('pointerdown', fora);
    document.addEventListener('keydown', esc);
    caixa.current?.querySelector<HTMLButtonElement>('.ctx-op[aria-current="true"]')?.focus();
    return () => {
      document.removeEventListener('pointerdown', fora);
      document.removeEventListener('keydown', esc);
    };
  }, [aberto]);

  async function escolher(id: string, nome: string) {
    setAberto(false);
    if (id === empresa?.id) return;
    const problema = await trocarEmpresa(id);
    if (problema) avisar(mensagemDe(problema), { tipo: 'perigo' });
    else avisar(`Agora você está em ${nome}.`);
  }

  const nome = empresa?.name ?? 'Sem empresa';
  return (
    <div className="ctx-caixa" ref={caixa}>
      <button
        className="ctx"
        type="button"
        disabled={!varias}
        onClick={() => setAberto((a) => !a)}
        aria-expanded={varias ? aberto : undefined}
        aria-controls={varias ? menuId : undefined}
        title={varias ? `${nome} · trocar de empresa` : nome}
      >
        <span className="ctx-av" aria-hidden="true">
          {iniciais(nome)}
        </span>
        <span className="ctx-txt">
          <b>{nome}</b>
          <span>{empresa ? NIVEIS[empresa.role].nome : 'Sem acesso'}</span>
        </span>
        {varias && <Icone nome="chevron-down" pequeno />}
        {varias && <span className="sr-only">Trocar de empresa</span>}
      </button>
      {aberto && (
        <div className="ctx-menu" id={menuId} role="group" aria-label="Suas empresas">
          {me.organizations.map((o) => (
            <button
              key={o.id}
              className="ctx-op"
              type="button"
              aria-current={o.id === empresa?.id}
              onClick={() => disparar(escolher(o.id, o.name))}
            >
              <span className="ctx-av" aria-hidden="true">
                {iniciais(o.name)}
              </span>
              <span className="ctx-op-txt">
                <b>{o.name}</b>
                <span>{NIVEIS[o.role].nome}</span>
              </span>
              {o.id === empresa?.id && <Icone nome="check" pequeno />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
