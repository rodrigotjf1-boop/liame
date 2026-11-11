import { DELIVERY_AREAS_MAX, DELIVERY_RADIUS_KM, type StoreAddress, type StoreLocation, type StoreLocationsResponse } from '@liame/contracts';

// Minha marca › Região (protótipo P40, aprovado em 11/11/2026; plano da região, R1): os textos e as regras puras da
// loja no mapa, sem React, para a tela e para os testes.

/** O raio em km como a tela escreve: "3 km", "3,5 km". */
export function km(v: number): string {
  return `${v.toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: 1 })} km`;
}

/** O raio de partida (D-RG-15). */
export const RAIO_INICIAL = 3;

/** O raio dentro da régua: de 1 a 15 km, de meio em meio. */
export function raioNaRegua(v: number): number {
  const passo = DELIVERY_RADIUS_KM.step;
  const arredondado = Math.round(v / passo) * passo;
  return Math.min(DELIVERY_RADIUS_KM.max, Math.max(DELIVERY_RADIUS_KM.min, arredondado));
}

/** O CEP como a pessoa lê: "20520-054". */
export function cepComHifen(cep: string): string {
  const d = cep.replace(/\D/g, '');
  return d.length === 8 ? `${d.slice(0, 5)}-${d.slice(5)}` : cep;
}

/** Os 8 números do CEP digitado, ou nulo. */
export function cepDigitado(texto: string): string | null {
  const d = texto.replace(/\D/g, '');
  return d.length === 8 && texto.replace(/[\s.-]/g, '').length === 8 ? d : null;
}

/** "s/n", "S/N", "sn" e "sem número": a loja sem número, e o ponto fica no centro do bairro (D-RG-14). */
export function semNumero(numero: string): boolean {
  const t = numero.trim().toLowerCase();
  return t === 's/n' || t === 'sn' || t === 's/nº' || t === 'sem número' || t === 'sem numero';
}

/** As áreas sem repetir (sem diferença de caixa) e sem vazias, até 20 (a mesma regra do servidor). */
export function juntarArea(areas: readonly string[], nova: string): { areas: string[]; recusa: string | null } {
  const t = nova.trim().replace(/\s+/g, ' ').slice(0, 80);
  if (!t) return { areas: [...areas], recusa: 'Digite o nome do bairro.' };
  if (areas.some((a) => a.toLowerCase() === t.toLowerCase())) return { areas: [...areas], recusa: `${t} já está na lista.` };
  if (areas.length >= DELIVERY_AREAS_MAX) return { areas: [...areas], recusa: `No máximo ${DELIVERY_AREAS_MAX} áreas, como o Google aceita.` };
  return { areas: [...areas, t], recusa: null };
}

/** O nome da loja nova (D-RG-17): o do Perfil do Google ou "Loja" e o bairro. */
export function nomeDaLojaNova(nomeDoPerfil: string | null, bairro: string | null): string {
  const nome = (nomeDoPerfil ?? '').trim();
  if (nome) return nome.slice(0, 80);
  return bairro?.trim() ? `Loja ${bairro.trim()}`.slice(0, 80) : '';
}

/** A rua, o número e o complemento numa linha. */
export function linhaDaRua(e: StoreAddress): string {
  const rua = [e.street, e.number].filter(Boolean).join(', ');
  return [rua || 'Rua não informada', e.complement].filter(Boolean).join(' · ');
}

/** O bairro, o município e a UF numa linha (o CEP vai ao lado, sem quebrar). */
export function linhaDoBairro(e: StoreAddress): string {
  return [e.district, `${e.city} – ${e.state}`].filter(Boolean).join(' · ');
}

