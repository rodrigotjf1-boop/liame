/**
 * Copia o texto. Sem permissão da área de transferência (navegador antigo, http), tenta o jeito antigo,
 * dentro do diálogo aberto (fora dele, o `showModal` não deixa selecionar). `false` = não deu: a tela
 * pede para copiar à mão.
 */
export async function copiar(texto: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(texto);
    return true;
  } catch {
    // segue para o jeito antigo
  }
  const area = document.createElement('textarea');
  area.value = texto;
  area.setAttribute('readonly', '');
  area.className = 'sr-only';
  (document.querySelector('dialog[open]') ?? document.body).append(area);
  area.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  area.remove();
  return ok;
}
