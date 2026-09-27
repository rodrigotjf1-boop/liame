'use client';

import type { ReactNode } from 'react';
import { encode } from 'uqr';
import { Icone, type NomeIcone } from '@/components/ui/icone';
import type { Problema } from '@/lib/api';

// Peças comuns das telas de entrada (protótipo aprovado): aviso, campo de senha, botão de envio e QR.

export function Aviso({
  tipo,
  titulo,
  children,
  icone,
}: {
  tipo: 'erro' | 'ok' | 'info';
  titulo: string;
  children?: ReactNode;
  icone?: NomeIcone;
}) {
  const padrao: NomeIcone = tipo === 'erro' ? 'alert' : tipo === 'ok' ? 'check' : 'shield';
  return (
    <div className={`aviso aviso--${tipo}`} role={tipo === 'erro' ? 'alert' : undefined}>
      <Icone nome={icone ?? padrao} />
      <span>
        <b>{titulo}</b>
        {children}
      </span>
    </div>
  );
}

/** Erro da API no formato do protótipo: título em negrito e o que fazer. */
export function AvisoProblema({ problema }: { problema: Problema | null }) {
  if (!problema) return null;
  return (
    <Aviso tipo="erro" titulo={problema.title}>
      {problema.detail}
    </Aviso>
  );
}

export const SENHA_MIN = 15;

/**
 * Senha com "Mostrar" (NIST SP 800-63B-4 §3.1.1.2) e, na senha nova, o contador dos 15 caracteres.
 * Colar e o gerenciador de senhas funcionam (WCAG 2.2 SC 3.3.8): nada de bloquear.
 */
export function CampoSenha({
  id,
  rotulo,
  nova = false,
  valor,
  aoMudar,
  aoFocar,
  erro,
  invalido = false,
  extraCab,
  mostrar,
  aoMostrar,
}: {
  id: string;
  rotulo: string;
  nova?: boolean;
  valor: string;
  aoMudar: (v: string) => void;
  aoFocar?: () => void;
  erro?: string;
  /** Marca o campo como inválido quando o erro já aparece no aviso do topo. */
  invalido?: boolean;
  extraCab?: ReactNode;
  mostrar: boolean;
  aoMostrar: () => void;
}) {
  const descricao = [nova ? `${id}-dica` : '', erro ? `${id}-erro` : ''].filter(Boolean).join(' ') || undefined;
  return (
    <div className="campo">
      <div className="campo-cab">
        <label htmlFor={id}>{rotulo}</label>
        {nova ? (
          <span className={`contador${valor.length >= SENHA_MIN ? ' ok' : ''}`} aria-hidden="true">
            {valor.length}/{SENHA_MIN}
          </span>
        ) : (
          extraCab
        )}
      </div>
      <div className="input-senha">
        <input
          className="input"
          id={id}
          type={mostrar ? 'text' : 'password'}
          autoComplete={nova ? 'new-password' : 'current-password'}
          required
          minLength={nova ? SENHA_MIN : undefined}
          value={valor}
          onChange={(e) => aoMudar(e.target.value)}
          onFocus={aoFocar}
          aria-invalid={erro || invalido ? true : undefined}
          aria-describedby={descricao}
        />
        <button className="mostrar" type="button" aria-pressed={mostrar} aria-controls={id} onClick={aoMostrar}>
          {mostrar ? 'Esconder' : 'Mostrar'}
        </button>
      </div>
      {nova && (
        <span className="campo-dica" id={`${id}-dica`}>
          {SENHA_MIN} caracteres ou mais. Uma frase funciona bem, sem regra de símbolo ou número.
        </span>
      )}
      {erro && (
        <span className="campo-erro" id={`${id}-erro`}>
          {erro}
        </span>
      )}
    </div>
  );
}

export function BotaoEnviar({ enviando, children }: { enviando: boolean; children: ReactNode }) {
  return (
    <button className="btn btn--primary btn--largo" type="submit" disabled={enviando} aria-busy={enviando}>
      {enviando ? (
        <>
          <span className="girando" aria-hidden="true" /> Aguarde
        </>
      ) : (
        children
      )}
    </button>
  );
}

/** QR do app autenticador, desenhado em SVG a partir da matriz (sem innerHTML). */
export function QrCode({ texto, rotulo }: { texto: string; rotulo: string }) {
  const { data, size } = encode(texto, { ecc: 'M', border: 2 });
  let caminho = '';
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (data[y]?.[x]) caminho += `M${x} ${y}h1v1h-1z`;
  return (
    <svg className="qr" viewBox={`0 0 ${size} ${size}`} role="img" aria-label={rotulo} shapeRendering="crispEdges">
      <rect width={size} height={size} fill="#FFFFFF" />
      <path d={caminho} fill="#0B0D17" />
    </svg>
  );
}
