import type { Ref } from 'react';
import { Icone } from '@/components/ui/icone';

// O botão "Explicar" (protótipo P4): violeta, com a marca da LIA, quando ela responde para a empresa;
// neutro quando a explicação é o resumo do sistema. Abre e fecha o bloco logo abaixo do que ele explica.

type Props = {
  /** A LIA responde para esta empresa? Falso: o botão neutro, e a explicação é a do sistema. */
  lia: boolean;
  aberto: boolean;
  /** `id` do bloco que ele abre. */
  controla: string;
  /** O que está sendo explicado, para quem ouve a tela ("Explicar: O cupom SMASH10 não teve uso"). */
  rotulo?: string;
  aoClicar: () => void;
  ref?: Ref<HTMLButtonElement>;
};

export function BotaoExplicar({ lia, aberto, controla, rotulo, aoClicar, ref }: Props) {
  // `aria-controls` só com o bloco na tela: fechado, o alvo não existe (ele só é desenhado ao abrir).
  return (
    <button ref={ref} className={lia ? 'ia-bt' : 'ia-bt ia-bt--neutro'} type="button" aria-expanded={aberto} aria-controls={aberto ? controla : undefined} aria-label={rotulo} onClick={aoClicar}>
      <Icone nome={lia ? 'sparkles' : 'file'} />
      Explicar
    </button>
  );
}
