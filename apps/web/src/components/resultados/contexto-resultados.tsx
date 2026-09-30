import { Icone } from '@/components/ui/icone';
import type { Fonte, LinhaDeContexto } from './textos';

// Linha de contexto do protótipo: período (dias completos), loja, fusos e, no Lite, quando cada fonte
// foi lida; no Pro, o modelo de atribuição (as fontes ganham um cartão próprio).

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

export function ContextoResultados({ contexto, fontes, pro }: { contexto: LinhaDeContexto; fontes: Fonte[]; pro: boolean }) {
  return (
    <div className="res-contexto">
      <p className="res-periodo">
        <Icone nome="calendar" pequeno />
        <span>
          <b>{contexto.datas}</b>
          {contexto.complemento ? ` · ${contexto.complemento}` : ''}
        </span>
      </p>
      {pro ? (
        <p>
          <span className="lite-chip">{contexto.modelo}</span>
        </p>
      ) : (
        <ul className="frescor-lista" aria-label="Quando cada fonte foi lida">
          {fontes.map((f) => (
            <li key={f.id} className={f.situacao === 'atraso' || f.situacao === 'problema' ? 'lite-chip lite-chip--atraso' : 'lite-chip'}>
              <span className={classeDoPonto(f)} aria-hidden="true" />
              {f.chip}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
