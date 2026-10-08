'use client';

import type { TeamMember } from '@liame/contracts';
import type { ReactNode } from 'react';
import { IconeLia } from '@/components/marca/logo';
import { Icone, type NomeIcone } from '@/components/ui/icone';
import { type Numero, type Selo, situacaoDo } from './textos';

// Peças pequenas da tela Sua equipe (protótipo P7): o avatar, o selo da situação e o bloco de números. A confirmação
// na linha é a do app (`components/ui/confirma-na-linha`).

export { ConfirmaNaLinha } from '@/components/ui/confirma-na-linha';

/** O avatar do funcionário: o ícone da LIA ou o ícone de traço do cargo. Apagado quando ele não está trabalhando. */
export function Avatar({ icone, grande = false, apagado = false }: { icone: NomeIcone | 'lia'; grande?: boolean; apagado?: boolean }) {
  if (icone === 'lia') return <IconeLia />;
  return (
    <span className={`av-func${grande ? ' av-func--lg' : ''}${apagado ? ' av-func--off' : ''}`} aria-hidden="true">
      <Icone nome={icone} />
    </span>
  );
}

export function SeloDaSituacao({ m, selo }: { m: TeamMember; selo?: Selo | undefined }) {
  const s = selo ?? situacaoDo(m);
  return (
    <span className={s.classe}>
      {s.ponto && <span className="dot" aria-hidden="true" />}
      {s.rotulo}
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
