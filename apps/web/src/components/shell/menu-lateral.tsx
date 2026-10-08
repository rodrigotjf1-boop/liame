'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useId, useState } from 'react';
import { ID_DO_PAINEL, useConversa } from '@/components/conversa/contexto';
import { LogoCompleto, Simbolo } from '@/components/marca/logo';
import { Icone } from '@/components/ui/icone';
import { iniciais } from '@/lib/formato';
import { NIVEIS } from '@/lib/niveis';
import { useSessao } from '@/lib/sessao';
import { pendentesFalados } from '@/components/aprovacoes/textos';
import { avisosFalados } from '@/components/atencao/textos';
import { pecasFaladas } from '@/components/criativos/textos';
import { contadorDoResumo, pontosFalados } from '@/components/resumo/textos';
import { useContadorAprovacoes } from '@/lib/contador-aprovacoes';
import { useContadorAtencao } from '@/lib/contador-atencao';
import { useContadorCriativos } from '@/lib/contador-criativos';
import { useModo } from '@/lib/modo';
import { BotaoTema } from './botao-tema';
import { emFerramenta, type GrupoNav, itemAtual, itensVisiveis, NAVEGACAO } from './navegacao';
import { SeletorEmpresa } from './seletor-empresa';
import { SeletorModo } from './seletor-modo';
import { disparar } from '@/lib/disparar';

export function MenuLateral({ id, aoFechar, modos, inerte = false }: { id: string; aoFechar: () => void; modos: boolean; /** O painel da conversa está por cima da tela. */ inerte?: boolean }) {
  const { me, empresa, pode, sair } = useSessao();
  const conversa = useConversa();
  const contador = useContadorAtencao();
  const aprovacoes = useContadorAprovacoes();
  const criativos = useContadorCriativos();
  const caminho = usePathname();
  const { modo } = useModo();
  const idFerramentas = useId();
  // "Mais ferramentas" começa aberto quando a tela aberta é uma ferramenta (protótipo P3).
  const [ferramentasAbertas, setFerramentasAbertas] = useState(() => emFerramenta(caminho));
  const principais = NAVEGACAO.filter((g) => !g.ferramenta && !g.pessoal);
  const ferramentas = NAVEGACAO.filter((g) => g.ferramenta && itensVisiveis(g, pode).length);
  const pessoais = NAVEGACAO.filter((g) => g.pessoal);
  const nFerramentas = ferramentas.reduce((n, g) => n + itensVisiveis(g, pode).length, 0);
  const lite = modo === 'lite';

  // "Conversa" não é uma tela: abre o painel da LIA, que fica ao lado (ou por cima) de qualquer tela (protótipo P5).
  const itemConversa = conversa.disponivel ? (
    <li key="conversa">
      <button
        className="nav-item"
        type="button"
        aria-controls={ID_DO_PAINEL}
        aria-expanded={conversa.aberta}
        title="Conversa com a LIA (Ctrl J)"
        onClick={() => {
          aoFechar();
          conversa.abrir();
        }}
      >
        <Icone nome="message" />
        <span className="rot">Conversa</span>
        <span className="atalho-mini" aria-hidden="true">
          Ctrl J
        </span>
      </button>
    </li>
  ) : null;

  const grupoNav = (grupo: GrupoNav) => {
    const itens = itensVisiveis(grupo, pode, modo);
    if (!itens.length) return null;
    return (
      <div className="nav-grupo" key={grupo.id}>
        <p className="nav-grupo-rot rotulo-marca" id={`g-${grupo.id}`}>
          {grupo.rotulo}
        </p>
        <ul className="nav-lista" aria-labelledby={`g-${grupo.id}`}>
          {itens.map((item, posicao) => {
            const atual = itemAtual(caminho, item.href);
            const n =
              item.contador === 'atencao'
                ? (contador.total ?? 0)
                : item.contador === 'aprovacoes'
                  ? (aprovacoes.total ?? 0)
                  : item.contador === 'criativos'
                    ? (criativos.total ?? 0)
                    : item.contador === 'resumo'
                      ? contadorDoResumo(contador.total, aprovacoes.total, criativos.total)
                      : 0;
            const falado = n
              ? item.contador === 'aprovacoes'
                ? pendentesFalados(n)
                : item.contador === 'criativos'
                  ? pecasFaladas(n)
                  : item.contador === 'resumo'
                    ? pontosFalados(n)
                    : avisosFalados(n)
              : '';
            const link = (
              <li key={item.href}>
                <Link
                  className="nav-item"
                  href={item.href}
                  aria-current={atual ? 'page' : undefined}
                  title={`${item.rotulo}${falado}`}
                  onClick={aoFechar}
                >
                  {atual && <span className="nav-no" aria-hidden="true" />}
                  <Icone nome={item.icone} />
                  <span className="rot">{item.rotulo}</span>
                  {n > 0 && (
                    <>
                      <span className="sr-only">{falado}</span>
                      <span className="nav-cont num" aria-hidden="true">
                        {n > 99 ? '99+' : n}
                      </span>
                    </>
                  )}
                </Link>
              </li>
            );
            // A Conversa vem logo depois da página inicial (Resumo ou Atenção), como no protótipo.
            return grupo.id === 'agencia' && posicao === 0 && itemConversa ? [link, itemConversa] : link;
          })}
        </ul>
      </div>
    );
  };

  return (
    <aside className="sidebar" id={id} aria-label="Menu" inert={inerte}>
      <div className="sb-logo">
        <LogoCompleto />
        <Simbolo />
        <button className="btn btn--ghost btn--icon sb-fechar" type="button" onClick={aoFechar} aria-label="Fechar menu">
          <Icone nome="x" />
        </button>
      </div>

      <SeletorEmpresa />

      <nav aria-label="Principal">
        {principais.map(grupoNav)}
        {nFerramentas > 0 && lite && (
          <button
            className="nav-item nav-mais"
            type="button"
            aria-expanded={ferramentasAbertas}
            aria-controls={idFerramentas}
            title="Mais ferramentas"
            onClick={() => setFerramentasAbertas((a) => !a)}
          >
            <Icone nome="chevron-down" />
            <span className="rot">Mais ferramentas</span>
            <span className="nav-mais-n" aria-hidden="true">
              {nFerramentas}
            </span>
            <span className="sr-only">{`, ${nFerramentas} ${nFerramentas === 1 ? 'ferramenta' : 'ferramentas'}`}</span>
          </button>
        )}
        {nFerramentas > 0 && (
          <div id={idFerramentas} hidden={lite && !ferramentasAbertas}>
            {ferramentas.map(grupoNav)}
          </div>
        )}
        {pessoais.map(grupoNav)}
      </nav>

      <div className="sb-rodape">
        {/* No celular, o seletor Lite/Pro do topo desce para a gaveta (protótipo aprovado). */}
        {modos && <SeletorModo />}
        <div className="usuario">
          <span className="av-user" aria-hidden="true">
            {iniciais(me.user.name)}
          </span>
          <span className="usuario-txt">
            <b>{me.user.name}</b>
            <span>{empresa ? `${NIVEIS[empresa.role].nome} · ${empresa.name}` : me.user.email}</span>
          </span>
          <BotaoTema />
          <button className="btn btn--ghost btn--icon" type="button" onClick={() => disparar(sair())} aria-label="Sair" title="Sair">
            <Icone nome="log-out" />
          </button>
        </div>
      </div>
    </aside>
  );
}
