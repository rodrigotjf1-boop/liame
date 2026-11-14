import { randomInt } from 'node:crypto';

// Os ids de mentira das redes nos testes (V156; ERR-236): números, como os da Meta. Os 13 primeiros algarismos são o
// instante; os últimos, um contador que começa num ponto sorteado. Dois ids criados no mesmo milissegundo, no mesmo
// processo, nunca saem iguais. Antes, os últimos algarismos eram sorteados a cada id: duas publicações criadas em seguida
// saíam com o mesmo id de vez em quando, e a leitura via três publicações onde o teste tinha criado quatro (no CI, em
// 14/11/2026, no "Do seu Instagram").
let sequencia = randomInt(1_000_000);

/** Um id numérico com `digitos` algarismos (a Página tem 15; o Instagram e os demais, 17), único neste processo. */
export function idNumericoDeMentira(digitos = 17): string {
  const resto = Math.max(1, digitos - 13);
  const fim = String(sequencia++ % 10 ** resto).padStart(resto, '0');
  return `${Date.now()}${fim}`.slice(0, digitos);
}
