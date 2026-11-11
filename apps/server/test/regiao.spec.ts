import { describe, expect, it } from 'vitest';
import { enderecoDoPerfil } from '../src/connectors/google-business/conector-perfil-google.js';
import { cepNormalizado, lerRespostaDoCep } from '../src/regiao/cep.js';
import { coordenadaDaResposta, consultasDoEndereco, numeroDoEndereco, ProcuraDeCoordenada } from '../src/regiao/coordenada.js';
import { areasDeEntrega, fusoDaUf, type LinhaDaLoja, lojaNoMapa, ruaENumero } from '../src/regiao/regiao.js';

// Plano da região, R1 (a loja no mapa): as regras puras, sem banco e sem rede. O caminho pela API, com o banco, está em
// `test/db/regiao.spec.ts`.

const DO_VIACEP = { cep: '21615-000', logradouro: 'Avenida General Benedito da Silveira', bairro: 'Vila Militar', localidade: 'Rio de Janeiro', uf: 'RJ', ibge: '3304557' };
const NO_RIO = [{ lat: '-22.8612', lon: '-43.4031', address: { suburb: 'Vila Militar', city: 'Rio de Janeiro', state: 'Rio de Janeiro' } }];

describe('o CEP', () => {
  it('aceita os 8 números com ou sem o hífen e recusa o resto', () => {
    expect(cepNormalizado('21615-000')).toBe('21615000');
    expect(cepNormalizado(' 21615000 ')).toBe('21615000');
    for (const errado of ['2161-5000', '2161500', '216150000', 'abcdefgh', '21615-00a', '00000000', '']) expect(cepNormalizado(errado), errado).toBeNull();
  });

  it('lê a resposta do ViaCEP: achado, não achado (com `erro` verdadeiro ou em texto) e fora do formato', () => {
    expect(lerRespostaDoCep('21615000', DO_VIACEP)).toEqual({
      situacao: 'achado',
      endereco: { cep: '21615000', rua: 'Avenida General Benedito da Silveira', bairro: 'Vila Militar', cidade: 'Rio de Janeiro', uf: 'RJ', codigoIbge: '3304557' },
    });
    expect(lerRespostaDoCep('99999999', { erro: true })).toEqual({ situacao: 'nao_achado' });
    expect(lerRespostaDoCep('99999999', { erro: 'true' })).toEqual({ situacao: 'nao_achado' });
    expect(lerRespostaDoCep('21615000', { ...DO_VIACEP, ibge: '33' })).toEqual({ situacao: 'fora_do_ar' });
    // A resposta de outro CEP não vale para este.
    expect(lerRespostaDoCep('20000000', DO_VIACEP)).toEqual({ situacao: 'fora_do_ar' });
  });

  it('o CEP geral do município vem sem rua e sem bairro', () => {
    const r = lerRespostaDoCep('28890000', { cep: '28890-000', logradouro: '', bairro: '', localidade: 'Rio das Ostras', uf: 'RJ', ibge: '3304524' });
    expect(r.situacao === 'achado' && r.endereco).toMatchObject({ rua: null, bairro: null, cidade: 'Rio das Ostras', codigoIbge: '3304524' });
  });
});

