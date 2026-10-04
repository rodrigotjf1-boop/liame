/**
 * UUID v7 (RFC 9562) feito no navegador: 48 bits do relógio e o resto sorteado. Serve de id para o que a tela cria
 * antes de mandar (a mensagem da conversa): o mesmo envio repetido leva o mesmo id, e o servidor não duplica.
 */
export function uuidv7(agora: number = Date.now()): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  let t = BigInt(agora);
  for (let i = 5; i >= 0; i--) {
    b[i] = Number(t & 0xffn);
    t >>= 8n;
  }
  b[6] = (b[6]! & 0x0f) | 0x70;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const hex = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
