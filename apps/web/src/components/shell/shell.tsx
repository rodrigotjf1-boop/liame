'use client';

import { usePathname } from 'next/navigation';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { Simbolo } from '@/components/marca/logo';
import { AvisosProvider } from '@/components/ui/avisos';
import { Estado } from '@/components/ui/estado';
import { Icone } from '@/components/ui/icone';
import { ContadorAprovacoesProvider } from '@/lib/contador-aprovacoes';
import { ContadorAtencaoProvider } from '@/lib/contador-atencao';
import { ModoProvider } from '@/lib/modo';
import { useSessao } from '@/lib/sessao';
import { MenuLateral } from './menu-lateral';
import { rotaPessoal, temModos, tituloDa } from './navegacao';
import { SeletorModo } from './seletor-modo';

// Shell do app logado (protótipo aprovado §3): menu lateral, trilho no tablet e gaveta no celular.
// O conteúdo rola; o shell não.

export function Shell({ children }: { children: ReactNode }) {
  const { me, empresa, pode } = useSessao();
  const caminho = usePathname();
  const [gaveta, setGaveta] = useState(false);
  const botaoMenu = useRef<HTMLButtonElement>(null);
  const titulo = tituloDa(caminho);
  // Telas da própria pessoa (Segurança da conta) valem para todas as empresas: abrem sem empresa ativa
  // e a trilha começa pelo nome dela, como no protótipo.
  const pessoal = rotaPessoal(caminho);
  const pai = pessoal ? me.user.name : (empresa?.name ?? null);
  // Lite/Pro só nas telas que têm as duas visões (Resultados, por ora) e que a pessoa pode ver.
  const modos = Boolean(empresa) && temModos(caminho, pode);

  const abriu = useRef(false);
  const fecharGaveta = useCallback(() => setGaveta(false), []);

  // Foco depois do commit (sem requestAnimationFrame, que não roda em aba de fundo): ao abrir, na tela
  // atual do menu; ao fechar, de volta no botão que abriu.
  useEffect(() => {
    if (!gaveta) {
      if (abriu.current) botaoMenu.current?.focus();
      abriu.current = false;
      return;
    }
    abriu.current = true;
    const focar = () => {
      const menu = document.getElementById('menu-lateral');
      if (menu?.contains(document.activeElement)) return;
      (menu?.querySelector<HTMLElement>('.nav-item[aria-current="page"]') ?? menu?.querySelector<HTMLElement>('.sb-fechar'))?.focus();
    };
    focar();
    // Rede de segurança: se o menu ainda estava entrando (transição), tenta de novo quando ela acaba.
    const depois = setTimeout(focar, 400);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setGaveta(false);
    document.addEventListener('keydown', esc);
    return () => {
      clearTimeout(depois);
      document.removeEventListener('keydown', esc);
    };
  }, [gaveta]);

  useEffect(() => {
    document.title = `${titulo} · Liame`;
  }, [titulo]);

  return (
    <AvisosProvider>
      <ContadorAtencaoProvider>
        <ContadorAprovacoesProvider>
        <ModoProvider>
          <a className="skip-link" href="#conteudo">
            Pular para o conteúdo
          </a>
          <div className={`app${gaveta ? ' gaveta' : ''}`}>
            <MenuLateral id="menu-lateral" aoFechar={fecharGaveta} modos={modos} />
            {gaveta && <div className="veu" onClick={fecharGaveta} aria-hidden="true" />}
            <div className="principal" inert={gaveta}>
              <header className="topbar">
                <button
                  ref={botaoMenu}
                  className="btn btn--ghost btn--icon tb-menu"
                  type="button"
                  onClick={() => setGaveta(true)}
                  aria-controls="menu-lateral"
                  aria-expanded={gaveta}
                  aria-label="Abrir menu"
                >
                  <Icone nome="menu" />
                </button>
                <Simbolo className="tb-logo" rotulo={false} />
                <div className="trilha">
                  {pai && <span className="trilha-pai">{pai}</span>}
                  {pai && (
                    <span className="trilha-sep" aria-hidden="true">
                      /
                    </span>
                  )}
                  <strong>{titulo}</strong>
                </div>
                <div className="spacer" />
                {modos && <SeletorModo className="modo-top" />}
              </header>
              <main id="conteudo" className="conteudo" tabIndex={-1}>
                <div className="pagina">
                  {empresa || pessoal ? (
                    children
                  ) : (
                    <Estado icone="lock" titulo="Você ainda não tem acesso a uma empresa">
                      Quando alguém convidar você, o convite chega por e-mail e a empresa aparece aqui.
                    </Estado>
                  )}
                </div>
              </main>
            </div>
          </div>
        </ModoProvider>
        </ContadorAprovacoesProvider>
      </ContadorAtencaoProvider>
    </AvisosProvider>
  );
}
