'use client';

import type { BrandResponse, StoreLocation, StoreLocationsResponse } from '@liame/contracts';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAvisar } from '@/components/ui/avisos';
import { Estado } from '@/components/ui/estado';
import { Faixa } from '@/components/ui/faixa';
import { Icone } from '@/components/ui/icone';
import { useAgora } from '@/lib/agora';
import { api, chamar, mensagemDe, type Problema } from '@/lib/api';
import { disparar } from '@/lib/disparar';
import { useSessao } from '@/lib/sessao';
import { type AbrirGaveta, GavetaLoja } from './gaveta-loja';
import { LojaNoMapa } from './loja-no-mapa';
import { SuaRegiao } from './sua-regiao';
import { seloDasLojas } from './textos';

// Minha marca › Região (mockups/prototipo-regiao.html, P40 aprovado em 11/11/2026; plano da região, R1): onde cada loja
// da marca fica, até onde entrega e, na R2, como é a região em volta. Veem quem tem `dossie.ver`; põem a loja no mapa o
// Dono e o Administrador (`dossie.editar`, D-RG-13). A função `regiao` é liberada pela Liame por empresa.

type Carga = { tipo: 'carregando' } | { tipo: 'ok'; marca: string; dados: StoreLocationsResponse } | { tipo: 'erro'; problema: Problema };

