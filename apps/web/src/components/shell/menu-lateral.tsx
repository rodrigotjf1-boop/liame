'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { LogoCompleto, Simbolo } from '@/components/marca/logo';
import { Icone } from '@/components/ui/icone';
import { iniciais } from '@/lib/formato';
import { NIVEIS } from '@/lib/niveis';
import { useSessao } from '@/lib/sessao';
import { avisosFalados } from '@/components/atencao/textos';
import { useContadorAtencao } from '@/lib/contador-atencao';
import { BotaoTema } from './botao-tema';
import { itemAtual, NAVEGACAO } from './navegacao';
import { SeletorEmpresa } from './seletor-empresa';
import { disparar } from '@/lib/disparar';

export function MenuLateral({ id, aoFechar }: { id: string; aoFechar: () => void }) {
  const { me, empresa, pode, sair } = useSessao();
  const contador = useContadorAtencao();
  const caminho = usePathname();

  return (
    <aside className="sidebar" id={id} aria-label="Menu">
      <div className="sb-logo">
        <LogoCompleto />
        <Simbolo />
        <button className="btn btn--ghost btn--icon sb-fechar" type="button" onClick={aoFechar} aria-label="Fechar menu">
          <Icone nome="x" />
        </button>
      </div>

      <SeletorEmpresa />

      <nav aria-label="Principal">
        {NAVEGACAO.map((grupo) => {
          const itens = grupo.itens.filter((i) => !i.permissao || pode(i.permissao));
          if (!itens.length) return null;
          return (
            <div className="nav-grupo" key={grupo.id}>
              <p className="nav-grupo-rot rotulo-marca" id={`g-${grupo.id}`}>
                {grupo.rotulo}
              </p>
              <ul className="nav-lista" aria-labelledby={`g-${grupo.id}`}>
                {itens.map((item) => {
                  const atual = itemAtual(caminho, item.href);
                  const n = item.contador === 'atencao' ? (contador.total ?? 0) : 0;
                  return (
                    <li key={item.href}>
                      <Link
                        className="nav-item"
                        href={item.href}
                        aria-current={atual ? 'page' : undefined}
                        title={n ? `${item.rotulo}${avisosFalados(n)}` : item.rotulo}
                        onClick={aoFechar}
                      >
                        {atual && <span className="nav-no" aria-hidden="true" />}
                        <Icone nome={item.icone} />
                        <span className="rot">{item.rotulo}</span>
                        {n > 0 && (
                          <>
                            <span className="sr-only">{avisosFalados(n)}</span>
                            <span className="nav-cont num" aria-hidden="true">
                              {n > 99 ? '99+' : n}
                            </span>
                          </>
                        )}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </nav>

      <div className="sb-rodape">
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
