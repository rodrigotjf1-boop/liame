import Link from 'next/link';
import { Faixa } from '@/components/ui/faixa';
import { Icone } from '@/components/ui/icone';
import type { Aviso } from './textos';

// Faixas do topo de Resultados: Regem ou mídia não conectados, fonte atrasada ou com problema, fuso da
// conta diferente do da loja, margem incompleta, plataforma sem valor de venda e "o gasto de hoje sai
// amanhã". A ação leva a Contas conectadas, só para quem pode vê-las.

export function AvisosResultados({ avisos, podeVerContas }: { avisos: Aviso[]; podeVerContas: boolean }) {
  if (!avisos.length) return null;
  return (
    <div className="res-avisos">
      {avisos.map((a) => (
        <Faixa
          key={a.id}
          tipo={a.tipo}
          icone={<Icone nome={a.icone} />}
          titulo={a.titulo}
          texto={a.texto}
          acao={
            a.acao && podeVerContas ? (
              <Link className="btn" href="/contas">
                {a.acao.rotulo}
              </Link>
            ) : undefined
          }
        />
      ))}
    </div>
  );
}
