import { Icone } from '@/components/ui/icone';
import type { Fonte, LinhaDeContexto } from './textos';

// Linha de contexto: período (dias completos) e loja; no Pro, também os fusos e o modelo de atribuição. Quando cada
// fonte foi lida fica na faixa do topo (modo simples, em "Ver detalhes") e no cartão das fontes (Pro).

const PONTO: Record<Fonte['situacao'], string> = {
  ok: 'ponto',
  atraso: 'ponto ponto--atraso',
  problema: 'ponto ponto--atraso',
  sem_leitura: 'ponto ponto--off',
  nao_conectada: 'ponto ponto--off',
};

export function classeDoPonto(f: Fonte): string {
  return PONTO[f.situacao];
}

export function ContextoResultados({ contexto, pro }: { contexto: LinhaDeContexto; pro: boolean }) {
  const complemento = pro ? contexto.complemento : contexto.curto;
  return (
    <div className="res-contexto">
      <p className="res-periodo">
        <Icone nome="calendar" pequeno />
        <span>
          <b>{contexto.datas}</b>
          {complemento ? ` · ${complemento}` : ''}
        </span>
      </p>
      {pro && (
        <p>
          <span className="lite-chip">{contexto.modelo}</span>
        </p>
      )}
    </div>
  );
}
