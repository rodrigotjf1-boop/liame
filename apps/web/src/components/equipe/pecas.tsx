'use client';

import type { TeamMember } from '@liame/contracts';
import { type ReactNode, useEffect, useRef } from 'react';
import { IconeLia } from '@/components/marca/logo';
import { Icone, type NomeIcone } from '@/components/ui/icone';
import { type Numero, situacaoDo } from './textos';

// Peças pequenas da tela Sua equipe (protótipo P7): o avatar, o selo da situação, a confirmação na linha e o bloco de números.

/** O avatar do funcionário: o ícone da LIA ou o ícone de traço do cargo. Apagado quando ele não está trabalhando. */
export function Avatar({ icone, grande = false, apagado = false }: { icone: NomeIcone | 'lia'; grande?: boolean; apagado?: boolean }) {
  if (icone === 'lia') return <IconeLia />;
  return (
    <span className={`av-func${grande ? ' av-func--lg' : ''}${apagado ? ' av-func--off' : ''}`} aria-hidden="true">
      <Icone nome={icone} />
    </span>
  );
}

export function SeloDaSituacao({ m }: { m: TeamMember }) {
  const s = situacaoDo(m);
  return (
    <span className={s.classe}>
      {s.ponto && <span className="dot" aria-hidden="true" />}
      {s.rotulo}
    </span>
  );
}

/**
 * Confirmação na própria linha (o padrão das telas do app): o que vai acontecer, o botão que confirma e o que desiste.
 * O foco vai para o botão que confirma; quem desiste volta ao botão de origem (quem chama cuida disso).
 */
export function ConfirmaNaLinha({
  texto,
  rotulo,
  rotuloOcupado,
  ocupado,
  impedido = false,
  aoConfirmar,
  aoCancelar,
  children,
}: {
  texto: string;
  rotulo: string;
  rotuloOcupado: string;
  ocupado: boolean;
  /** O que foi digitado ainda não pode ser enviado. */
  impedido?: boolean;
  aoConfirmar: () => void;
  aoCancelar: () => void;
  children?: ReactNode;
}) {
  const confirmar = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    confirmar.current?.focus();
  }, []);
  return (
    <span className="confirma-linha">
      <span className="confirma-txt">{texto}</span>
      {children}
      <button ref={confirmar} className="btn btn--sm btn--perigo-cheio" type="button" onClick={aoConfirmar} disabled={ocupado || impedido} aria-busy={ocupado}>
        {ocupado ? rotuloOcupado : rotulo}
      </button>
      <button className="btn btn--sm" type="button" onClick={aoCancelar} disabled={ocupado}>
        Cancelar
      </button>
    </span>
  );
}

export function BlocoNumeros({ titulo, numeros, children }: { titulo: string; numeros: Numero[]; children?: ReactNode }) {
  return (
    <div className="eqp-bloco">
      <div className="eqp-bloco-cab">
        <h3>{titulo}</h3>
      </div>
      <div className="eqp-numeros">
        {numeros.map((n) => (
          <p className="eqp-num" key={n.rotulo}>
            <b>{n.valor}</b>
            <span>{n.rotulo}</span>
          </p>
        ))}
      </div>
      {children}
    </div>
  );
}
