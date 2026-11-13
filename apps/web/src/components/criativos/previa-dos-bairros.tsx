import type { NewCampaignDistrict } from '@liame/contracts';

// A prévia em escala dos bairros (R6, parte 3; D-RG-56; revisão R6-3 da P42), sem mapa de fundo, como os anéis de Minha
// marca › Região (D-RG-15): a loja no centro, o círculo do Liame no centro de cada bairro e o bairro da Meta (a divisa é a
// dela; aqui, aproximada por um círculo). As medidas são em km, a partir da loja (leste e norte).

type ComCentro = NewCampaignDistrict & { x_km: number; y_km: number; radius_km: number };

export function PreviaDosBairros({ bairros, loja, id }: { bairros: NewCampaignDistrict[]; loja: string; id: string }) {
  const bs = bairros.filter((b): b is ComCentro => b.x_km !== null && b.y_km !== null && b.radius_km !== null);
  if (!bs.length) return null;
  const pad = 0.6;
  const x0 = Math.min(0, ...bs.map((b) => b.x_km - b.radius_km)) - pad;
  const x1 = Math.max(0, ...bs.map((b) => b.x_km + b.radius_km)) + pad;
  const y0 = Math.min(0, ...bs.map((b) => b.y_km - b.radius_km)) - pad;
  const y1 = Math.max(0, ...bs.map((b) => b.y_km + b.radius_km)) + pad;
  const w = x1 - x0;
  const h = y1 - y0;
  const fs = Math.max(w, h) * 0.04;
  const daMeta = bs.filter((b) => b.how === 'meta').map((b) => b.name);
  const circulos = bs.filter((b) => b.how !== 'meta').map((b) => b.name);
  const titulo =
    `Prévia em escala: a ${loja} e ${bs.length === 1 ? 'o bairro marcado' : `os ${bs.length} bairros marcados`}.` +
    (daMeta.length ? ` Pelo bairro da Meta: ${daMeta.join(', ')}.` : '') +
    (circulos.length ? ` Por um círculo no centro: ${circulos.join(', ')}.` : '');
  const rx = x0 + w * 0.05;
  const ry = y1 - h * 0.06;
  return (
    <figure className="cn-bairros-previa">
      <svg viewBox={`${x0} ${-y1} ${w} ${h}`} role="img" aria-labelledby={`${id}-t`}>
        <title id={`${id}-t`}>{titulo}</title>
        {bs.map((b) => (
          <circle key={b.code} className={b.how === 'meta' ? 'cn-c-meta' : 'cn-c-liame'} cx={b.x_km} cy={-b.y_km} r={b.radius_km} />
        ))}
        {bs.map((b) => (
          <text key={`${b.code}-n`} x={b.x_km} y={-b.y_km - b.radius_km * 0.55} fontSize={fs} textAnchor="middle">
            {b.name}
          </text>
        ))}
        <circle className="cn-c-loja" cx={0} cy={0} r={Math.max(w, h) * 0.018} />
        <line className="cn-c-regua" x1={rx} y1={-ry} x2={rx + 1} y2={-ry} />
        <text x={rx} y={-ry - fs * 0.5} fontSize={fs}>
          1 km
        </text>
      </svg>
      <figcaption>
        <span>
          <i className="cn-leg cn-leg--liame" aria-hidden="true" />
          círculo do Liame, no centro do bairro
        </span>
        <span>
          <i className="cn-leg cn-leg--meta" aria-hidden="true" />
          bairro da Meta (a divisa é a dela; aqui, aproximada)
        </span>
        <span>
          <i className="cn-leg cn-leg--loja" aria-hidden="true" />
          {loja}
        </span>
      </figcaption>
    </figure>
  );
}