describe('a coordenada', () => {
  it('tenta do mais preciso para o menos: endereço (só com a rua e o número), bairro e cidade', () => {
    const completo = consultasDoEndereco({ rua: 'Rua X', numero: '12', bairro: 'Penha', cidade: 'Rio de Janeiro', uf: 'RJ' });
    expect(completo.map((c) => c.precisao)).toEqual(['endereco', 'bairro', 'cidade']);
    expect(completo[0]!.params).toMatchObject({ street: '12 Rua X', city: 'Rio de Janeiro', state: 'Rio de Janeiro', country: 'Brasil' });
    expect(consultasDoEndereco({ rua: null, numero: '12', bairro: 'Penha', cidade: 'Rio de Janeiro', uf: 'RJ' }).map((c) => c.precisao)).toEqual(['bairro', 'cidade']);
    expect(consultasDoEndereco({ rua: null, numero: null, bairro: null, cidade: 'Rio de Janeiro', uf: 'RJ' }).map((c) => c.precisao)).toEqual(['cidade']);
    // Sem o número (ou "s/n"), o ponto fica no centro do bairro: a rua comprida jogaria o ponto longe da loja (D-RG-14).
    for (const numero of [null, 's/n', 'S/N', 'sem número', '']) {
      expect(consultasDoEndereco({ rua: 'Rua X', numero, bairro: 'Penha', cidade: 'Rio de Janeiro', uf: 'RJ' }).map((c) => c.precisao), String(numero)).toEqual(['bairro', 'cidade']);
    }
    expect(consultasDoEndereco({ rua: 'Rua X', numero: '450A', bairro: null, cidade: 'Rio de Janeiro', uf: 'RJ' })[0]!.params.street).toBe('450 Rua X');
    expect([numeroDoEndereco('450'), numeroDoEndereco(' 12-B '), numeroDoEndereco('s/n'), numeroDoEndereco(null)]).toEqual(['450', '12', null, null]);
  });

  it('a loja criada no Liame ganha o fuso pela UF (D-RG-17)', () => {
    expect([fusoDaUf('RJ'), fusoDaUf('AM'), fusoDaUf('MT'), fusoDaUf('AC'), fusoDaUf('PA')]).toEqual([
      'America/Sao_Paulo',
      'America/Manaus',
      'America/Cuiaba',
      'America/Rio_Branco',
      'America/Sao_Paulo',
    ]);
  });

  it('só vale a resposta no Brasil e no município do CEP (sem acento e sem caixa na comparação)', () => {
    expect(coordenadaDaResposta(NO_RIO, 'Rio de Janeiro', 'endereco')).toEqual({ latitude: -22.8612, longitude: -43.4031, precisao: 'endereco' });
    expect(coordenadaDaResposta([{ ...NO_RIO[0], address: { town: 'Niterói' } }], 'niteroi', 'cidade')).not.toBeNull();
    expect(coordenadaDaResposta([{ ...NO_RIO[0], address: { city: 'São Gonçalo' } }], 'Rio de Janeiro', 'bairro')).toBeNull();
    expect(coordenadaDaResposta([{ lat: '40.7', lon: '-74.0', address: { city: 'Rio de Janeiro' } }], 'Rio de Janeiro', 'cidade')).toBeNull();
    expect(coordenadaDaResposta([{ lat: 'x', lon: '-43', address: { city: 'Rio de Janeiro' } }], 'Rio de Janeiro', 'cidade')).toBeNull();
    expect(coordenadaDaResposta([], 'Rio de Janeiro', 'cidade')).toBeNull();
    expect(coordenadaDaResposta({ erro: 1 }, 'Rio de Janeiro', 'cidade')).toBeNull();
  });

  it('passa para a tentativa seguinte quando a primeira cai em outra cidade, e para quando o serviço falha', async () => {
    const pedidos: string[] = [];
    const respostas = [[{ ...NO_RIO[0], address: { city: 'Duque de Caxias' } }], NO_RIO];
    const procura = new ProcuraDeCoordenada(async (url) => {
      pedidos.push(url);
      return respostas.shift();
    });
    const achada = await procura.procurar({ rua: null, numero: null, bairro: 'Vila Militar', cidade: 'Rio de Janeiro', uf: 'RJ' });
    expect(achada).toEqual({ latitude: -22.8612, longitude: -43.4031, precisao: 'cidade' });
    expect(pedidos).toHaveLength(2);
    expect(pedidos.every((u) => new URL(u).host === 'nominatim.openstreetmap.org' && u.includes('countrycodes=br'))).toBe(true);

    const fora = new ProcuraDeCoordenada(async () => {
      throw new Error('fora do ar');
    });
    expect(await fora.procurar({ rua: 'Rua X', numero: '1', bairro: 'Penha', cidade: 'Rio de Janeiro', uf: 'RJ' })).toBeNull();
  });
});

