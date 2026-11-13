'use client';

import { NEW_CAMPAIGN_DISTRICTS_MAX, type NewCampaignDistrictSearchResponse, type NewCampaignDistrictsResponse } from '@liame/contracts';
import { useEffect, useRef, useState } from 'react';
import { Icone } from '@/components/ui/icone';
import { api, chamar } from '@/lib/api';
import { disparar } from '@/lib/disparar';
import { bairroEscolhivel, comoVaiNaMeta, deOndeVemOBairro, dicaDosBairros } from './campanha-nova-textos';
import { PreviaDosBairros } from './previa-dos-bairros';

// "Quem vê: Bairros" na gaveta da campanha nova (R6, parte 3; revisão R6-3 da P42 aprovada pelo dono em 13/11/2026,
// D-RG-53 a D-RG-56): os bairros sugeridos (as áreas de entrega marcadas ao abrir, os bairros com pedidos), outro bairro
// pela busca, como cada um vai para a Meta, a prévia em escala. O centro que o Liame ainda procura aparece "procurando",
// e a lista é lida de novo em alguns segundos. A gaveta guarda os marcados; aqui, só a lista e a busca.

const TENTATIVAS_DO_CENTRO = 6;
const ESPERA_DO_CENTRO_MS = 4_000;
const ICONE_DO_JEITO = { meta: 'check-circle', circulo: 'compass', procurando: 'clock' } as const;

type Props = {
  id: string;
  brandId: string;
  loja: { id: string; name: string };
  marcados: string[];
  aoMudar: (codigos: string[]) => void;
  desligado: boolean;
  erro: string | undefined;
};

