'use client';

import { usePathname } from 'next/navigation';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { ConversaProvider, ID_DO_BOTAO_DA_LIA, ID_DO_PAINEL, useConversa } from '@/components/conversa/contexto';
import { PainelDaLia } from '@/components/conversa/painel';
import { IconeLia, Simbolo } from '@/components/marca/logo';
import { AvisosProvider } from '@/components/ui/avisos';
import { Estado } from '@/components/ui/estado';
import { Icone } from '@/components/ui/icone';
import { ContadorAprovacoesProvider } from '@/lib/contador-aprovacoes';
import { ContadorAtencaoProvider } from '@/lib/contador-atencao';
import { ContadorCriativosProvider } from '@/lib/contador-criativos';
import { ModoProvider } from '@/lib/modo';
import { useSessao } from '@/lib/sessao';
import { MenuLateral } from './menu-lateral';
import { rotaPessoal, temModos, tituloDa } from './navegacao';
import { SeletorModo } from './seletor-modo';

// Shell do app logado (protótipo aprovado §3): menu lateral, trilho no tablet e gaveta no celular.
// O conteúdo rola; o shell não. A Conversa com a LIA (protótipo P5) é do shell: ao lado da tela a partir de
// 1280 px; nas menores, por cima dela, com o resto inerte.

export function Shell({ children }: { children: ReactNode }) {
  const { empresa, pode } = useSessao();
  return (
    <AvisosProvider>
      <ContadorAtencaoProvider>
        <ContadorAprovacoesProvider>
          <ContadorCriativosProvider>
            <ModoProvider>
              <ConversaProvider disponivel={Boolean(empresa) && pode('conversa.usar')}>
                <Estrutura>{children}</Estrutura>
              </ConversaProvider>
            </ModoProvider>
          </ContadorCriativosProvider>
        </ContadorAprovacoesProvider>
      </ContadorAtencaoProvider>
    </AvisosProvider>
  );
}

/** A tela é larga o bastante para o painel da conversa ficar ao lado (a partir de 1280 px). */
function useLargo(): boolean {
  const [largo, setLargo] = useState(true);
  useEffect(() => {
    const m = window.matchMedia('(min-width: 1280px)');
    const acertar = () => setLargo(m.matches);
    acertar();
    m.addEventListener('change', acertar);
    return () => m.removeEventListener('change', acertar);
  }, []);
  return largo;
}

function Estrutura({ children }: { children: ReactNode }) {
  const { me, empresa, pode } = useSessao();
  const conversa = useConversa();
  const caminho = usePathname();
  const [gaveta, setGaveta] = useState(false);
  const botaoMenu = useRef<HTMLButtonElement>(null);
  const largo = useLargo();
  const titulo = tituloDa(caminho);
  // Telas da própria pessoa (Segurança da conta) valem para todas as empresas: abrem sem empresa ativa
  // e a trilha começa pelo nome dela, como no protótipo.
  const pessoal = rotaPessoal(caminho);
  const pai = pessoal ? me.user.name : (empresa?.name ?? null);
  // Lite/Pro só nas telas que têm as duas visões e que a pessoa pode ver.
  const modos = Boolean(empresa) && temModos(caminho, pode);
  // Com o painel por cima (telas menores), ele é um diálogo: o resto da tela fica inerte.
  const modal = conversa.aberta && !largo;

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

  // Ctrl J (ou ⌘ J) abre e fecha a conversa; Esc fecha quando o painel está por cima ou o foco está nele.
  const { disponivel, aberta, alternar, fechar } = conversa;
  useEffect(() => {
    if (!disponivel) return;
    const tecla = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'j') {
        e.preventDefault();
        if (document.querySelector('dialog[open]')) return;
        setGaveta(false);
        alternar();
        return;
      }
      if (e.key === 'Escape' && aberta && !gaveta && !document.querySelector('dialog[open]')) {
        const dentro = e.target instanceof Element && Boolean(e.target.closest(`#${ID_DO_PAINEL}`));
        if (!largo || dentro) {
          e.preventDefault();
          fechar();
        }
      }
    };
    document.addEventListener('keydown', tecla);
    return () => document.removeEventListener('keydown', tecla);
  }, [disponivel, aberta, alternar, fechar, gaveta, largo]);

  return (
    <>
      <a className="skip-link" href="#conteudo" inert={modal}>
        Pular para o conteúdo
      </a>
      <div className={`app${gaveta ? ' gaveta' : ''}${conversa.aberta ? ' com-lia' : ''}`}>
        <MenuLateral id="menu-lateral" aoFechar={fecharGaveta} modos={modos} inerte={modal} />
        {gaveta && <div className="veu" onClick={fecharGaveta} aria-hidden="true" />}
        <div className="principal" inert={gaveta || modal}>
          <header className="topbar">
            <button ref={botaoMenu} className="btn btn--ghost btn--icon tb-menu" type="button" onClick={() => setGaveta(true)} aria-controls="menu-lateral" aria-expanded={gaveta} aria-label="Abrir menu">
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
            {conversa.disponivel && (
              <button
                className={`btn btn-lia${conversa.temNova ? ' tem-nova' : ''}`}
                id={ID_DO_BOTAO_DA_LIA}
                type="button"
                aria-controls={ID_DO_PAINEL}
                aria-expanded={conversa.aberta}
                aria-label={conversa.temNova ? 'Conversa com a LIA, resposta nova' : 'Conversa com a LIA'}
                title="Conversa com a LIA (Ctrl J)"
                onClick={conversa.alternar}
              >
                <IconeLia />
                <span className="rot">LIA</span>
                <span className="lia-atalho" aria-hidden="true">
                  Ctrl J
                </span>
              </button>
            )}
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
        {modal && <div className="veu veu--lia" onClick={() => conversa.fechar()} aria-hidden="true" />}
        {conversa.disponivel && <PainelDaLia modal={modal} />}
      </div>
    </>
  );
}
