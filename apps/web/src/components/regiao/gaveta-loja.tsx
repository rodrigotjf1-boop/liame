'use client';

import {
  type AddressLookupResponse,
  DELIVERY_RADIUS_KM,
  type GoogleProfileAddressResponse,
  type SaveStoreLocationRequest,
  type StoreLocation,
  type StoreLocationsResponse,
} from '@liame/contracts';
import { type FormEvent, type RefObject, useEffect, useId, useRef, useState } from 'react';
import { Icone } from '@/components/ui/icone';
import { useDialogo } from '@/components/ui/use-dialogo';
import { api, chamar, mensagemDe } from '@/lib/api';
import { disparar } from '@/lib/disparar';
import { useModo } from '@/lib/modo';
import { Aneis, LegendaDosAneis, Osm } from './aneis';
import { cepComHifen, cepDigitado, erroDeSalvar, juntarArea, km, lojaDoPerfil, nomeDaLojaNova, RAIO_INICIAL, raioNaRegua, semNumero } from './textos';

// A gaveta "pôr a loja no mapa" (protótipo P40, aprovado em 11/11/2026): o endereço do Perfil do Google (D-RG-16, um
// perfil por loja) ou pelo CEP (o ViaCEP completa; o ponto sai do OpenStreetMap ao salvar, com o número), o nome da loja
// nova na marca sem Regem (D-RG-17), o raio de 1 a 15 km (D-RG-15) e as áreas de entrega. Salvar não pede o código do
// app (D-RG-12). O endereço nunca vai para a IA (D-RG-2).

export type AbrirGaveta = { lojaId: string | null; modo: 'perfil' | 'cep'; ajustar: boolean };

type Props = {
  marca: { id: string; nome: string };
  dados: StoreLocationsResponse;
  abrir: AbrirGaveta;
  reserva: RefObject<HTMLElement | null>;
  aoSalvar: (store: StoreLocation, criada: boolean, mudouEndereco: boolean) => void;
  aoFechar: () => void;
};

type Consulta = { estado: 'buscando' } | { estado: 'ok'; achado: AddressLookupResponse } | { estado: 'nao-achado' } | { estado: 'fora'; texto: string } | null;
type LeituraDoPerfil = { estado: 'lendo' } | { estado: 'ok'; lido: GoogleProfileAddressResponse } | { estado: 'erro'; texto: string } | null;
type Erros = Partial<Record<'perfil' | 'cep' | 'numero' | 'rua' | 'nome' | 'areas', string>>;

/** O endereço salvo como se a conferência pelo CEP o tivesse devolvido (editar sem buscar de novo). */
function doSalvo(l: StoreLocation): AddressLookupResponse | null {
  if (!l.address) return null;
  return { address: l.address, coordinates: l.coordinates, coordinates_status: l.coordinates ? 'achada' : 'nao_achada', needs_street: l.address.street === null, attribution: '© OpenStreetMap' };
}

