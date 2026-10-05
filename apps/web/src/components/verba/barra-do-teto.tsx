import type { BarraDaVerba } from './textos';

// A barra do teto do mês (protótipo P9): o gasto até ontem, a previsão até o fim do mês e o que sobra do teto. É um
// desenho só: quem lê a tela ouve a frase com as duas porcentagens; a legenda embaixo é para quem vê.

export function BarraDoTeto({ barra }: { barra: BarraDaVerba }) {
  return (
    <>
      <div
        className={barra.acima ? 'verba-barra verba-barra--acima' : 'verba-barra'}
        role="img"
        aria-label={barra.rotulo}
        style={{ ['--gasto' as string]: barra.gasto, ['--previsto' as string]: barra.previsto }}
      >
        <i className="gasto" />
        <i className="previsto" />
      </div>
      <div className="verba-legenda" aria-hidden="true">
        <span>
          <i />
          Gasto até ontem
        </span>
        <span>
          <i className="lg-previsto" />
          {barra.legendaPrevisto}
        </span>
        <span>
          <i className="lg-teto" />
          Teto do mês
        </span>
      </div>
    </>
  );
}