/** A gaveta monta este componente com `key` da loja: trocar a loja recomeça a lista e a marcação inicial. */
export function BairrosDaCampanha({ id, brandId, loja, marcados, aoMudar, desligado, erro }: Props) {
  const [lista, setLista] = useState<NewCampaignDistrictsResponse | null>(null);
  const [falha, setFalha] = useState<string | null>(null);
  const [extras, setExtras] = useState<string[]>([]);
  const [tentativa, setTentativa] = useState(0);
  const [busca, setBusca] = useState<string | null>(null);
  const [achados, setAchados] = useState<NewCampaignDistrictSearchResponse['items'] | null>(null);
  const iniciada = useRef(false);
  /** Os que devem entrar marcados quando o centro aparecer: as áreas de entrega e os escolhidos pela busca. */
  const aMarcar = useRef(new Set<string>());
  const campoBusca = useRef<HTMLInputElement>(null);
  const marcadosAgora = useRef(marcados);
  marcadosAgora.current = marcados;
  const avisar = useRef(aoMudar);
  avisar.current = aoMudar;

  // A lista (de novo enquanto houver bairro "procurando"); vale só a resposta da leitura mais nova.
  const extraTexto = extras.join(',');
  useEffect(() => {
    let viva = true;
    let espera: ReturnType<typeof setTimeout> | undefined;
    disparar(
      chamar(() =>
        api.GET('/v1/new-campaigns/districts', { params: { query: { brand_id: brandId, unit_id: loja.id, ...(extraTexto ? { extra: extraTexto } : {}) } } }),
      ).then((r) => {
        if (!viva) return;
        if (!r.ok) {
          setFalha(r.problema.detail ?? 'Não deu para ler os bairros da loja agora.');
          return;
        }
        setFalha(null);
        setLista(r.data);
        if (!iniciada.current) {
          iniciada.current = true;
          for (const b of r.data.items) if (b.delivery_area) aMarcar.current.add(b.code);
        }
        const escolhiveis = new Set(r.data.items.filter(bairroEscolhivel).map((b) => b.code));
        const novos = marcadosAgora.current.filter((c) => escolhiveis.has(c));
        for (const c of [...aMarcar.current]) {
          if (!escolhiveis.has(c)) continue;
          aMarcar.current.delete(c);
          if (!novos.includes(c)) novos.push(c);
        }
        const limitados = novos.slice(0, NEW_CAMPAIGN_DISTRICTS_MAX);
        if (limitados.join(',') !== marcadosAgora.current.join(',')) avisar.current(limitados);
        if (r.data.pending && tentativa < TENTATIVAS_DO_CENTRO) espera = setTimeout(() => setTentativa((t) => t + 1), ESPERA_DO_CENTRO_MS);
      }),
    );
    return () => {
      viva = false;
      if (espera) clearTimeout(espera);
    };
  }, [brandId, loja.id, extraTexto, tentativa]);

  // A busca de outro bairro, depois de a pessoa parar de digitar.
  useEffect(() => {
    const q = (busca ?? '').trim();
    if (q.length < 2) {
      setAchados(null);
      return;
    }
    let viva = true;
    const t = setTimeout(() => {
      disparar(
        chamar(() => api.GET('/v1/new-campaigns/districts/search', { params: { query: { brand_id: brandId, unit_id: loja.id, q } } })).then((r) => {
          if (viva) setAchados(r.ok ? r.data.items : []);
        }),
      );
    }, 300);
    return () => {
      viva = false;
      clearTimeout(t);
    };
  }, [busca, brandId, loja.id]);

  function trocar(codigo: string, marcar: boolean) {
    aoMudar(marcar ? [...marcados, codigo] : marcados.filter((c) => c !== codigo));
  }

  function escolher(codigo: string) {
    setBusca(null);
    setAchados(null);
    const ja = lista?.items.find((b) => b.code === codigo);
    if (ja && bairroEscolhivel(ja)) {
      if (!marcados.includes(codigo) && marcados.length < NEW_CAMPAIGN_DISTRICTS_MAX) aoMudar([...marcados, codigo]);
      return;
    }
    // O bairro novo entra na lista e fica marcado quando o centro aparecer.
    aMarcar.current.add(codigo);
    if (!ja) setExtras((x) => (x.includes(codigo) ? x : [...x, codigo]));
  }

  if (!lista) {
    return falha ? (
      <p className="campo-erro" role="alert">
        {falha}{' '}
        <button className="link-bt" type="button" onClick={() => setTentativa((t) => t + 1)}>
          Tentar de novo
        </button>
      </p>
    ) : (
      <p className="campo-dica" role="status">
        Lendo os bairros da {loja.name}…
      </p>
    );
  }
  if (lista.status === 'sem_cidade') {
    return <p className="campo-dica">A campanha por bairros usa o município da loja, e o ponto da {loja.name} ainda não está no endereço: ajuste em Minha marca › Região.</p>;
  }
  const cheio = marcados.length >= lista.maximum;
  const marcadosNaLista = lista.items.filter((b) => marcados.includes(b.code));
  return (
    <>
      <p className="campo-dica cn-bairros-origem">
        Marcadas ao abrir: as áreas de entrega da {loja.name} (Minha marca › Região). Os bairros com pedidos vêm de Sua região.
      </p>
      {lista.items.length === 0 ? (
        <p className="campo-dica">A loja ainda não tem áreas de entrega nem bairros com pedidos: procure o bairro abaixo.</p>
      ) : (
        <ul className="cn-bairros" aria-label="Bairros">
          {lista.items.map((b, i) => {
            const pode = bairroEscolhivel(b);
            const marcado = marcados.includes(b.code);
            return (
              <li key={b.code}>
                <label className="cn-bairro">
                  <input
                    type="checkbox"
                    name={`${id}-bairro`}
                    value={b.code}
                    data-campo={i === 0 ? 'bairros' : undefined}
                    checked={marcado}
                    disabled={desligado || !pode || (!marcado && cheio)}
                    aria-describedby={`${id}-bairros-d${erro ? ` ${id}-bairros-erro` : ''}`}
                    onChange={(e) => trocar(b.code, e.target.checked)}
                  />
                  <span className="cn-bairro-nome">
                    <b>{b.name}</b>
                    <small>{deOndeVemOBairro(b)}</small>
                  </span>
                  <span className="cn-bairro-como">
                    <Icone nome={b.how in ICONE_DO_JEITO ? ICONE_DO_JEITO[b.how as keyof typeof ICONE_DO_JEITO] : 'alert-circle'} pequeno />
                    {comoVaiNaMeta(b)}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      )}
      {lista.unmatched.length > 0 && (
        <p className="campo-dica">
          Estas áreas de entrega não estão entre os bairros do IBGE de {lista.city}: {lista.unmatched.join(', ')}. Procure o nome do bairro abaixo.
        </p>
      )}
      {busca === null ? (
        <button
          className="btn btn--sm btn--ghost cn-bairros-outro"
          type="button"
          disabled={desligado || cheio}
          onClick={() => {
            setBusca('');
            requestAnimationFrame(() => campoBusca.current?.focus());
          }}
        >
          <Icone nome="plus" pequeno />
          Outro bairro da cidade
        </button>
      ) : (
        <div className="campo cn-bairros-busca">
          <label htmlFor={`${id}-busca`}>Outro bairro de {lista.city}</label>
          <input
            className="input"
            id={`${id}-busca`}
            ref={campoBusca}
            autoComplete="off"
            maxLength={60}
            value={busca}
            aria-describedby={`${id}-busca-d`}
            aria-controls={`${id}-achados`}
            onChange={(e) => setBusca(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                setBusca(null);
              }
            }}
            disabled={desligado}
          />
          <span className="campo-dica" id={`${id}-busca-d`}>
            Os bairros do município no IBGE, os mesmos de Sua região. Escreva pelo menos 2 letras.
          </span>
          <ul className="cn-bairros-achados" id={`${id}-achados`} aria-label="Bairros achados" aria-live="polite">
            {achados?.length === 0 && <li className="campo-dica">Nenhum bairro com esse nome em {lista.city}.</li>}
            {achados?.map((a) => (
              <li key={a.code}>
                <button className="btn btn--sm" type="button" onClick={() => escolher(a.code)} disabled={desligado}>
                  <Icone nome="plus" pequeno />
                  {a.name}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      <span className="campo-dica" id={`${id}-bairros-d`}>
        {dicaDosBairros(marcados.length)}
      </span>
      {erro && (
        <span className="campo-erro" id={`${id}-bairros-erro`} role="alert">
          {erro}
        </span>
      )}
      <PreviaDosBairros bairros={marcadosNaLista} loja={loja.name} id={`${id}-previa`} />
    </>
  );
}
