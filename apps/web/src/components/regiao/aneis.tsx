import { km } from './textos';

// A prévia do raio em escala, sem mapa de fundo (protótipo P40, D-RG-15): o núcleo até 2 km e a expansão até o raio
// de entrega, com o ponto da loja no centro (vazado quando o ponto é o centro do bairro) e a régua de escala.

const NUCLEO_KM = 2;

export function Aneis({ raio, noBairro, id }: { raio: number; noBairro: boolean; id: string }) {
  const R = raio + 0.5;
  const nucleo = Math.min(NUCLEO_KM, raio);
  const fs = R * 0.085;
  const escala = R >= 7 ? 5 : 1;
  const x0 = -R + R * 0.06;
  const y0 = R - R * 0.07;
  const titulo =
    (raio > NUCLEO_KM ? `Prévia em escala: núcleo até 2 km e expansão de 2 a ${km(raio)} em volta da loja` : `Prévia em escala: núcleo até ${km(raio)} em volta da loja`) +
    (noBairro ? ', com o ponto no centro do bairro.' : '.');
  return (
    <svg className="rg-aneis" viewBox={`${-R} ${-R} ${2 * R} ${2 * R}`} role="img" aria-labelledby={`${id}-t`}>
      <title id={`${id}-t`}>{titulo}</title>
      {raio > NUCLEO_KM && <circle className="rg-anel-exp" r={raio} />}
      <circle className="rg-anel-nucleo" r={nucleo} />
      <circle className={noBairro ? 'rg-anel-centro rg-anel-centro--bairro' : 'rg-anel-centro'} r={R * 0.04} />
      <line className="rg-anel-escala" x1={x0} y1={y0} x2={x0 + escala} y2={y0} />
      <text x={x0} y={y0 - R * 0.035} fontSize={fs}>
        {escala} km
      </text>
    </svg>
  );
}

export function LegendaDosAneis({ raio }: { raio: number }) {
  return (
    <ul className="rg-legenda">
      <li>
        <i className="rg-lg-nucleo" aria-hidden="true" />
        <span>
          <b>Núcleo · até {km(Math.min(NUCLEO_KM, raio))}</b> · perto da loja, entrega mais rápida
        </span>
      </li>
      {raio > NUCLEO_KM && (
        <li>
          <i className="rg-lg-exp" aria-hidden="true" />
          <span>
            <b>Expansão · de 2 a {km(raio)}</b> · mais longe, até o raio de entrega
          </span>
        </li>
      )}
    </ul>
  );
}

/** A atribuição do OpenStreetMap, onde aparece a coordenada ou o desenho (licença ODbL). */
export function Osm() {
  return (
    <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">
      OpenStreetMap
    </a>
  );
}
