/** Só dígitos, de 1 a `max` (ids que entram em caminho de URL ou cabeçalho: cliente do Google Ads, propriedade do GA4). */
export function soDigitos(valor: string | null | undefined, max = 20): valor is string {
  if (typeof valor !== 'string' || valor.length === 0 || valor.length > max) return false;
  for (const c of valor) if (c < '0' || c > '9') return false;
  return true;
}
