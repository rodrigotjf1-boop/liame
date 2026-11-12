import type { RegionOverviewResponse } from '@liame/contracts';
import Link from 'next/link';
import { Icone } from '@/components/ui/icone';
import { Numero } from './numero';
import { diaEMes, inteiro } from './textos-da-regiao';

// O público nas redes (plano da região, R4, parte 3; P40, revisão R4-3 aprovada pelo dono em 12/11/2026, D-RG-40 a
// D-RG-43): os números da conta do Instagram e da Página da marca nas 4 semanas completas até ontem — os seguidores e
// como mudam, os toques nos botões do perfil, as visitas à Página e de que cidades são os seguidores do Instagram. Não
// são números de venda: quem vê Sua região vê. Nenhum seguidor aparece por nome.

type Publico = NonNullable<RegionOverviewResponse['social_audience']>;

/** "+214 em 4 semanas (287 seguiram, 73 deixaram de seguir)", com o que a leitura tiver. */
function mudancaEmFrase(r: { followers_change: number | null; follows: number | null; unfollows: number | null }): string | null {
  const partes: string[] = [];
  if (r.followers_change !== null) partes.push(`${r.followers_change > 0 ? '+' : ''}${inteiro(r.followers_change)} em 4 semanas`);
  if (r.follows !== null && r.unfollows !== null) {
    const detalhe = `${inteiro(r.follows)} ${r.follows === 1 ? 'seguiu' : 'seguiram'}, ${inteiro(r.unfollows)} ${r.unfollows === 1 ? 'deixou' : 'deixaram'} de seguir`;
    partes.push(partes.length ? `(${detalhe})` : detalhe);
  }
  return partes.length ? partes.join(' ') : null;
}

/** "98 em "como chegar", 31 em "ligar" e 17 em "mensagem"", só com os botões tocados. */
function toquesEmFrase(t: NonNullable<NonNullable<Publico['instagram']>['taps']>): string {
  const itens = [
    [t.directions, '“como chegar”'],
    [t.call, '“ligar”'],
    [t.message, '“mensagem”'],
    [t.other, 'outros botões'],
  ]
    .filter(([n]) => (n as number) > 0)
    .map(([n, b]) => `${inteiro(n as number)} em ${b}`);
  if (!itens.length) return 'nenhum toque nos botões do perfil';
  return itens.length === 1 ? itens[0]! : `${itens.slice(0, -1).join(', ')} e ${itens[itens.length - 1]}`;
}