export function RegiaoTela() {
  const { pode } = useSessao();
  const avisar = useAvisar();
  const params = useSearchParams();
  const podeVer = pode('dossie.ver');
  const titulo = useRef<HTMLHeadingElement>(null);
  const tituloDasLojas = useRef<HTMLHeadingElement>(null);
  const [marcas, setMarcas] = useState<BrandResponse[] | null>(null);
  const [erroMarcas, setErroMarcas] = useState<Problema | null>(null);
  const [marca, setMarca] = useState<string | null>(null);
  const [carga, setCarga] = useState<Carga>({ tipo: 'carregando' });
  const [tentativa, setTentativa] = useState(0);
  const [gaveta, setGaveta] = useState<AbrirGaveta | null>(null);
  const seq = useRef(0);
  const agora = useAgora(60_000, carga);
  const pedida = params.get('marca');

  const carregarMarcas = useCallback(async () => {
    setErroMarcas(null);
    const r = await chamar(() => api.GET('/v1/brands'));
    if (!r.ok) return setErroMarcas(r.problema);
    const ativas = r.data.items.filter((b) => !b.archived_at);
    setMarcas(ativas);
    setMarca((m) => (m && ativas.some((b) => b.id === m) ? m : pedida && ativas.some((b) => b.id === pedida) ? pedida : (ativas[0]?.id ?? null)));
  }, [pedida]);

  useEffect(() => {
    if (podeVer) disparar(carregarMarcas());
  }, [podeVer, carregarMarcas]);

  // A lista vale só para a marca de que veio (V64).
  useEffect(() => {
    if (!marca) return;
    const id = ++seq.current;
    setCarga({ tipo: 'carregando' });
    setGaveta(null);
    disparar(
      chamar(() => api.GET('/v1/region/stores', { params: { query: { brand_id: marca } } })).then((r) => {
        if (id !== seq.current) return;
        setCarga(r.ok ? { tipo: 'ok', marca, dados: r.data } : { tipo: 'erro', problema: r.problema });
      }),
    );
  }, [marca, tentativa]);

  const nomeDaMarca = marcas?.find((m) => m.id === marca)?.name ?? 'sua marca';
  const dados = carga.tipo === 'ok' && carga.marca === marca ? carga.dados : null;

  function salvou(store: StoreLocation, criada: boolean) {
    setCarga((c) => {
      if (c.tipo !== 'ok') return c;
      const existe = c.dados.stores.some((l) => l.unit_id === store.unit_id);
      const stores = existe ? c.dados.stores.map((l) => (l.unit_id === store.unit_id ? store : l)) : [...c.dados.stores, store];
      // O perfil escolhido passa a ser desta loja (D-RG-16).
      const google_profiles = c.dados.google_profiles.map((p) => (p.account_id === store.google_profile_account_id ? { ...p, unit_id: store.unit_id } : p));
      return { ...c, dados: { ...c.dados, stores, google_profiles } };
    });
    avisar(criada ? `Loja ${store.unit_name} criada e posta no mapa.` : 'Salvo. O endereço, o raio e as áreas de entrega valem a partir de agora.');
    // A gaveta fecha e o botão que a abriu pode ter sumido (o vazio vira a loja): o foco vai para o título do cartão.
    setTimeout(() => tituloDasLojas.current?.focus({ preventScroll: true }), 0);
  }

  let corpo: React.ReactNode;
  if (!podeVer) {
    corpo = (
      <div className="card">
        <Estado icone="lock" titulo="Sem acesso a Minha marca">
          Quem vê a região é quem vê Minha marca. Peça ao Dono ou a um Administrador.
        </Estado>
      </div>
    );
  } else if (erroMarcas || carga.tipo === 'erro') {
    const problema = erroMarcas ?? (carga.tipo === 'erro' ? carga.problema : null);
    corpo = (
      <div className="card">
        <Estado
          icone="alert-circle"
          titulo="Não deu para abrir a região"
          perigo
          acao={
            <div className="vazio-acoes">
              <button className="btn" type="button" onClick={() => (erroMarcas ? disparar(carregarMarcas()) : setTentativa((t) => t + 1))}>
                <Icone nome="refresh" />
                Tentar de novo
              </button>
            </div>
          }
        >
          {problema ? mensagemDe(problema) : 'Tente de novo em instantes.'} Nada foi perdido.
        </Estado>
      </div>
    );
  } else if (marcas && !marcas.length) {
    corpo = (
      <div className="card">
        <Estado icone="info" titulo="Nenhuma marca ativa nesta empresa">
          A região é por marca: quando a empresa tiver uma marca ativa, ela aparece aqui.
        </Estado>
      </div>
    );
  } else if (!dados) {
    corpo = (
      <p className="lite-frase" role="status">
        Abrindo a região…
      </p>
    );
  } else if (dados.availability.status !== 'disponivel') {
    corpo = (
      <div className="card">
        <Estado icone="lock" titulo="A região ainda não está liberada para a sua empresa">
          Quando a distribuição do Liame liberar, esta página mostra cada loja no mapa, o raio de entrega e o retrato da região em volta, com a fonte de cada número. A parte Região de Minha marca (o
          texto e a retirada no balcão) continua valendo.
        </Estado>
      </div>
    );
  } else {
    const selo = seloDasLojas(dados.stores);
    const temPerfil = dados.google_profiles.length > 0;
    const abrir = (modo: 'perfil' | 'cep' | 'editar' | 'ajustar', lojaId: string | null) =>
      setGaveta({ lojaId, modo: modo === 'perfil' ? 'perfil' : 'cep', ajustar: modo === 'ajustar' });
    const acoesDeCriar = (
      <div className="vazio-acoes">
        {temPerfil ? (
          <>
            <button className="btn btn--primary" type="button" onClick={() => abrir('perfil', null)} aria-haspopup="dialog">
              <Icone nome="store" />
              Usar o endereço do Perfil do Google
            </button>
            <button className="btn" type="button" onClick={() => abrir('cep', null)} aria-haspopup="dialog">
              Informar pelo CEP
            </button>
          </>
        ) : (
          <>
            <button className="btn btn--primary" type="button" onClick={() => abrir('cep', null)} aria-haspopup="dialog">
              <Icone nome="map-pin" />
              Informar pelo CEP
            </button>
            <Link className="btn" href="/contas">
              Ligar o Perfil do Google
            </Link>
          </>
        )}
      </div>
    );
    corpo = (
      <div className="rg">
        {!dados.can_edit && (
          <Faixa tipo="acao" icone={<Icone nome="eye" />} titulo="Você vê a região, mas não muda" texto="Só o Dono e os Administradores põem a loja no mapa e mudam o raio e as áreas de entrega." />
        )}
        <section className="card rg-card" aria-labelledby="rg-lojas-t">
          <div className="rg-card-cab">
            <div>
              <h2 id="rg-lojas-t" tabIndex={-1} ref={tituloDasLojas}>
                A loja no mapa
                {selo && <span className={`st ${selo.completo ? 'st--concluido' : 'st--aguardando'}`}>{selo.texto}</span>}
              </h2>
              <p className="card-sub">Onde cada loja fica e até onde entrega. É dado da empresa: fica no Liame e serve para o raio dos anúncios e para Sua região.</p>
            </div>
            {dados.can_create_store && dados.stores.length > 0 && (
              <div className="rg-cab-acoes">
                <button className="btn btn--sm" type="button" onClick={() => abrir('cep', null)} aria-haspopup="dialog">
                  <Icone nome="plus" pequeno />
                  Pôr outra loja no mapa
                </button>
              </div>
            )}
          </div>
          {dados.stores.length ? (
            <ul className="rg-lojas">
              {dados.stores.map((l) => (
                <LojaNoMapa key={l.unit_id} loja={l} podeEditar={dados.can_edit} temPerfil={temPerfil} agora={agora} abrir={abrir} />
              ))}
            </ul>
          ) : (
            <div className="rg-loja rg-loja--vazia">
              <Estado icone="store" titulo={`A ${nomeDaMarca} ainda não tem loja no Liame`} acao={dados.can_create_store ? acoesDeCriar : undefined} compacto>
                {dados.can_create_store
                  ? `No Liame, a loja nasce quando a marca conecta o Regem. Sem ele, a loja nasce aqui: ao salvar o endereço, o Liame cria a loja com o nome do Perfil do Google ou, sem perfil, “Loja” e o bairro. Se o Regem for conectado depois, ele se liga a esta loja pelo mesmo nome.`
                  : dados.has_regem
                    ? 'As lojas desta marca vêm do Regem: quando ele mandar a loja, ela aparece aqui para pôr no mapa.'
                    : 'Só o Dono e os Administradores põem a loja no mapa.'}
              </Estado>
            </div>
          )}
          <p className="rg-nota">
            <Icone nome="lock" pequeno />
            <span>
              <b>O endereço da loja nunca vai para a IA.</b> Ela recebe só o bairro, o município e os números.
            </span>
          </p>
        </section>
        {marca && <SuaRegiao brandId={marca} lojas={dados.stores} />}
      </div>
    );
  }

  return (
    <section aria-labelledby="h-regiao">
      <Link className="btn btn--sm btn--ghost rg-volta" href="/marca">
        <Icone nome="chevron-left" pequeno />
        Minha marca
      </Link>
      <div className="view-cab anima" style={{ ['--i' as string]: 0 }}>
        <div>
          <h1 id="h-regiao" ref={titulo} tabIndex={-1}>
            Região
          </h1>
          <p>Onde cada loja da {nomeDaMarca} fica, até onde entrega e como é a região em volta. Os números vêm de fontes públicas e são calculados pelo sistema, sem IA.</p>
        </div>
        {marcas && marcas.length > 1 && (
          <div className="cab-acoes">
            <label className="res-campo">
              <span>Marca</span>
              <select className="input" value={marca ?? ''} onChange={(e) => setMarca(e.target.value)}>
                {marcas.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}
      </div>
      {corpo}
      {gaveta && dados && marca && (
        <GavetaLoja
          marca={{ id: marca, nome: nomeDaMarca }}
          dados={dados}
          abrir={gaveta}
          reserva={titulo}
          aoSalvar={(store, criada) => salvou(store, criada)}
          aoFechar={() => setGaveta(null)}
        />
      )}
    </section>
  );
}
