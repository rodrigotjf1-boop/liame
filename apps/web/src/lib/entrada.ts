'use client';

import type { LegalTermsResponse, MeResponse } from '@liame/contracts';
import { useEffect, useState } from 'react';
import { api, chamar, type Problema } from './api';
import { disparar } from './disparar';

// Regras das telas de entrada: para onde voltar depois de entrar e os termos vigentes.

/**
 * Só caminhos do próprio app ("/pessoas", "/convite?token=..."): nada de endereço de fora nem
 * "//outro-site" (redirecionamento aberto).
 */
export function voltaSegura(volta: string | null | undefined): string {
  if (!volta || !volta.startsWith('/') || volta.startsWith('//') || volta.includes('\\')) return '/';
  return volta;
}

/** Depois de entrar (ou de criar o login pelo convite): o segundo fator vem antes de qualquer tela (ADR-013). */
export function destinoDepoisDeEntrar(me: MeResponse, volta: string): string {
  if (me.mfa === 'required') return `/segundo-fator?volta=${encodeURIComponent(volta)}`;
  if (me.mfa_enrollment_required) return `/segundo-fator/ativar?volta=${encodeURIComponent(volta)}`;
  return volta;
}

let termosEmCache: Promise<Awaited<ReturnType<typeof buscarTermos>>> | null = null;
function buscarTermos() {
  return chamar(() => api.GET('/v1/legal/terms'));
}

/** Termos vigentes (versão e links), buscados uma vez por página. */
export function useTermos(): { termos: LegalTermsResponse | null; problema: Problema | null; recarregar: () => void } {
  const [estado, setEstado] = useState<{ termos: LegalTermsResponse | null; problema: Problema | null }>({ termos: null, problema: null });
  const [versao, setVersao] = useState(0);
  useEffect(() => {
    let viva = true;
    termosEmCache ??= buscarTermos();
    disparar(
      termosEmCache.then((r) => {
        if (!viva) return;
        if (r.ok) setEstado({ termos: r.data, problema: null });
        else {
          termosEmCache = null;
          setEstado({ termos: null, problema: r.problema });
        }
      }),
    );
    return () => {
      viva = false;
    };
  }, [versao]);
  return {
    ...estado,
    recarregar: () => {
      termosEmCache = null;
      setVersao((v) => v + 1);
    },
  };
}
