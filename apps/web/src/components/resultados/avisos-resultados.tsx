import { Faixa } from '@/components/ui/faixa';
import { Icone } from '@/components/ui/icone';
import type { Aviso } from './textos';

// Faixas do Pro em Resultados: fuso da conta diferente do da loja, margem incompleta, plataforma sem valor de venda e
// "o gasto de hoje sai amanhã". No modo simples, cada uma é o estado ou uma nota do cartão a que pertence.

export function AvisosResultados({ avisos }: { avisos: Aviso[] }) {
  if (!avisos.length) return null;
  return (
    <div className="res-avisos">
      {avisos.map((a) => (
        <Faixa key={a.id} tipo={a.tipo} icone={<Icone nome={a.icone} />} titulo={a.titulo} texto={a.texto} />
      ))}
    </div>
  );
}