/** O ponto no mapa em palavras (D-RG-14). */
export function textoDoPonto(l: StoreLocation): { tipo: 'endereco' | 'bairro' | 'cidade' | 'sem'; texto: string } {
  const c = l.coordinates;
  if (!c) return { tipo: 'sem', texto: 'O mapa não achou o lugar. Sua região vale pelo bairro; confira o endereço.' };
  if (c.precision === 'endereco') return { tipo: 'endereco', texto: 'Achado pelo endereço.' };
  if (c.precision === 'bairro') {
    const bairro = l.address?.district ? `da ${l.address.district}` : 'do bairro';
    const numero = l.address?.number && !semNumero(l.address.number) ? `o número ${l.address.number}` : 'o número';
    return { tipo: 'bairro', texto: `No centro ${bairro}: o mapa não achou ${numero}.` };
  }
  return { tipo: 'cidade', texto: `No centro de ${l.address?.city ?? 'cidade'}: o mapa não achou a rua nem o bairro.` };
}

/** A precisão como o Pro escreve. */
export function precisaoPro(l: StoreLocation): string {
  const c = l.coordinates;
  if (!c) return 'sem coordenada';
  if (c.precision === 'endereco') return 'endereço (a rua e o número achados no OpenStreetMap)';
  if (c.precision === 'bairro') return `bairro (o centro ${l.address?.district ? `da ${l.address.district}` : 'do bairro'} no OpenStreetMap; o número não foi achado)`;
  return 'cidade (o centro do município no OpenStreetMap)';
}

/** A coordenada com 4 casas: "-22,9244; -43,2327". */
export function coordenadaTexto(l: StoreLocation): string {
  const c = l.coordinates;
  if (!c) return '—';
  const f = (v: number) => v.toLocaleString('pt-BR', { minimumFractionDigits: 4, maximumFractionDigits: 4 });
  return `${f(c.latitude)}; ${f(c.longitude)}`;
}

/** O selo "N de M lojas no mapa". */
export function seloDasLojas(lojas: readonly StoreLocation[]): { texto: string; completo: boolean } | null {
  if (!lojas.length) return null;
  const n = lojas.filter((l) => l.address).length;
  return { texto: `${n} de ${lojas.length} ${lojas.length === 1 ? 'loja' : 'lojas'} no mapa`, completo: n === lojas.length };
}

/** A linha que a parte Região de Minha marca ganha (D-RG-11). */
export function linhaDeMinhaMarca(r: StoreLocationsResponse): string | null {
  if (r.availability.status !== 'disponivel') return null;
  const noMapa = r.stores.filter((l) => l.address);
  if (!noMapa.length) return 'Nenhuma loja no mapa ainda';
  const lista = noMapa.map((l) => `${l.unit_name}${l.delivery_radius_km ? `, até ${km(l.delivery_radius_km)}` : ''}`).join('; ');
  return `${noMapa.length} ${noMapa.length === 1 ? 'loja' : 'lojas'} no mapa: ${lista}`;
}

/** O nome do perfil que já é de outra loja, ou nulo (D-RG-16). */
export function lojaDoPerfil(r: StoreLocationsResponse, accountId: string, foraDe: string | null): string | null {
  const p = r.google_profiles.find((x) => x.account_id === accountId);
  if (!p?.unit_id || p.unit_id === foraDe) return null;
  return r.stores.find((l) => l.unit_id === p.unit_id)?.unit_name ?? 'outra loja';
}

/** O texto da recusa de salvar, pelo código do servidor. */
export function erroDeSalvar(code: string | undefined, padrao: string): string {
  switch (code) {
    case 'funcao-desligada':
      return 'A região foi desligada para a sua empresa enquanto você editava. Nada foi salvo.';
    case 'loja-com-este-nome':
      return 'A marca já tem uma loja com esse nome. Escolha outro nome.';
    case 'marca-com-regem':
      return 'Esta marca tem o Regem conectado: as lojas vêm dele. Feche a gaveta e ponha no mapa uma loja da lista.';
    case 'limite-de-lojas':
      return 'A marca chegou ao limite de lojas. Fale com a Liame para pôr mais.';
    case 'perfil-de-outra-loja':
      return 'Esse Perfil do Google já é de outra loja. Cada perfil vale para uma loja.';
    case 'perfil-nao-encontrado':
      return 'Esse Perfil do Google não está mais ligado à marca. Escolha outro ou informe pelo CEP.';
    default:
      return padrao;
  }
}
