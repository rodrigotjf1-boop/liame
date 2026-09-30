// Halteres "plataforma × caixa" (protótipo P1, paleta validada com a skill dataviz): o ponto de contexto é o
// ROAS que a plataforma informa; o de ênfase, o confirmado no caixa. Escala de 0 a 7, com a linha do ROAS 1
// (onde a mídia se paga). O número também está em texto na mesma linha da tabela: o gráfico só complementa.

const LARGURA = 168;
const ALTURA = 28;
const MAXIMO = 7;
const x = (v: number) => (10 + (Math.min(Math.max(v, 0), MAXIMO) / MAXIMO) * (LARGURA - 20)).toFixed(1);
const numero = (v: number) => v.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

export function Halteres({ plataforma, caixa, rotulo }: { plataforma: number | null; caixa: number; rotulo: string }) {
  const y = ALTURA / 2;
  const dica = plataforma === null ? `Caixa ${numero(caixa)}` : `Plataforma ${numero(plataforma)} · Caixa ${numero(caixa)}`;
  return (
    <span className="halteres" tabIndex={0} role="img" aria-label={rotulo}>
      <svg viewBox={`0 0 ${LARGURA} ${ALTURA}`} width={LARGURA} height={ALTURA} aria-hidden="true" focusable="false">
        <line className="hl-grade" x1="10" x2={LARGURA - 10} y1={y} y2={y} strokeWidth="1" />
        <line className="hl-um" x1={x(1)} x2={x(1)} y1="5" y2={ALTURA - 5} strokeWidth="1" />
        {plataforma !== null && (
          <>
            <line className="hl-liga" x1={x(Math.min(plataforma, caixa))} x2={x(Math.max(plataforma, caixa))} y1={y} y2={y} strokeWidth="2" strokeLinecap="round" />
            <circle className="hl-plataforma" cx={x(plataforma)} cy={y} r="5" strokeWidth="2" />
          </>
        )}
        <circle className="hl-caixa" cx={x(caixa)} cy={y} r="5" strokeWidth="2" />
      </svg>
      <span className="dica-graf" aria-hidden="true">
        {dica}
      </span>
    </span>
  );
}
