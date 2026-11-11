'use client';

import type { RegionOverviewResponse, StoreLocation } from '@liame/contracts';
import { type RefObject, useId } from 'react';
import { Icone } from '@/components/ui/icone';
import { useDialogo } from '@/components/ui/use-dialogo';
import { useDetalhes } from '@/lib/modo';
import { Osm } from './aneis';
import { FONTES_DA_REGIAO, mesAno, situacaoEmPalavras, trimestre } from './textos-da-regiao';

// A gaveta "Ver as fontes" de Sua região (protótipo P40): cada número com a fonte, o recorte, o período, quando foi lido
// e, no Pro (ou em "Ver detalhes"), a consulta e de quanto em quanto renova. Os números ficam numa tabela do sistema; a
// empresa guarda só o recorte dela (D-RG-1).

const quando = (iso: string) => new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });

export function GavetaFontes({ loja, r, reserva, aoFechar }: { loja: StoreLocation; r: RegionOverviewResponse; reserva: RefObject<HTMLElement | null>; aoFechar: () => void }) {
  const ids = useId();
  const { ref, fechar, devolverFoco } = useDialogo({ reserva });
  const { pro, aberto, mostraPro, alternar } = useDetalhes();
  const salvo = loja.set_at ? `${quando(loja.set_at)}, ao salvar a loja` : 'ao salvar a loja';
  const periodo = (fonte: string): string => {
    const c = r.city;
    switch (fonte) {
      case 'ibge_censo_bairro':
        return '2022';
      case 'ibge_1737_censo':
        return mesAno('2022-07');
      case 'ibge_1737':
        return r.ipca ? mesAno(r.ipca.to) : '—';
      case 'ibge_7531':
        return c?.income_pc_uf?.period ?? '—';
      case 'ibge_7395':
        return c?.income_pc_rm?.period ?? '—';
      case 'ibge_6472':
        return c?.work_income_capital ? `${c.work_income_capital.quarters} trimestres até o ${trimestre(c.work_income_capital.period)}` : '—';
      case 'ibge_7060':
      case 'ibge_7060_brasil':
        return c?.food_away_inflation ? `12 meses até ${mesAno(c.food_away_inflation.period)}` : '—';
      case 'bcb_pix':
        return c?.pix ? mesAno(c.pix.period) : '—';
      case 'ibge_rm':
        return 'atual';
      default: {
        const numeros = c ? [c.population, c.population_estimate, c.income_pc_median, c.restaurants].filter((n) => n?.source === fonte) : [];
        return numeros[0]?.period ?? '—';
      }
    }
  };
  const recorte = (fonte: string, base: string) => (fonte === 'ibge_censo_bairro' && loja.address?.district ? `bairro (${loja.address.district}) e os bairros de ${loja.address.city}` : r.city ? `${base} (${r.city.name})` : base);

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
        if (e.target === ref.current) fechar();
      }}
    >
      <div className="dialogo-form">
        <div className="dialogo-cab">
          <div className="dlg-titulo">
            <p className="rotulo-marca">Sua região · {loja.unit_name}</p>
            <h2 id={`${ids}-t`}>As fontes da região</h2>
          </div>
          <button className="btn btn--icon btn--ghost" type="button" onClick={fechar} aria-label="Fechar">
            <Icone nome="x" />
          </button>
        </div>
        <div className="dialogo-corpo" id={`${ids}-lista`}>
          <p className="lite-frase">Cada fonte tem um endereço fixo, consultado pelo código do bairro e do município. Os números ficam numa tabela do sistema; a empresa guarda só o recorte dela.</p>
          <ul className="rg-fontes">
            <li className="rg-fonte">
              <div className="rg-fonte-cab">
                <b>Município, bairro e UF pelo CEP</b>
                <span className="st st--concluido">Em dia</span>
              </div>
              <dl className="rg-dl">
                <div>
                  <dt>Fonte</dt>
                  <dd>ViaCEP</dd>
                </div>
                <div>
                  <dt>Recorte</dt>
                  <dd>CEP da loja</dd>
                </div>
                <div>
                  <dt>Lido em</dt>
                  <dd>{salvo}</dd>
                </div>
                {mostraPro && (
                  <div>
                    <dt>Renova</dt>
                    <dd>a cada mudança do endereço</dd>
                  </div>
                )}
              </dl>
            </li>
            <li className="rg-fonte">
              <div className="rg-fonte-cab">
                <b>O ponto da loja no mapa</b>
                <span className="st st--concluido">Em dia</span>
              </div>
              <dl className="rg-dl">
                <div>
                  <dt>Fonte</dt>
                  <dd>
                    © <Osm /> (Nominatim), licença ODbL
                  </dd>
                </div>
                <div>
                  <dt>Recorte</dt>
                  <dd>o endereço da loja (só aqui; nunca vai para a IA)</dd>
                </div>
                <div>
                  <dt>Lido em</dt>
                  <dd>{salvo}</dd>
                </div>
              </dl>
            </li>
            {r.sources.map((s) => {
              const f = FONTES_DA_REGIAO[s.source];
              if (!f) return null;
              const st = situacaoEmPalavras(s);
              return (
                <li key={s.source} className={st.tipo === 'falhou' ? 'rg-fonte rg-fonte--falhou' : 'rg-fonte'}>
                  <div className="rg-fonte-cab">
                    <b>{f.dado}</b>
                    <span className={`st ${st.tipo === 'ok' ? 'st--concluido' : st.tipo === 'falhou' ? 'st--perigo' : 'st--info'}`}>{st.texto}</span>
                  </div>
                  <dl className="rg-dl">
                    <div>
                      <dt>Fonte</dt>
                      <dd>{f.fonte}</dd>
                    </div>
                    <div>
                      <dt>Recorte</dt>
                      <dd>{recorte(s.source, f.recorte)}</dd>
                    </div>
                    <div>
                      <dt>Período</dt>
                      <dd>
                        {s.source === 'ibge_censo_bairro' || s.source === 'ibge_10295'
                          ? `${periodo(s.source)} (valor de 2022${s.source === 'ibge_censo_bairro' && r.ipca ? `; a renda do bairro aparece corrigida pelo IPCA até ${mesAno(r.ipca.to)}` : ', sem correção'})`
                          : periodo(s.source)}
                      </dd>
                    </div>
                    <div>
                      <dt>Lido em</dt>
                      <dd>{s.read_at ? quando(s.read_at) : '—'}</dd>
                    </div>
                    {mostraPro && (
                      <>
                        <div>
                          <dt>Consulta</dt>
                          <dd className="num">{f.consulta}</dd>
                        </div>
                        <div>
                          <dt>Renova</dt>
                          <dd>{f.renova}</dd>
                        </div>
                      </>
                    )}
                  </dl>
                </li>
              );
            })}
          </ul>
          {!pro && (
            <button className="detalhes-bt" type="button" onClick={alternar} aria-expanded={aberto}>
              <span>{aberto ? 'Menos detalhes' : 'Ver detalhes'}</span>
              <Icone nome="chevron-down" pequeno />
            </button>
          )}
        </div>
        <div className="dialogo-acoes">
          <button className="btn" type="button" onClick={fechar}>
            Fechar
          </button>
        </div>
      </div>
    </dialog>
  );
}
