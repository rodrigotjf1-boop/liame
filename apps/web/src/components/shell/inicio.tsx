'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { useModo } from '@/lib/modo';
import { useSessao } from '@/lib/sessao';
import { itensVisiveis, NAVEGACAO } from './navegacao';

// A página inicial do app logado (protótipo geral aprovado e P8): o Resumo no Lite, a Atenção no Pro. Quem não
// vê as vendas nem as campanhas vai para a primeira tela do menu que pode ver; sem empresa, para a conta.

export function destinoInicial(modo: 'lite' | 'pro', pode: (permissao: string) => boolean, temEmpresa: boolean): string {
  if (!temEmpresa) return '/seguranca';
  const itens = NAVEGACAO.filter((g) => !g.pessoal).flatMap((g) => itensVisiveis(g, pode, modo));
  return itens[0]?.href ?? '/seguranca';
}

export function Inicio() {
  const { empresa, pode } = useSessao();
  const { modo } = useModo();
  const router = useRouter();
  const destino = destinoInicial(modo, pode, Boolean(empresa));

  useEffect(() => {
    router.replace(destino);
  }, [destino, router]);

  return (
    <p className="sr-only" role="status">
      Abrindo o Liame…
    </p>
  );
}
