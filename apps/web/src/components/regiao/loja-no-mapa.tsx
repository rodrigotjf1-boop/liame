'use client';

import type { StoreLocation } from '@liame/contracts';
import Link from 'next/link';
import { useId } from 'react';
import { Estado } from '@/components/ui/estado';
import { Faixa } from '@/components/ui/faixa';
import { Icone } from '@/components/ui/icone';
import { quandoComHora } from '@/lib/formato';
import { useDetalhes } from '@/lib/modo';
import { Aneis, LegendaDosAneis, Osm } from './aneis';
import { cepComHifen, coordenadaTexto, km, linhaDaRua, linhaDoBairro, precisaoPro, textoDoPonto } from './textos';

// Uma loja em "A loja no mapa" (protótipo P40): sem endereço, o convite para pôr no mapa; com ele, o endereço, de onde
// veio, o ponto em palavras, o raio, as áreas e a prévia dos anéis; no Pro (ou em "Ver detalhes"), a coordenada, a
// precisão, o código do município e quem salvou.

type Props = {
  loja: StoreLocation;
  podeEditar: boolean;
  temPerfil: boolean;
  agora: Date;
  abrir: (modo: 'perfil' | 'cep' | 'editar' | 'ajustar', lojaId: string) => void;
};

export function LojaNoMapa({ loja: l, podeEditar, temPerfil, agora, abrir }: Props) {
  const ids = useId();
  const { pro, aberto, mostraPro, alternar } = useDetalhes();

  if (!l.address) {
    const texto = !podeEditar
      ? 'Só o Dono e os Administradores põem a loja no mapa.'
      : temPerfil
        ? 'O Perfil da Empresa no Google da marca já tem o endereço e as áreas de entrega: é só conferir. Ou informe o CEP e o número.'
        : 'Informe o CEP e o número: o Liame completa a rua, o bairro, o município e a UF. Com o Perfil da Empresa no Google ligado, o endereço e as áreas de entrega vêm de lá.';
    const acoes = !podeEditar ? undefined : (
      <div className="vazio-acoes">
        {temPerfil ? (
          <>
            <button className="btn btn--primary" type="button" onClick={() => abrir('perfil', l.unit_id)} aria-haspopup="dialog">
              <Icone nome="store" />
              Usar o endereço do Perfil do Google
            </button>
            <button className="btn" type="button" onClick={() => abrir('cep', l.unit_id)} aria-haspopup="dialog">
              Informar pelo CEP
            </button>
          </>
        ) : (
          <>
            <button className="btn btn--primary" type="button" onClick={() => abrir('cep', l.unit_id)} aria-haspopup="dialog">
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
    return (
      <li className="rg-loja rg-loja--vazia">
        <Estado icone="map-pin" titulo={`A ${l.unit_name} ainda não está no mapa`} acao={acoes} compacto>
          {texto}
        </Estado>
      </li>
    );
  }

  const e = l.address;
  const ponto = textoDoPonto(l);
  const raio = l.delivery_radius_km ?? 3;
  const doPerfil = l.source === 'perfil_google';
  const ajustar = podeEditar ? (
    <button className="link-bt" type="button" onClick={() => abrir('ajustar', l.unit_id)} aria-haspopup="dialog">
      O ponto está errado? Ajuste o endereço
    </button>
  ) : (
    <span className="eixo-nota">Para corrigir, fale com o Dono ou um Administrador.</span>
  );
  const detalhes = `${ids}-pro`;

  return (
    <li className="rg-loja">
      <div className="rg-loja-info">
        <div className="rg-loja-cab">
          <h3>{l.unit_name}</h3>
          {doPerfil ? (
            <span className="st st--info">
              <Icone nome="store" pequeno />
              Do seu Perfil da Empresa no Google
            </span>
          ) : (
            <span className="st st--espera">
              <Icone nome="pencil" pequeno />
              Informado por você
            </span>
          )}
          {l.created_here && <span className="st st--concluido">Loja criada aqui</span>}
        </div>
        <p className="rg-end">
          <b>{linhaDaRua(e)}</b>
          <span>
            {linhaDoBairro(e)} · CEP <span className="num">{cepComHifen(e.postal_code)}</span>
          </span>
        </p>
        {ponto.tipo !== 'endereco' && (
          <Faixa
            tipo="atencao"
            icone={<Icone nome="target" />}
            titulo={ponto.tipo === 'bairro' ? 'O ponto está no centro do bairro, não na loja' : 'O ponto não é o da loja'}
            texto="Sua região vale, porque é por bairro. Para anunciar por raio, o ponto precisa ser o da loja: confira o número ou ponha o complemento."
            acao={
              podeEditar ? (
                <button className="btn btn--sm" type="button" onClick={() => abrir('ajustar', l.unit_id)} aria-haspopup="dialog">
                  Ajustar o endereço
                </button>
              ) : undefined
            }
          />
        )}
        <dl className="rg-dl">
          <div>
            <dt>O ponto no mapa</dt>
            <dd>
              <span className="rg-precisao">
                <Icone nome={ponto.tipo === 'endereco' ? 'check' : 'alert'} pequeno />
                {ponto.texto}
              </span>
              {ajustar}
            </dd>
          </div>
          <div>
            <dt>Entrega até</dt>
            <dd>
              <b>{km(raio)}</b> da loja
            </dd>
          </div>
          <div>
            <dt>Áreas de entrega</dt>
            <dd>
              {l.delivery_areas.length ? (
                <ul className="rg-tags" aria-label="Áreas de entrega">
                  {l.delivery_areas.map((a) => (
                    <li key={a}>{a}</li>
                  ))}
                </ul>
              ) : (
                <span>Nenhuma área ainda.</span>
              )}
              <span className="eixo-nota">{doPerfil ? 'Do Perfil do Google; tire ou acrescente em Editar (o Google não muda).' : 'Informadas por você.'}</span>
            </dd>
          </div>
        </dl>
        {/* O bloco existe sempre (o "Ver detalhes" aponta para ele); no Lite, fica escondido até abrir. */}
        <div id={detalhes} hidden={!mostraPro}>
          <dl className="rg-dl">
            <div>
              <dt>Coordenada</dt>
              <dd>
                <span className="num">{coordenadaTexto(l)}</span> · © <Osm />
              </dd>
            </div>
            <div>
              <dt>Precisão</dt>
              <dd>{precisaoPro(l)}</dd>
            </div>
            <div>
              <dt>Município</dt>
              <dd>
                {e.city} – {e.state} · código IBGE <span className="num">{e.ibge_city_code}</span> (ViaCEP)
              </dd>
            </div>
            <div>
              <dt>Endereço</dt>
              <dd>{doPerfil ? 'do Perfil da Empresa no Google' : 'pelo CEP, no ViaCEP, completado por você'}</dd>
            </div>
            <div>
              <dt>Salvo por</dt>
              <dd>{l.set_by && l.set_at ? `${l.set_by.name}, ${quandoComHora(l.set_at, agora)}` : l.set_at ? quandoComHora(l.set_at, agora) : '—'}</dd>
            </div>
          </dl>
        </div>
        <div className="rg-loja-acoes">
          {podeEditar && (
            <button className="btn btn--sm" type="button" onClick={() => abrir('editar', l.unit_id)} aria-haspopup="dialog">
              <Icone nome="pencil" pequeno />
              Editar
              <span className="sr-only"> {l.unit_name}</span>
            </button>
          )}
          {!pro && (
            <button className="detalhes-bt" type="button" onClick={alternar} aria-expanded={aberto} aria-controls={detalhes}>
              <span>{aberto ? 'Menos detalhes' : 'Ver detalhes'}</span>
              <Icone nome="chevron-down" pequeno />
            </button>
          )}
        </div>
      </div>
      <figure className="rg-mapa">
        <Aneis raio={raio} noBairro={ponto.tipo !== 'endereco'} id={`${ids}-aneis`} />
        <figcaption>
          <LegendaDosAneis raio={raio} />
          <p className="rg-osm">
            Ponto da loja: © <Osm /> · desenho em escala, sem o mapa de fundo
          </p>
        </figcaption>
      </figure>
    </li>
  );
}