export function PublicoNasRedes({ r, ids, mostraPro }: { r: RegionOverviewResponse; ids: string; mostraPro: boolean }) {
  if (r.social_audience_status === 'sem_endereco') return null;
  const p = r.social_audience;
  const titulo = `${ids}-publico`;
  const cab = (sub: string) => (
    <div className="rg-grupo-cab">
      <h3 id={titulo}>O público nas redes</h3>
      <p>{sub}</p>
    </div>
  );

  if (r.social_audience_status === 'sem_redes') {
    return (
      <section className="rg-grupo" aria-labelledby={titulo}>
        {cab('o Instagram e a Página da marca')}
        <p className="lite-frase">
          Com o Instagram e a Página do Facebook ligados, esta parte mostra os seguidores e como eles mudam, quem tocou em “ligar” e “como chegar” e de que cidades são os seguidores.
        </p>
        <p>
          <Link className="btn btn--sm" href="/contas">
            Ligar o Instagram e a Página
          </Link>
        </p>
      </section>
    );
  }
  if (r.social_audience_status === 'lendo' || !p) {
    return (
      <section className="rg-grupo" aria-labelledby={titulo}>
        {cab('o Instagram e a Página da marca')}
        <p className="lite-frase">Lendo o Instagram e a Página: a primeira leitura sai em alguns minutos, e depois uma vez por dia.</p>
      </section>
    );
  }

  const ig = p.instagram;
  const pg = p.page;
  const redes = ig && pg ? 'o Instagram e a Página da marca' : ig ? 'o Instagram da marca' : 'a Página da marca';
  return (
    <section className="rg-grupo" aria-labelledby={titulo}>
      {cab(`${redes}, 4 semanas até ontem (${diaEMes(p.to)})`)}
      <div className="rg-nums">
        {ig && ig.followers !== null && (
          <Numero
            valor={
              <>
                {inteiro(ig.followers)} <small>{ig.followers === 1 ? 'seguidor no Instagram' : 'seguidores no Instagram'}</small>
              </>
            }
            obs={mudancaEmFrase(ig) ?? `${ig.name}; quem seguiu e deixou de seguir aparece a partir de 100 seguidores`}
            fonte="Instagram · seguidores e quem seguiu ou deixou de seguir"
            pro="followers_count (a série guardada pelo Liame) · follows_and_unfollows (follow_type)"
            mostraPro={mostraPro}
          />
        )}
        {ig?.taps && (
          <Numero
            valor={
              <>
                {inteiro(ig.taps.total)} <small>{ig.taps.total === 1 ? 'toque no perfil' : 'toques no perfil'}</small>
              </>
            }
            obs={toquesEmFrase(ig.taps)}
            fonte="Instagram · toques nos botões do perfil"
            pro="profile_links_taps (contact_button_type)"
            mostraPro={mostraPro}
          />
        )}
        {pg && pg.followers !== null && (
          <Numero
            valor={
              <>
                {inteiro(pg.followers)} <small>{pg.followers === 1 ? 'seguidor na Página' : 'seguidores na Página'}</small>
              </>
            }
            obs={[mudancaEmFrase({ ...pg, follows: null, unfollows: null }), pg.views !== null ? `${inteiro(pg.views)} ${pg.views === 1 ? 'visita' : 'visitas'} à Página` : null].filter(Boolean).join('; ') || pg.name}
            fonte="Facebook · seguidores e visitas da Página"
            pro="followers_count · page_daily_follows_unique, page_daily_unfollows_unique · page_views_total"
            mostraPro={mostraPro}
          />
        )}
      </div>
      {ig && (
        <div>
          <h4>De que cidades são os seguidores (Instagram)</h4>
          {ig.cities_status === 'poucos_seguidores' ? (
            <p className="lite-frase">O Instagram só informa a cidade dos seguidores a partir de 100 seguidores.</p>
          ) : ig.cities_status === 'lendo' ? (
            <p className="lite-frase">Lendo a cidade dos seguidores: aparece depois da primeira leitura da conta.</p>
          ) : ig.cities.length === 0 ? (
            <p className="lite-frase">O Instagram ainda não informou a cidade dos seguidores.</p>
          ) : (
            <>
              <ul className="rg-cidades">
                {ig.cities.map((c) => (
                  <li key={c.full_name}>
                    <span>
                      <b>{c.name}</b>
                      {c.store_city && <small>o município da loja</small>}
                      {mostraPro && !c.store_city && <small>{c.full_name}</small>}
                    </span>
                    <span>{c.followers_pct !== null ? `${c.followers_pct}% dos seguidores` : `${inteiro(c.followers)} seguidores`}</span>
                  </li>
                ))}
              </ul>
              <p className="rg-nota">
                <Icone nome="info" pequeno />
                <span>As 45 cidades com mais seguidores, que o Instagram informa uma vez por semana. A Página do Facebook não informa mais a cidade: a Meta tirou essa métrica em 2025.</span>
              </p>
            </>
          )}
        </div>
      )}
      <p className="rg-nota">
        <Icone nome="users" pequeno />
        <span>Os seguidores de fora do raio de entrega não pedem: o plano de mídia mira o raio. Os números são da conta da marca, somados; nenhum seguidor aparece por nome.</span>
      </p>
    </section>
  );
}