export function GavetaLoja({ marca, dados, abrir, reserva, aoSalvar, aoFechar }: Props) {
  const ids = useId();
  const corpo = useRef<HTMLDivElement>(null);
  const { ref, fechar, devolverFoco } = useDialogo({ reserva });
  const { modo: modoDaTela } = useModo();
  const loja = abrir.lojaId ? (dados.stores.find((l) => l.unit_id === abrir.lojaId) ?? null) : null;
  const criar = loja === null;
  const perfis = dados.google_profiles;
  const salvo = loja ? doSalvo(loja) : null;
  const perfilDaLoja = loja?.google_profile_account_id && perfis.some((p) => p.account_id === loja.google_profile_account_id) ? loja.google_profile_account_id : null;
  const livres = perfis.filter((p) => !lojaDoPerfil(dados, p.account_id, abrir.lojaId));

  const [modo, setModo] = useState<'perfil' | 'cep'>(() => {
    if (!perfis.length) return 'cep';
    if (loja?.address) return loja.source === 'perfil_google' && !abrir.ajustar ? 'perfil' : 'cep';
    return abrir.modo;
  });
  const [perfilId, setPerfilId] = useState<string | null>(() => {
    if (perfilDaLoja) return perfilDaLoja;
    return !loja?.address && livres.length === 1 && perfis.length === 1 ? livres[0]!.account_id : null;
  });
  const [leitura, setLeitura] = useState<LeituraDoPerfil>(null);
  const [cep, setCep] = useState(loja?.address ? cepComHifen(loja.address.postal_code) : '');
  const [numero, setNumero] = useState(loja?.address?.number ?? '');
  const [compl, setCompl] = useState(loja?.address?.complement ?? '');
  const [rua, setRua] = useState(loja?.address?.street ?? '');
  const [consulta, setConsulta] = useState<Consulta>(salvo && loja?.source === 'cep' ? { estado: 'ok', achado: salvo } : null);
  const [raio, setRaio] = useState(loja?.delivery_radius_km ?? RAIO_INICIAL);
  const [areas, setAreas] = useState<string[]>(loja?.delivery_areas ?? []);
  const [areaNova, setAreaNova] = useState('');
  const [nome, setNome] = useState('');
  const [nomeMexido, setNomeMexido] = useState(false);
  const [erros, setErros] = useState<Erros>({});
  const [erro, setErro] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [anuncio, setAnuncio] = useState('');
  const seq = useRef(0);

  // O perfil escolhido é lido agora no Google (o endereço e as áreas); editar a loja que já veio dele não lê de novo.
  const lerPerfil = async (accountId: string) => {
    const id = ++seq.current;
    setLeitura({ estado: 'lendo' });
    const r = await chamar(() => api.POST('/v1/region/google-profile-address', { body: { brand_id: marca.id, account_id: accountId } }));
    if (id !== seq.current) return;
    if (!r.ok) return setLeitura({ estado: 'erro', texto: mensagemDe(r.problema) });
    setLeitura({ estado: 'ok', lido: r.data });
    if (r.data.delivery_areas.length) setAreas((atual) => (atual.length && loja?.address ? atual : r.data.delivery_areas));
    if (criar && !nomeMexido) setNome(nomeDaLojaNova(r.data.profile_name, r.data.address?.district ?? null));
    setAnuncio(r.data.address ? `Perfil lido: ${r.data.address.street ?? ''} ${r.data.address.number ?? ''}, ${r.data.address.district ?? r.data.address.city}.` : 'Esse perfil não mostra o endereço.');
  };

  // Ao abrir com um perfil já escolhido e sem endereço salvo dele, a leitura começa sozinha.
  useEffect(() => {
    if (modo === 'perfil' && perfilId && !(perfilDaLoja === perfilId && loja?.address && loja.source === 'perfil_google')) disparar(lerPerfil(perfilId));
    const alvo = abrir.ajustar ? `#${CSS.escape(`${ids}-numero`)}` : modo === 'cep' ? `#${CSS.escape(`${ids}-cep`)}` : 'input[name="rg-perfil"]:not([disabled]), input[name="rg-origem"]';
    corpo.current?.querySelector<HTMLElement>(alvo)?.focus();
    // Só ao abrir.
    // biome-ignore lint/correctness/useExhaustiveDependencies: a leitura inicial roda uma vez, na abertura da gaveta.
  }, []);

  async function buscarCep() {
    const d = cepDigitado(cep);
    if (!d) {
      setConsulta(null);
      setErros({ cep: 'Digite os 8 números do CEP.' });
      return;
    }
    setErros({});
    const id = ++seq.current;
    setConsulta({ estado: 'buscando' });
    const r = await chamar(() => api.POST('/v1/region/address-lookup', { body: { brand_id: marca.id, postal_code: d } }));
    if (id !== seq.current) return;
    if (r.ok) {
      setConsulta({ estado: 'ok', achado: r.data });
      setRua(r.data.address.street ?? '');
      if (!areas.length && r.data.address.district) setAreas([r.data.address.district]);
      if (criar && !nomeMexido) setNome(nomeDaLojaNova(null, r.data.address.district));
      setAnuncio(`CEP encontrado: ${[r.data.address.street, r.data.address.district, r.data.address.city].filter(Boolean).join(', ')}. Agora, o número.`);
      corpo.current?.querySelector<HTMLElement>(`#${CSS.escape(r.data.needs_street ? `${ids}-rua` : `${ids}-numero`)}`)?.focus();
      return;
    }
    if (r.problema.code === 'cep-nao-encontrado' || r.problema.code === 'cep-invalido') {
      setConsulta({ estado: 'nao-achado' });
      setAnuncio('CEP não encontrado.');
      return;
    }
    setConsulta({ estado: 'fora', texto: mensagemDe(r.problema) });
    setAnuncio('O serviço de CEP não respondeu.');
  }

  function acrescentar() {
    const r = juntarArea(areas, areaNova);
    if (r.recusa) {
      setErros((e) => ({ ...e, areas: r.recusa ?? undefined }));
      return;
    }
    setAreas(r.areas);
    setAreaNova('');
    setErros((e) => ({ ...e, areas: undefined }));
    setAnuncio(`${areaNova.trim()} entrou nas áreas de entrega.`);
  }

  function tirar(i: number) {
    const nomeDaArea = areas[i];
    setAreas((lista) => lista.filter((_, j) => j !== i));
    setAnuncio(`${nomeDaArea} saiu das áreas de entrega.`);
    corpo.current?.querySelector<HTMLElement>(`#${CSS.escape(`${ids}-area`)}`)?.focus();
  }

  async function salvar(ev: FormEvent) {
    ev.preventDefault();
    setErro('');
    const novos: Erros = {};
    const lido = leitura?.estado === 'ok' ? leitura.lido : null;
    const doPerfilSalvo = modo === 'perfil' && perfilId !== null && perfilId === perfilDaLoja && loja?.source === 'perfil_google' && !lido;
    if (modo === 'perfil') {
      if (!perfilId) novos.perfil = 'Escolha o perfil desta loja.';
      else if (!doPerfilSalvo && leitura?.estado !== 'ok') novos.perfil = leitura?.estado === 'erro' ? leitura.texto : 'Espere o Liame ler o perfil.';
      else if (!doPerfilSalvo && (!lido?.address || lido.needs_street)) novos.perfil = 'Esse perfil não mostra o endereço completo. Informe pelo CEP.';
    } else {
      if (consulta?.estado !== 'ok') {
        novos.cep =
          consulta?.estado === 'fora' ? 'O serviço de CEP não respondeu. Tente de novo antes de salvar.' : consulta?.estado === 'nao-achado' ? 'Confira o CEP: este não foi encontrado.' : 'Busque o CEP antes de salvar.';
      } else {
        if (consulta.achado.needs_street && !rua.trim()) novos.rua = 'Digite a rua: este CEP vale para o município inteiro.';
        if (!numero.trim()) novos.numero = 'Digite o número da loja (ou s/n).';
      }
    }
    const nomeFinal = criar ? nome.trim() : '';
    if (criar && !nomeFinal) novos.nome = 'Dê um nome à loja.';
    if (!areas.length) novos.areas = 'Deixe pelo menos uma área de entrega.';
    if (Object.values(novos).some(Boolean)) {
      setErros(novos);
      const ordem: Array<[keyof Erros, string]> = [
        ['perfil', 'input[name="rg-perfil"]:not([disabled])'],
        ['cep', `#${CSS.escape(`${ids}-cep`)}`],
        ['rua', `#${CSS.escape(`${ids}-rua`)}`],
        ['numero', `#${CSS.escape(`${ids}-numero`)}`],
        ['nome', `#${CSS.escape(`${ids}-nome`)}`],
        ['areas', `#${CSS.escape(`${ids}-area`)}`],
      ];
      const primeiro = ordem.find(([k]) => novos[k]);
      if (primeiro) corpo.current?.querySelector<HTMLElement>(primeiro[1])?.focus();
      setAnuncio(Object.values(novos).find(Boolean) ?? '');
      return;
    }
    setErros({});
    setEnviando(true);

    // O endereço e o ponto: do perfil lido, do que estava salvo ou de uma conferência nova com o número (o ponto pelo
    // endereço só sai com a rua e o número; "s/n" fica no centro do bairro).
    let endereco: SaveStoreLocationRequest['address'];
    let coordenadas: SaveStoreLocationRequest['coordinates'];
    let origem: SaveStoreLocationRequest['source'];
    if (modo === 'perfil') {
      const a = doPerfilSalvo ? loja!.address! : lido!.address!;
      endereco = { postal_code: a.postal_code, street: a.street, number: a.number, complement: doPerfilSalvo ? a.complement : null, district: a.district, city: a.city, state: a.state, ibge_city_code: a.ibge_city_code };
      const c = doPerfilSalvo ? loja!.coordinates : lido!.coordinates;
      coordenadas = c ? { latitude: c.latitude, longitude: c.longitude, precision: c.precision as 'endereco' | 'bairro' | 'cidade' } : null;
      origem = 'perfil_google';
    } else {
      const achado = (consulta as { estado: 'ok'; achado: AddressLookupResponse }).achado;
      const mesmo =
        loja?.address &&
        loja.source === 'cep' &&
        loja.address.postal_code === achado.address.postal_code &&
        (loja.address.number ?? '') === numero.trim() &&
        (loja.address.street ?? '') === (achado.needs_street ? rua.trim() : (achado.address.street ?? ''));
      let final = achado;
      if (!mesmo) {
        const n = numero.trim();
        const r = await chamar(() =>
          api.POST('/v1/region/address-lookup', {
            body: { brand_id: marca.id, postal_code: achado.address.postal_code, number: semNumero(n) ? undefined : n, ...(achado.needs_street ? { street: rua.trim() } : {}) },
          }),
        );
        if (!r.ok) {
          setEnviando(false);
          setErro(r.problema.code === 'cep-fora-do-ar' ? 'O serviço de CEP não respondeu agora. Nada foi salvo: tente de novo em instantes.' : mensagemDe(r.problema));
          corpo.current?.scrollTo({ top: 0 });
          return;
        }
        final = r.data;
      }
      const a = final.address;
      endereco = {
        postal_code: a.postal_code,
        street: achado.needs_street ? rua.trim() || null : a.street,
        number: numero.trim(),
        complement: compl.trim() || null,
        district: a.district,
        city: a.city,
        state: a.state,
        ibge_city_code: a.ibge_city_code,
      };
      const c = final.coordinates;
      coordenadas = c ? { latitude: c.latitude, longitude: c.longitude, precision: c.precision as 'endereco' | 'bairro' | 'cidade' } : null;
      origem = 'cep';
    }
    const corpoDoPedido: SaveStoreLocationRequest = {
      address: endereco,
      coordinates: coordenadas,
      source: origem,
      ...(origem === 'perfil_google' && perfilId ? { google_profile_account_id: perfilId } : {}),
      delivery_radius_km: raioNaRegua(raio),
      delivery_areas: areas,
    };
    const r = criar
      ? await chamar(() => api.POST('/v1/region/stores', { body: { ...corpoDoPedido, brand_id: marca.id, name: nomeFinal } }))
      : await chamar(() => api.PUT('/v1/units/{id}/location', { params: { path: { id: loja!.unit_id } }, body: corpoDoPedido }));
    setEnviando(false);
    if (!r.ok) {
      setErro(erroDeSalvar(r.problema.code, mensagemDe(r.problema)));
      corpo.current?.scrollTo({ top: 0 });
      return;
    }
    const antes = loja?.address ? JSON.stringify([loja.address, loja.coordinates]) : '';
    aoSalvar(r.data.store, criar, JSON.stringify([r.data.store.address, r.data.store.coordinates]) !== antes);
    fechar();
  }

  const titulo = criar ? 'Criar a loja e pôr no mapa' : loja?.address ? `${loja.unit_name} no mapa` : `Pôr a ${loja?.unit_name ?? 'loja'} no mapa`;
  const erroDe = (k: keyof Erros) =>
    erros[k] ? (
      <p className="campo-erro" id={`${ids}-e-${k}`}>
        {erros[k]}
      </p>
    ) : null;
  const invalido = (k: keyof Erros) => (erros[k] ? { 'aria-invalid': true, 'aria-describedby': `${ids}-e-${k}` } : {});
  const achado = consulta?.estado === 'ok' ? consulta.achado : null;
  const n = numero.trim();
  const pontoDoCep = !achado ? '' : !n ? 'Digite o número para o Liame achar o ponto da loja no mapa.' : semNumero(n) ? `Sem o número, o ponto fica no centro ${achado.address.district ? `da ${achado.address.district}` : 'do bairro'}. Sua região vale; para anunciar por raio, o ponto precisa ser o da loja.` : 'O Liame acha o ponto pelo endereço (© OpenStreetMap) ao salvar.';
  const lido = leitura?.estado === 'ok' ? leitura.lido : null;
  const enderecoDoPerfil = lido?.address ?? (modo === 'perfil' && perfilId === perfilDaLoja && loja?.source === 'perfil_google' ? loja.address : null);
  const bairroDaLoja = modo === 'perfil' ? (enderecoDoPerfil?.district ?? '') : (achado?.address.district ?? '');

  return (
    <dialog
      ref={ref}
      className="dialogo dialogo--lado rg-gaveta"
      aria-labelledby={`${ids}-t`}
      onClose={() => {
        aoFechar();
        devolverFoco();
      }}
      onClick={(e) => {
        if (e.target === ref.current && !enviando) fechar();
      }}
    >
      <form className="dialogo-form" onSubmit={(e) => disparar(salvar(e))} noValidate>
        <div className="dialogo-cab">
          <div className="dlg-titulo">
            <p className="rotulo-marca">Minha marca · Região</p>
            <h2 id={`${ids}-t`}>{titulo}</h2>
          </div>
          <button className="btn btn--icon btn--ghost" type="button" onClick={fechar} aria-label="Fechar" disabled={enviando}>
            <Icone nome="x" />
          </button>
        </div>
        <div className="dialogo-corpo" ref={corpo}>
          {erro && (
            <p className="dialogo-erro" role="alert">
              <Icone nome="alert" pequeno />
              <span>{erro}</span>
            </p>
          )}
          {criar && (
            <p className="rg-aviso">
              <Icone nome="store" pequeno />
              <span>A {marca.nome} ainda não tem esta loja no Liame. Ao salvar, a loja nasce com o nome abaixo e o endereço desta gaveta.</span>
            </p>
          )}
          {abrir.ajustar && loja?.source === 'perfil_google' && (
            <p className="rg-nota">
              <Icone nome="info" pequeno />
              <span>O endereço veio do Perfil do Google. Corrigir aqui muda só o Liame; o Perfil no Google continua como está.</span>
            </p>
          )}

          {perfis.length > 0 && (
            <fieldset className="rg-g-bloco">
              <legend>De onde vem o endereço</legend>
              <div className="rg-opcoes">
                <label className="opcao">
                  <input type="radio" name="rg-origem" value="perfil" checked={modo === 'perfil'} onChange={() => setModo('perfil')} />
                  <span className="opcao-txt">
                    <b>Do seu Perfil da Empresa no Google</b>
                    <span>O Google dá o endereço e as áreas de entrega; o Liame acha o ponto no mapa pelo endereço.</span>
                  </span>
                </label>
                <label className="opcao">
                  <input type="radio" name="rg-origem" value="cep" checked={modo === 'cep'} onChange={() => setModo('cep')} />
                  <span className="opcao-txt">
                    <b>Informar pelo CEP</b>
                    <span>Você digita o CEP e o número; o Liame completa a rua, o bairro, o município e a UF.</span>
                  </span>
                </label>
              </div>
            </fieldset>
          )}

          {modo === 'perfil' ? (
            <fieldset className="rg-g-bloco">
              <legend>{perfis.length > 1 ? 'Qual perfil é desta loja?' : 'O perfil desta loja'}</legend>
              {perfis.length > 1 && <p className="campo-dica">A marca tem mais de um Perfil da Empresa no Google. Cada perfil vale para uma loja.</p>}
              <div className="rg-opcoes">
                {perfis.map((p) => {
                  const deOutra = lojaDoPerfil(dados, p.account_id, abrir.lojaId);
                  return (
                    <label className="opcao" key={p.account_id} aria-disabled={deOutra ? true : undefined}>
                      <input
                        type="radio"
                        name="rg-perfil"
                        value={p.account_id}
                        checked={perfilId === p.account_id}
                        disabled={deOutra !== null}
                        onChange={() => {
                          setPerfilId(p.account_id);
                          setErros((e) => ({ ...e, perfil: undefined }));
                          disparar(lerPerfil(p.account_id));
                        }}
                        {...invalido('perfil')}
                      />
                      <span className="opcao-txt">
                        <b>{p.name}</b>
                        {deOutra && <span>Já é o perfil da loja {deOutra}</span>}
                      </span>
                    </label>
                  );
                })}
              </div>
              {erroDe('perfil')}
              {leitura?.estado === 'lendo' && (
                <p className="campo-dica" role="status">
                  Lendo o endereço no Perfil do Google…
                </p>
              )}
              {leitura?.estado === 'erro' && (
                <p className="dialogo-erro" role="alert">
                  <Icone nome="alert-circle" pequeno />
                  <span>{leitura.texto}</span>
                </p>
              )}
              {enderecoDoPerfil && (
                <div className="rg-achado" aria-live="polite">
                  <dl className="rg-dl">
                    <div>
                      <dt>Endereço</dt>
                      <dd>{[enderecoDoPerfil.street, enderecoDoPerfil.number].filter(Boolean).join(', ') || 'Rua não informada no perfil'}</dd>
                    </div>
                    <div>
                      <dt>Bairro</dt>
                      <dd>{enderecoDoPerfil.district ?? '—'}</dd>
                    </div>
                    <div>
                      <dt>Município</dt>
                      <dd>
                        {enderecoDoPerfil.city} – {enderecoDoPerfil.state} · CEP <span className="num">{cepComHifen(enderecoDoPerfil.postal_code)}</span>
                      </dd>
                    </div>
                    <div>
                      <dt>O ponto</dt>
                      <dd>O Liame acha o ponto pelo endereço do perfil (© OpenStreetMap).</dd>
                    </div>
                  </dl>
                  <span className="eixo-nota">{lido ? 'Lido agora do Perfil do Google.' : 'Como foi salvo.'} Para mudar o endereço que o cliente vê, mude no Google.</span>
                </div>
              )}
              {lido && !lido.address && (
                <p className="rg-nota">
                  <Icone nome="info" pequeno />
                  <span>Esse perfil não mostra o endereço (atende só na casa do cliente). As áreas vieram dele; informe o endereço da loja pelo CEP.</span>
                </p>
              )}
            </fieldset>
          ) : (
            <fieldset className="rg-g-bloco">
              <legend>O endereço da loja</legend>
              <div className="rg-cep">
                <div className="campo">
                  <label htmlFor={`${ids}-cep`}>CEP</label>
                  <input
                    className="input num"
                    id={`${ids}-cep`}
                    inputMode="numeric"
                    autoComplete="off"
                    maxLength={9}
                    placeholder="00000-000"
                    value={cep}
                    onChange={(e) => setCep(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        disparar(buscarCep());
                      }
                    }}
                    {...(consulta?.estado === 'nao-achado' ? { 'aria-invalid': true, 'aria-describedby': `${ids}-e-naoachado` } : invalido('cep'))}
                  />
                </div>
                <button className="btn" type="button" onClick={() => disparar(buscarCep())} disabled={consulta?.estado === 'buscando'}>
                  {consulta?.estado === 'buscando' ? (
                    'Buscando…'
                  ) : (
                    <>
                      <Icone nome="search" pequeno />
                      Buscar
                    </>
                  )}
                </button>
              </div>
              {consulta?.estado === 'nao-achado' ? (
                <>
                  <p className="campo-erro" id={`${ids}-e-naoachado`}>
                    Não achamos o CEP {cep} nos Correios. Confira os números.
                  </p>
                  <a className="campo-dica" href="https://buscacepinter.correios.com.br/app/endereco/index.php" target="_blank" rel="noopener noreferrer">
                    Não sabe o CEP? Busque pelo endereço no site dos Correios <Icone nome="external" pequeno />
                  </a>
                </>
              ) : (
                erroDe('cep')
              )}
              {consulta?.estado === 'fora' && (
                <div className="dialogo-erro" role="alert">
                  <Icone nome="alert-circle" pequeno />
                  <span>
                    O serviço de CEP não respondeu. Nada foi perdido: tente de novo em instantes.{' '}
                    <button className="link-bt" type="button" onClick={() => disparar(buscarCep())}>
                      Tentar de novo
                    </button>
                  </span>
                </div>
              )}
              {!achado && <p className="campo-dica">O Liame completa a rua, o bairro, o município e a UF pelo CEP. Depois, você põe o número.</p>}
              {achado && (
                <>
                  <div className="rg-achado" aria-live="polite">
                    <dl className="rg-dl">
                      {!achado.needs_street && (
                        <div>
                          <dt>Rua</dt>
                          <dd>{achado.address.street}</dd>
                        </div>
                      )}
                      <div>
                        <dt>Bairro</dt>
                        <dd>{achado.address.district ?? '—'}</dd>
                      </div>
                      <div>
                        <dt>Município</dt>
                        <dd>
                          {achado.address.city} – {achado.address.state}
                          {modoDaTela === 'pro' && (
                            <>
                              {' '}
                              · código IBGE <span className="num">{achado.address.ibge_city_code}</span>
                            </>
                          )}
                        </dd>
                      </div>
                      <div>
                        <dt>O ponto</dt>
                        <dd>{pontoDoCep}</dd>
                      </div>
                    </dl>
                    <span className="eixo-nota">Completado pelo CEP (ViaCEP).</span>
                  </div>
                  {achado.needs_street && (
                    <div className="campo">
                      <label htmlFor={`${ids}-rua`}>
                        Rua <span className="campo-dica">este CEP vale para o município inteiro</span>
                      </label>
                      <input className="input" id={`${ids}-rua`} value={rua} autoComplete="off" maxLength={200} onChange={(e) => setRua(e.target.value)} {...invalido('rua')} />
                      {erroDe('rua')}
                    </div>
                  )}
                  <div className="rg-num-compl">
                    <div className="campo">
                      <label htmlFor={`${ids}-numero`}>Número</label>
                      <input className="input" id={`${ids}-numero`} value={numero} autoComplete="off" maxLength={10} onChange={(e) => setNumero(e.target.value)} {...invalido('numero')} />
                      {erroDe('numero')}
                    </div>
                    <div className="campo">
                      <label htmlFor={`${ids}-compl`}>
                        Complemento <span className="campo-dica">opcional</span>
                      </label>
                      <input className="input" id={`${ids}-compl`} value={compl} autoComplete="off" maxLength={60} onChange={(e) => setCompl(e.target.value)} />
                    </div>
                  </div>
                </>
              )}
            </fieldset>
          )}

          {criar && (
            <div className="campo">
              <label htmlFor={`${ids}-nome`}>Nome da loja</label>
              <input
                className="input"
                id={`${ids}-nome`}
                value={nome}
                maxLength={80}
                placeholder={bairroDaLoja ? `Loja ${bairroDaLoja}` : 'Aparece depois do endereço'}
                onChange={(e) => {
                  setNome(e.target.value);
                  setNomeMexido(true);
                }}
                {...invalido('nome')}
              />
              {erroDe('nome')}
              <p className="campo-dica">
                {modo === 'perfil' && perfilId ? 'Veio do Perfil do Google.' : 'Sem perfil, o Liame usa “Loja” e o bairro.'} Se o Regem for conectado depois, ele se liga a esta loja pelo mesmo nome: mudando
                o nome aqui, use o mesmo nome no Regem.
              </p>
            </div>
          )}

          <fieldset className="rg-g-bloco">
            <legend>Raio de entrega</legend>
            <div className="rg-raio">
              <button className="btn btn--icon btn--sm" type="button" onClick={() => setRaio((v) => raioNaRegua(v - DELIVERY_RADIUS_KM.step))} aria-label="Diminuir o raio em 0,5 km" disabled={raio <= DELIVERY_RADIUS_KM.min}>
                <Icone nome="minus" />
              </button>
              <input
                type="range"
                min={DELIVERY_RADIUS_KM.min}
                max={DELIVERY_RADIUS_KM.max}
                step={DELIVERY_RADIUS_KM.step}
                value={raio}
                onChange={(e) => setRaio(raioNaRegua(Number(e.target.value)))}
                aria-label="Raio de entrega"
                aria-valuetext={km(raio)}
                aria-describedby={`${ids}-raio-dica`}
              />
              <button className="btn btn--icon btn--sm" type="button" onClick={() => setRaio((v) => raioNaRegua(v + DELIVERY_RADIUS_KM.step))} aria-label="Aumentar o raio em 0,5 km" disabled={raio >= DELIVERY_RADIUS_KM.max}>
                <Icone nome="plus" />
              </button>
            </div>
            <p>
              <span className="rg-raio-valor" aria-live="polite">
                {km(raio)}
              </span>
              <span className="campo-dica" id={`${ids}-raio-dica`}>
                De 1 a 15 km, em passos de 0,5 km. Começa em 3 km.
              </span>
            </p>
            <div className="rg-g-mapa">
              <Aneis raio={raio} noBairro={false} id={`${ids}-aneis`} />
              <LegendaDosAneis raio={raio} />
            </div>
            <p className="rg-osm">
              © <Osm /> · desenho em escala
            </p>
          </fieldset>

          <fieldset className="rg-g-bloco">
            <legend>Áreas de entrega</legend>
            <p className="campo-dica">
              {modo === 'perfil' && perfilId ? 'Vieram do Perfil do Google (o Google aceita até 20). Tirar ou acrescentar aqui não muda o Perfil no Google.' : 'Os bairros onde a loja entrega. Comece pelo bairro da loja.'}
            </p>
            {areas.length ? (
              <ul className="rg-areas">
                {areas.map((a, i) => (
                  <li key={a}>
                    {a}
                    <button className="btn btn--icon btn--ghost" type="button" onClick={() => tirar(i)} aria-label={`Tirar ${a}`}>
                      <Icone nome="x" pequeno />
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="campo-dica">Nenhuma área ainda.</p>
            )}
            <div className="rg-add">
              <input
                className="input"
                id={`${ids}-area`}
                value={areaNova}
                placeholder="Outro bairro"
                aria-label="Acrescentar um bairro"
                autoComplete="off"
                maxLength={80}
                onChange={(e) => setAreaNova(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    acrescentar();
                  }
                }}
                {...invalido('areas')}
              />
              <button className="btn" type="button" onClick={acrescentar}>
                <Icone nome="plus" pequeno />
                Acrescentar
              </button>
            </div>
            {erroDe('areas')}
          </fieldset>

          <p className="rg-nota">
            <Icone nome="lock" pequeno />
            <span>
              <b>O endereço da loja nunca vai para a IA.</b> Ela recebe só o bairro, o município e os números.
            </span>
          </p>
          <p className="rg-nota">
            <Icone nome="info" pequeno />
            <span>Salvar não pede o código do app: é dado da empresa, não gasta nem publica nada. Fica na auditoria com o seu nome.</span>
          </p>
          <p className="sr-only" role="status" aria-live="polite">
            {anuncio}
          </p>
        </div>
        <div className="dialogo-acoes">
          <button className="btn" type="button" onClick={fechar} disabled={enviando}>
            Cancelar
          </button>
          <button className="btn btn--primary" type="submit" disabled={enviando}>
            {enviando ? 'Salvando…' : criar ? 'Criar a loja e salvar' : 'Salvar a loja no mapa'}
          </button>
        </div>
      </form>
    </dialog>
  );
}
