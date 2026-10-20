'use client';

import type { AccountProvider, ConnectionResponse } from '@liame/contracts';
import { type FormEvent, type RefObject, useId, useRef, useState } from 'react';
import { Icone } from '@/components/ui/icone';
import { useDialogo } from '@/components/ui/use-dialogo';
import { api, chamar, mensagemDe } from '@/lib/api';
import { disparar } from '@/lib/disparar';
import { ehLojaDoPerfil, siteDaLoja } from './perfil-google';
import { avisoDeLigar, ehSiteDoSearchConsole, notaDaPrimeiraLeitura, subDaEscolhaDoSite } from './search-console';
import { botaoLigar, type ContaExistente, escolhiveis, gruposDaEscolha, idDaConta } from './textos';

// "Escolher contas" depois da autorização (protótipo aprovado): as contas que ela alcança, agrupadas
// por plataforma; as que já estão ligadas aparecem marcadas e travadas, menos as que a plataforma
// recusou antes ("desconectada"), que esta autorização reconecta, as que são lidas por uma autorização
// que vence antes desta (Google em fase de teste), que esta renova, e as da Meta lidas pela autorização de
// leitura quando esta é a de escrita (ERR-138). Uma chamada liga todas.

type Props = {
  conexao: ConnectionResponse;
  /** Contas já ligadas na empresa (para reconhecer as que esta autorização reconecta). */
  existentes: ContaExistente[];
  marca: string;
  reserva: RefObject<HTMLElement | null>;
  aoLigar: (texto: string) => void;
  aoFechar: () => void;
};

const chave = (provider: string, externalId: string) => `${provider}:${externalId}`;

