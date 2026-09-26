'use client';

import type { MeResponse } from '@liame/contracts';
import { usePathname, useRouter } from 'next/navigation';
import { createContext, Fragment, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { Estado } from '@/components/ui/estado';
import { Icone } from '@/components/ui/icone';
import { api, chamar, mensagemDe, type Problema } from './api';
import { disparar } from '@/lib/disparar';

// Sessão no navegador: quem está usando, a empresa ativa e o que a pessoa pode fazer nela.
// As permissões só escondem botões; quem nega é o servidor (RBAC no servidor, ADR-013).

/** Telas de entrada (fora do shell). */
export const ROTAS = { entrar: '/entrar', segundoFator: '/segundo-fator', ativarApp: '/segundo-fator/ativar' } as const;

export type Empresa = MeResponse['organizations'][number];

type Sessao = {
  me: MeResponse;
  empresa: Empresa | null;
  pode: (permissao: string) => boolean;
  trocarEmpresa: (id: string) => Promise<Problema | null>;
  sair: () => Promise<void>;
};

const SessaoContexto = createContext<Sessao | null>(null);

export function useSessao(): Sessao {
  const s = useContext(SessaoContexto);
  if (!s) throw new Error('useSessao fora do SessaoProvider');
  return s;
}

type Estado = { tipo: 'carregando' } | { tipo: 'ok'; me: MeResponse } | { tipo: 'erro'; problema: Problema };

export function SessaoProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const caminho = usePathname();
  const [estado, setEstado] = useState<Estado>({ tipo: 'carregando' });

  const irPara = useCallback(
    (rota: string) => router.replace(`${rota}?volta=${encodeURIComponent(caminho)}`),
    [router, caminho],
  );

  const aplicar = useCallback(
    (me: MeResponse) => {
      // O segundo fator vem antes de qualquer tela (ADR-013).
      if (me.mfa === 'required') return irPara(ROTAS.segundoFator);
      if (me.mfa_enrollment_required) return irPara(ROTAS.ativarApp);
      setEstado({ tipo: 'ok', me });
    },
    [irPara],
  );

  const carregar = useCallback(async () => {
    setEstado({ tipo: 'carregando' });
    const r = await chamar(() => api.GET('/v1/me'));
    if (r.ok) return aplicar(r.data);
    if (r.problema.status === 401) return irPara(ROTAS.entrar);
    setEstado({ tipo: 'erro', problema: r.problema });
  }, [aplicar, irPara]);

  useEffect(() => {
    disparar(carregar());
  }, [carregar]);

  const trocarEmpresa = useCallback(
    async (id: string) => {
      const r = await chamar(() => api.PUT('/v1/me/active-organization', { body: { organization_id: id } }));
      if (!r.ok) return r.problema;
      aplicar(r.data);
      return null;
    },
    [aplicar],
  );

  const sair = useCallback(async () => {
    await chamar(() => api.POST('/v1/auth/logout'));
    router.replace(ROTAS.entrar);
  }, [router]);

  const valor = useMemo<Sessao | null>(() => {
    if (estado.tipo !== 'ok') return null;
    const { me } = estado;
    const permissoes = new Set(me.permissions);
    return {
      me,
      empresa: me.organizations.find((o) => o.id === me.active_organization_id) ?? null,
      pode: (p) => permissoes.has(p),
      trocarEmpresa,
      sair,
    };
  }, [estado, trocarEmpresa, sair]);

  if (estado.tipo === 'carregando') {
    return (
      <div className="tela-cheia" aria-busy="true">
        <p className="rotulo-marca">Abrindo o Liame…</p>
      </div>
    );
  }
  if (estado.tipo === 'erro' || !valor) {
    const problema = estado.tipo === 'erro' ? estado.problema : null;
    return (
      <div className="tela-cheia">
        <Estado
          icone="alert"
          perigo
          titulo="Não deu para abrir a sua conta"
          acao={
            <button className="btn btn--primary" type="button" onClick={() => disparar(carregar())}>
              <Icone nome="refresh" />
              Tentar de novo
            </button>
          }
        >
          {problema ? mensagemDe(problema) : 'Tente de novo em instantes.'}
        </Estado>
      </div>
    );
  }
  return (
    <SessaoContexto.Provider value={valor}>
      {/* Trocar de empresa remonta as telas: cada uma recarrega os dados da empresa nova. */}
      <Fragment key={valor.me.active_organization_id ?? 'sem-empresa'}>{children}</Fragment>
    </SessaoContexto.Provider>
  );
}
