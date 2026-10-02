// Logo e símbolo do Liame (kit da marca, o mesmo desenho do protótipo aprovado). As cores vêm dos tokens,
// então o logo acompanha o tema claro e o escuro.

export function LogoCompleto() {
  return (
    <svg className="logo-completo" viewBox="0 0 758.18 309" role="img" aria-label="Liame">
      <g transform="translate(24 24)">
        <path d="M17.5 84V211.5H84" fill="none" strokeWidth="27" style={{ stroke: 'var(--logo-ink)' }} />
        <circle cx="106.14" cy="211.5" r="14.04" style={{ fill: 'var(--marca-ciano)' }} />
        <path d="M233 702V0H62V702Z" transform="translate(140.88 225) scale(0.2 -0.2)" style={{ fill: 'var(--marca-violeta)' }} />
        <path
          d="M163.18 12H201.58Q212.38 12 212.38 22.8V49.2Q212.38 60 201.58 60H177.58L164.38 76.8V60H163.18Q152.38 60 152.38 49.2V22.8Q152.38 12 163.18 12Z"
          style={{ fill: 'var(--marca-ciano)' }}
        />
        <path
          d="M499 124H237L195 0H16L270 702H468L722 0H541ZM455 256 368 513 282 256Z"
          transform="translate(203.48 225) scale(0.2 -0.2)"
          style={{ fill: 'var(--marca-violeta)' }}
        />
        <clipPath id="liame-mc">
          <rect x="207.98" y="-57" width="480" height="282" />
        </clipPath>
        <g clipPath="url(#liame-mc)" fill="none" strokeWidth="31.86" strokeLinecap="round" strokeLinejoin="round">
          <path d="M512.05 99.93V256.86" style={{ stroke: 'var(--marca-petroleo)' }} />
          <path d="M447.98 182.7L512.05 99.93" style={{ stroke: 'var(--marca-ciano)' }} />
          <path d="M383.91 99.93L447.98 182.7" style={{ stroke: 'var(--marca-lavanda-clara)' }} />
          <path d="M383.91 256.86V99.93" style={{ stroke: 'var(--marca-lavanda)' }} />
        </g>
        <polygon
          points="531.8,46.4 536.3,57.1 547.9,58 539,65.6 541.7,77 531.8,70.9 521.8,77 524.5,65.6 515.7,58 527.3,57.1"
          strokeWidth="3.05"
          strokeLinejoin="round"
          style={{ fill: 'var(--marca-ambar)', stroke: 'var(--marca-ambar)' }}
        />
        <g transform="translate(447.98 202.44) scale(1.128)">
          <path d="M0 15C-20 2-20-13-9-13C-4-13-1-9 0-7C1-9 4-13 9-13C20-13 20 2 0 15Z" style={{ fill: 'var(--marca-coral)' }} />
        </g>
        <g transform="translate(386.73 80.19) scale(1.128)">
          <path
            fillRule="evenodd"
            d="M0 24C-12 10-17 2-17-7A17 17 0 1 1 17-7C17 2 12 10 0 24ZM0-13.5A6.5 6.5 0 1 0 0-.5A6.5 6.5 0 1 0 0-13.5Z"
            style={{ fill: 'var(--logo-pin)' }}
          />
        </g>
        <path d="M233 565V423H462V291H233V137H492V0H62V702H492V565Z" transform="translate(539.68 225) scale(0.2 -0.2)" style={{ fill: 'var(--logo-ink)' }} />
        <rect x="654.18" y="143.5" width="52" height="22" style={{ fill: 'var(--marca-ciano)' }} />
        <rect x="4" y="245" width="702.18" height="8" rx="4" style={{ fill: 'var(--marca-ciano)' }} />
      </g>
    </svg>
  );
}

export function Simbolo({ className = 'logo-simbolo', rotulo = true }: { className?: string; rotulo?: boolean }) {
  return (
    <svg className={className} viewBox="0 0 512 512" {...(rotulo ? { role: 'img', 'aria-label': 'Liame' } : { 'aria-hidden': true })}>
      <g transform="translate(122.16 61.31)">
        <path d="M31.1 0V293.76H184.32" fill="none" strokeWidth="62.2" style={{ stroke: 'var(--logo-ink)' }} />
        <circle cx="235.33" cy="293.76" r="32.35" style={{ fill: 'var(--marca-ciano)' }} />
        <rect x="0" y="366.34" width="267.68" height="20.74" rx="10.37" style={{ fill: 'var(--marca-ciano)' }} />
      </g>
    </svg>
  );
}

/** Ícone da LIA (kit da marca; o mesmo do protótipo P4): decorativo, quem lê a tela ouve "Explicação da LIA". */
export function IconeLia() {
  return (
    <span className="av-lia" aria-hidden="true">
      <svg viewBox="0 0 1024 1024" focusable="false">
        <rect width="1024" height="1024" rx="230" style={{ fill: 'var(--marca-violeta)' }} />
        <g transform="translate(192.61 277.1)">
          <path d="M31.5 151.2V380.7H151.2" fill="none" strokeWidth="48.6" style={{ stroke: 'var(--marca-branco)' }} />
          <circle cx="191.05" cy="380.7" r="25.27" style={{ fill: 'var(--marca-ciano)' }} />
          <path d="M233 702V0H62V702Z" transform="translate(253.58 405) scale(0.36 -0.36)" style={{ fill: 'var(--marca-branco)' }} />
          <path
            d="M293.72 21.6H362.84Q382.28 21.6 382.28 41.04V88.56Q382.28 108 362.84 108H319.64L295.88 138.24V108H293.72Q274.28 108 274.28 88.56V41.04Q274.28 21.6 293.72 21.6Z"
            style={{ fill: 'var(--marca-ciano)' }}
          />
          <path
            d="M499 124H237L195 0H16L270 702H468L722 0H541ZM455 256 368 513 282 256Z"
            transform="translate(366.26 405) scale(0.36 -0.36)"
            style={{ fill: 'var(--marca-branco)' }}
          />
          <rect x="7.2" y="441" width="624.38" height="14.4" rx="7.2" style={{ fill: 'var(--marca-ciano)' }} />
        </g>
      </svg>
    </span>
  );
}
