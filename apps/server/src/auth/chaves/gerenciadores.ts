// O nome da chave de acesso pelo gerenciador que a guarda (A7, W9; D-A7-54; base §17.7): o AAGUID que o aparelho manda
// no cadastro, conferido na lista da comunidade (github.com/passkeydeveloper/passkey-authenticator-aaguids, `aaguid.json`,
// lida em 02/11/2026). A Apple manda zeros: aí o nome sai do aparelho. A pessoa troca o nome quando quiser.

export const AAGUID_ZERO = '00000000-0000-0000-0000-000000000000';

// O nome numa linha e os AAGUIDs nas seguintes: o AAGUID é público, mas um nome como "1Password" na mesma linha de um
// valor hexadecimal parece credencial para o gitleaks.
const GERENCIADORES: readonly (readonly [string, readonly string[]])[] = [
  ['Senhas do Google', ['ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4']],
  ['Chrome no Mac', ['adce0002-35bc-c60a-648b-0b25f1f05503']],
  ['Windows Hello', ['08987058-cadc-4b81-b6e1-30de50dcbe96', '9ddd1817-af5a-4672-a2b9-3e3dd95000a9', '6028b017-b1d4-4c02-b4b3-afcdafc96bb2']],
  ['iCloud', ['dd4ec289-e01d-41c9-bb89-70fa845d4bf2']],
  [
    '1Password',
    [
      'bada5566-a7aa-401f-bd96-45619a55120d',
    ],
  ],
  ['Dashlane', ['531126d6-e717-415c-9320-3d9aa6981239']],
];

const POR_AAGUID: Record<string, string> = Object.fromEntries(GERENCIADORES.flatMap(([nome, aaguids]) => aaguids.map((a) => [a, nome])));

/**
 * O nome da chave: o do gerenciador conhecido; com o AAGUID em zeros, a Apple (iCloud, com o aparelho) ou, sem pista, se a
 * chave sincroniza ("Chave sincronizada") ou fica num só lugar ("Chave de segurança").
 */
export function nomeDoGerenciador(aaguid: string, sincroniza: boolean, userAgent: string | null | undefined): string {
  const conhecido = POR_AAGUID[aaguid.toLowerCase()];
  if (conhecido) return conhecido;
  const ua = userAgent ?? '';
  if (aaguid === AAGUID_ZERO && sincroniza) {
    if (/iPhone/.test(ua)) return 'iCloud (iPhone)';
    if (/iPad/.test(ua)) return 'iCloud (iPad)';
    if (/Mac OS X|Macintosh/.test(ua)) return 'iCloud (Mac)';
  }
  return sincroniza ? 'Chave sincronizada' : 'Chave de segurança';
}