describe('o endereço do Perfil do Google', () => {
  it('lê o endereço, a UF, a coordenada só inteira e as áreas sem repetir, até 20', () => {
    const lido = enderecoDoPerfil({
      title: 'Casa Brasa',
      storefrontAddress: { regionCode: 'BR', postalCode: '21615-000', addressLines: ['Av. Brasil, 123'], sublocality: 'Vila Militar', locality: 'Rio de Janeiro', administrativeArea: 'RJ' },
      latlng: { latitude: -22.86 },
      serviceArea: { businessType: 'CUSTOMER_AND_BUSINESS_LOCATION', places: { placeInfos: [{ placeName: 'Penha' }, { placeName: 'Penha' }, ...Array.from({ length: 30 }, (_, i) => ({ placeName: `Bairro ${i}` }))] } },
    });
    expect(lido).toMatchObject({ nome: 'Casa Brasa', cep: '21615000', linhas: ['Av. Brasil, 123'], bairro: 'Vila Militar', cidade: 'Rio de Janeiro', uf: 'RJ', latitude: null, longitude: null });
    expect(lido.areas).toHaveLength(20);
    expect(lido.areas[0]).toBe('Penha');
  });

  it('fora do Brasil, ou sem endereço (só atende na casa do cliente), fica sem endereço', () => {
    expect(enderecoDoPerfil({ storefrontAddress: { regionCode: 'PT', postalCode: '1000-001', locality: 'Lisboa' } })).toMatchObject({ cep: null, cidade: null });
    expect(enderecoDoPerfil({ title: 'Só entrega', serviceArea: { places: { placeInfos: [{ placeName: 'Tijuca' }] } } })).toMatchObject({ cep: null, areas: ['Tijuca'] });
    expect(enderecoDoPerfil(null)).toMatchObject({ nome: null, cep: null, areas: [] });
  });

  it('separa a rua do número na linha do endereço', () => {
    expect(ruaENumero('Av. Brasil, 123')).toEqual({ rua: 'Av. Brasil', numero: '123' });
    expect(ruaENumero('Rua X, 45 - Loja 2')).toEqual({ rua: 'Rua X', numero: '45' });
    expect(ruaENumero('Rua X, s/n')).toEqual({ rua: 'Rua X', numero: null });
    expect(ruaENumero('Rua X')).toEqual({ rua: 'Rua X', numero: null });
    expect(ruaENumero(undefined)).toEqual({ rua: null, numero: null });
  });
});

describe('a loja na resposta', () => {
  it('áreas sem repetir (sem diferença de caixa), sem vazias, até 20', () => {
    expect(areasDeEntrega([' Penha ', 'penha', '', 'Olaria', 'Ramos   de  Cima'])).toEqual(['Penha', 'Olaria', 'Ramos de Cima']);
    expect(areasDeEntrega(Array.from({ length: 25 }, (_, i) => `B${i}`))).toHaveLength(20);
  });

  it('monta a loja com os números como números, e sem endereço quando falta o CEP', () => {
    const linha: LinhaDaLoja = {
      id: '0190d2b0-0000-7000-8000-000000000001',
      name: 'Loja Centro',
      address_postal_code: '21615000',
      address_street: 'Av. Brasil',
      address_number: '123',
      address_complement: 'Loja 2',
      address_district: 'Vila Militar',
      address_city: 'Rio de Janeiro',
      address_state: 'RJ',
      ibge_city_code: '3304557',
      latitude: '-22.861200',
      longitude: '-43.403100',
      location_precision: 'endereco',
      location_source: 'cep',
      delivery_radius_km: '3.5',
      delivery_areas: ['Penha'],
      location_set_at: new Date('2026-11-11T12:00:00Z'),
      user_id: '0190d2b0-0000-7000-8000-000000000002',
      user_name: 'Ana',
      created_here: true,
      google_profile_account_id: null,
    };
    expect(lojaNoMapa(linha)).toMatchObject({
      address: { postal_code: '21615000', complement: 'Loja 2', ibge_city_code: '3304557' },
      created_here: true,
      google_profile_account_id: null,
      coordinates: { latitude: -22.8612, longitude: -43.4031, precision: 'endereco' },
      delivery_radius_km: 3.5,
      delivery_areas: ['Penha'],
      set_by: { name: 'Ana' },
      set_at: '2026-11-11T12:00:00.000Z',
    });
    const vazia = lojaNoMapa({ ...linha, address_postal_code: null, latitude: null, longitude: null, location_precision: null, delivery_radius_km: null, delivery_areas: [], user_id: null, location_set_at: null });
    expect(vazia).toMatchObject({ address: null, coordinates: null, delivery_radius_km: null, set_by: null, set_at: null });
  });
});