export function DialogoEscolher({ conexao, existentes, marca, reserva, aoLigar, aoFechar }: Props) {
  const primeira = useRef<HTMLInputElement>(null);
  const { ref, fechar, devolverFoco } = useDialogo({ focoInicial: primeira, reserva });
  const ids = useId();
  const opcoes = escolhiveis(conexao, existentes);
  const livres = opcoes.map((o) => o.conta);
  const reconectaveis = new Set(opcoes.filter((o) => o.reconectar).map((o) => chave(o.conta.provider, o.conta.external_id)));
  // Lidas hoje por uma autorização que vence antes desta: ligar aqui só troca a autorização (sem primeira leitura).
  const renovaveis = new Set(opcoes.filter((o) => o.renovar).map((o) => chave(o.conta.provider, o.conta.external_id)));
  // Lidas hoje por uma autorização sem a permissão de informar vendas ao Google, que esta inclui (A5, Y1): também só troca.
  const comPermissao = new Set(opcoes.filter((o) => o.permissao).map((o) => chave(o.conta.provider, o.conta.external_id)));
  // Lidas hoje pela autorização de leitura da Meta, e esta é a de escrita (ERR-138): também só troca.
  const comEscrita = new Set(opcoes.filter((o) => o.escrita).map((o) => chave(o.conta.provider, o.conta.external_id)));
  // A conta do RegemCast com o token novo da distribuição: também só troca.
  const tokenNovo = new Set(opcoes.filter((o) => o.token).map((o) => chave(o.conta.provider, o.conta.external_id)));
  const soTrocaA = (k: string) => renovaveis.has(k) || comPermissao.has(k) || comEscrita.has(k) || tokenNovo.has(k);
  // Reconectar já vem marcado; uma conta nova só, também. Várias novas: a pessoa escolhe (nada ligado sem querer).
  const [marcadas, setMarcadas] = useState<Set<string>>(() => {
    const iniciais = new Set(reconectaveis);
    if (livres.length === 1) iniciais.add(chave(livres[0]!.provider, livres[0]!.external_id));
    return iniciais;
  });
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState('');
  const grupos = gruposDaEscolha(conexao.discovered);
  const primeiraLivre = livres[0] ? chave(livres[0].provider, livres[0].external_id) : null;
  // Tudo o que há para ligar já é lido por outra autorização: ligar aqui só troca a autorização, sem primeira leitura.
  const soTroca = livres.length > 0 && livres.every((d) => soTrocaA(chave(d.provider, d.external_id)));
  // As lojas do perfil da empresa no Google (P17, parte B) e os sites do Search Console (P18, parte B) contam à parte no
  // botão, na nota e no aviso.
  const comLoja = livres.some((d) => ehLojaDoPerfil(d.provider));
  const comSite = livres.some((d) => ehSiteDoSearchConsole(d.provider));
  const comConta = livres.some((d) => !ehLojaDoPerfil(d.provider) && !ehSiteDoSearchConsole(d.provider));

  function alternar(k: string, marcar: boolean) {
    setMarcadas((atual) => {
      const nova = new Set(atual);
      if (marcar) nova.add(k);
      else nova.delete(k);
      return nova;
    });
  }

  async function ligar(e: FormEvent) {
    e.preventDefault();
    setErro('');
    const contas = livres.filter((d) => marcadas.has(chave(d.provider, d.external_id)));
    if (!contas.length) return;
    setEnviando(true);
    const r = await chamar(() =>
      api.POST('/v1/connections/{id}/accounts', {
        params: { path: { id: conexao.id } },
        body: { accounts: contas.map((d) => ({ provider: d.provider as AccountProvider, external_id: d.external_id })) },
      }),
    );
    setEnviando(false);
    if (!r.ok) return setErro(mensagemDe(r.problema));
    const ja = r.data.already_linked.length;
    const novas = r.data.linked.length;
    const soRenovou = novas > 0 && contas.every((d) => soTrocaA(chave(d.provider, d.external_id)));
    const ganhouPermissao = contas.some((d) => comPermissao.has(chave(d.provider, d.external_id)));
    const ganhouEscrita = contas.some((d) => comEscrita.has(chave(d.provider, d.external_id)));
    const lojasLigadas = r.data.linked.filter((a) => ehLojaDoPerfil(a.provider)).length;
    const sitesLigados = r.data.linked.filter((a) => ehSiteDoSearchConsole(a.provider)).length;
    aoLigar(
      novas && (comLoja || comSite) && !soRenovou
        ? `${avisoDeLigar({ contas: novas - lojasLigadas - sitesLigados, lojas: lojasLigadas, sites: sitesLigados }, { lojas: comLoja, sites: comSite })}${
            ja ? ` ${ja === 1 ? '1 já estava ligada' : `${ja} já estavam ligadas`} a uma marca.` : ''
          }`
        : !novas
        ? `Nada novo: ${ja === 1 ? 'a conta já estava ligada' : 'as contas já estavam ligadas'} a uma marca.`
        : soRenovou && ganhouEscrita
          ? `${novas === 1 ? 'A conta passou' : 'As contas passaram'} para a autorização nova da Meta: o Liame pode pedir mudanças de verba, pausar e retomar, sempre com a aprovação de uma pessoa. A leitura segue sem parar.`
          : soRenovou && ganhouPermissao
          ? `${novas === 1 ? 'A conta passou' : 'As contas passaram'} para a autorização nova, que inclui a permissão de informar vendas ao Google. A leitura segue sem parar.`
          : soRenovou
          ? `Autorização renovada: ${novas === 1 ? 'a conta passa' : 'as contas passam'} a ser ${novas === 1 ? 'lida' : 'lidas'} pela autorização nova. A leitura segue sem parar.`
          : `${novas === 1 ? 'Conta ligada' : 'Contas ligadas'}. A primeira leitura (90 dias) começou e leva alguns minutos.${
              ja ? ` ${ja === 1 ? '1 já estava ligada' : `${ja} já estavam ligadas`} a uma marca.` : ''
            }`,
    );
    fechar();
  }

  const n = marcadas.size;
  const lojasMarcadas = livres.filter((d) => ehLojaDoPerfil(d.provider) && marcadas.has(chave(d.provider, d.external_id))).length;
  const sitesMarcados = livres.filter((d) => ehSiteDoSearchConsole(d.provider) && marcadas.has(chave(d.provider, d.external_id))).length;
  return (
    <dialog
      ref={ref}
      className="dialogo"
      aria-labelledby={`${ids}-t`}
      onClose={() => {
        aoFechar();
        devolverFoco();
      }}
      onClick={(e) => {
        if (e.target === ref.current && !enviando) fechar();
      }}
    >
      <form className="dialogo-form" onSubmit={(e) => disparar(ligar(e))} noValidate>
        <div className="dialogo-cab">
          <h2 id={`${ids}-t`}>Escolher contas para {marca}</h2>
          <button className="btn btn--ghost btn--icon" type="button" onClick={fechar} aria-label="Fechar" disabled={enviando}>
            <Icone nome="x" />
          </button>
        </div>
        <div className="dialogo-corpo">
          {erro && (
            <p className="dialogo-erro" role="alert">
              <Icone nome="alert" pequeno />
              <span>{erro}</span>
            </p>
          )}
          {grupos.map((g) => (
            <fieldset className="campo" key={g.provider}>
              <legend>{g.titulo}</legend>
              {g.contas.map((d) => {
                const k = chave(d.provider, d.external_id);
                const reconectar = reconectaveis.has(k);
                const travada = d.linked && !reconectar;
                return (
                  <label className={`escolha${travada ? ' escolha--ligada' : ''}`} key={k}>
                    <input
                      ref={k === primeiraLivre ? primeira : undefined}
                      type="checkbox"
                      checked={travada || marcadas.has(k)}
                      disabled={travada || enviando}
                      onChange={(e) => alternar(k, e.target.checked)}
                    />
                    <span>
                      <b>{d.name}</b>
                      {ehLojaDoPerfil(d.provider) ? (
                        // A loja do perfil: o site que o perfil informa, no lugar do código do Google.
                        <span className="escolha-sub">{siteDaLoja(d.site)}</span>
                      ) : ehSiteDoSearchConsole(d.provider) ? (
                        // O site do Search Console: o domínio inteiro ou um endereço, e o acesso da conta do Google.
                        <span className="escolha-sub">{subDaEscolhaDoSite(d)}</span>
                      ) : (
                        <span className="mono">{idDaConta(d.provider, d.external_id)}</span>
                      )}
                    </span>
                    {d.via && <span className="lite-chip">via {d.via}</span>}
                    {travada && <span className="lite-chip">já ligada</span>}
                    {reconectar && !soTrocaA(k) && <span className="lite-chip lite-chip--perigo">desconectada: ligar de novo</span>}
                    {comEscrita.has(k) && <span className="lite-chip">passa a aceitar mudanças aprovadas</span>}
                    {tokenNovo.has(k) && <span className="lite-chip">passa para o token novo</span>}
                    {renovaveis.has(k) && <span className="lite-chip lite-chip--atraso">a autorização atual vence antes: renovar</span>}
                    {comPermissao.has(k) && !renovaveis.has(k) && (
                      <span className="lite-chip">{d.provider === 'google_ads' ? 'passa a poder informar vendas' : 'passa para esta autorização'}</span>
                    )}
                  </label>
                );
              })}
            </fieldset>
          ))}
          <p className="dialogo-nota">
            <Icone nome="clock" pequeno />
            <span>
              {soTroca
                ? 'Estas contas já são lidas pelo Liame. Ligar aqui só passa a leitura para a autorização nova: nada é desligado, e os números seguem sem parar.'
                : comLoja || comSite
                  ? notaDaPrimeiraLeitura({ contas: comConta, lojas: comLoja, sites: comSite })
                  : 'A primeira leitura traz os últimos 90 dias e leva alguns minutos. Depois, os números são atualizados todo dia.'}
            </span>
          </p>
        </div>
        <div className="dialogo-acoes">
          <button className="btn" type="button" onClick={fechar} disabled={enviando}>
            Agora não
          </button>
          <button className="btn btn--primary" type="submit" disabled={!n || enviando} aria-busy={enviando}>
            {enviando ? 'Ligando…' : botaoLigar(n, lojasMarcadas, sitesMarcados)}
          </button>
        </div>
      </form>
    </dialog>
  );
}
