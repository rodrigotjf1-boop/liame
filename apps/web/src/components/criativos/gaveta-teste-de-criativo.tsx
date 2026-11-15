'use client';

import type { AdPieceResponse, BrandPhoto, CreativeTestOptionsResponse, CreativeTestResponse, NewCampaignOptionsResponse } from '@liame/contracts';
import Link from 'next/link';
import { type FormEvent, type RefObject, useEffect, useId, useRef, useState } from 'react';
import { Icone } from '@/components/ui/icone';
import { useDialogo } from '@/components/ui/use-dialogo';
import { api, chamar } from '@/lib/api';
import { disparar } from '@/lib/disparar';
import { BairrosDaCampanha } from './bairros-da-campanha';
import { dicaDoRaio, raiosDaLoja } from './campanha-nova-textos';
import { MidiasDoCriativo } from './midias-do-criativo';
import {
  type CampoDoTeste,
  type CamposDoTeste,
  conferirTeste,
  corpoDoTeste,
  efeitoDoTeste,
  erroDoPedidoDoTeste,
  linhaDoCupomNaPrevia,
  oQueImpedeAGaveta,
  reaisComCentavos as moeda,
  validadeDosCupons,
} from './teste-de-criativo-textos';

// A gaveta "Testar contra outra peça" (R8; D-RG-96, protótipo `prototipo-campanha-nova.html`, "Telas do teste"): o criativo A
// é a peça aberta; o B, outra peça aprovada da marca. Cada um com a sua foto ou vídeo de Fotos e o seu cupom; o desconto é o
// mesmo nos dois; quem vê e a verba do teste inteiro. "Pedir o teste" grava o pedido, que espera o código do app em
// Aprovações: nada é criado na Meta nem no Regem antes disso.

type Props = {
  brandId: string;
  /** A peça aberta: o criativo A. */
  peca: AdPieceResponse;
  /** As outras peças aprovadas da marca, para o criativo B. */
  outras: AdPieceResponse[];
  /** As fotos e os vídeos prontos de Fotos (nulo quando Fotos não abriu). */
  midias: BrandPhoto[] | null;
  opcoes: CreativeTestOptionsResponse;
  /** As lojas e o teto por campanha (as opções da campanha nova). */
  campanhas: NewCampaignOptionsResponse;
  /** Hoje no fuso da empresa (`AAAA-MM-DD`): até quando os cupons valem. */
  hoje: string;
  reserva?: RefObject<HTMLElement | null>;
  aoFechar: () => void;
  aoCriado: (t: CreativeTestResponse) => void;
};

export function GavetaTesteDeCriativo({ brandId, peca, outras, midias, opcoes, campanhas, hoje, reserva, aoFechar, aoCriado }: Props) {
  const ids = useId();
  const titulo = useRef<HTMLHeadingElement>(null);
  const corpo = useRef<HTMLDivElement>(null);
  const { ref, fechar, devolverFoco } = useDialogo({ focoInicial: titulo, reserva });
  const lojas = campanhas.units;
  const lojaInicial = lojas.find((u) => u.has_address && u.menu_available) ?? lojas.find((u) => u.has_address) ?? lojas[0] ?? null;
  const [campos, setCampos] = useState<CamposDoTeste>({
    pecaB: outras[0]?.id ?? null,
    midiaA: null,
    midiaB: null,
    cupomA: '',
    cupomB: '',
    tipo: 'percentual',
    valor: '10',
    minimo: '',
    nome: `Teste: ${peca.current.title}`.slice(0, 60),
    loja: lojaInicial?.id ?? null,
    quem: 'raio',
    raio: 3,
    bairros: [],
    verba: '40,00',
  });
  const [erro, setErro] = useState<{ campo: CampoDoTeste | null; texto: string } | null>(null);
  const [focoEm, setFocoEm] = useState<CampoDoTeste | 'erro' | null>(null);
  const [enviando, setEnviando] = useState(false);
  const [criado, setCriado] = useState<CreativeTestResponse | null>(null);

  const loja = lojas.find((u) => u.id === campos.loja) ?? null;
  const pecaB = outras.find((p) => p.id === campos.pecaB) ?? null;
  const impede = oQueImpedeAGaveta(opcoes, loja ? { id: loja.id, name: loja.name } : null);
  const raios = raiosDaLoja(loja);
  const teto = campanhas.campaign_cap_micros;

  // O campo com problema recebe o foco depois do desenho (os campos ficam desligados enquanto o pedido vai).
  useEffect(() => {
    if (!focoEm || enviando) return;
    const alvo = focoEm === 'erro' ? ref.current?.querySelector<HTMLElement>(`#${CSS.escape(`${ids}-erro`)}`) : ref.current?.querySelector<HTMLElement>(`[data-campo="${focoEm}"]`);
    alvo?.focus();
    setFocoEm(null);
  }, [focoEm, enviando, ref, ids]);
  useEffect(() => {
    if (criado) titulo.current?.focus();
  }, [criado]);

  const mudar = (parcial: Partial<CamposDoTeste>) => {
    setCampos((c) => ({ ...c, ...parcial }));
    setErro(null);
  };

  async function pedir(e: FormEvent) {
    e.preventDefault();
    if (impede || enviando) return;
    const problema = conferirTeste(campos, { pecaA: peca.id, tetoMicros: teto, variasLojas: lojas.length > 1 });
    if (problema) {
      setErro({ campo: problema.campo, texto: problema.erro });
      setFocoEm(problema.campo);
      return;
    }
    setEnviando(true);
    const r = await chamar(() => api.POST('/v1/creative-tests', { body: corpoDoTeste(campos, { brandId, pecaA: peca.id, loja: (loja ?? lojaInicial)!.id }) }));
    setEnviando(false);
    if (r.ok) {
      setCriado(r.data);
      aoCriado(r.data);
      return;
    }
    const recusa = erroDoPedidoDoTeste(r.problema);
    setErro(recusa);
    setFocoEm(recusa.campo ?? 'erro');
  }

  const erroDe = (campo: CampoDoTeste) => (erro?.campo === campo ? erro.texto : undefined);
  const invalido = (campo: CampoDoTeste) => (erro?.campo === campo ? true : undefined);
  const descrito = (campo: CampoDoTeste, dica: string) => (erro?.campo === campo ? `${dica} ${ids}-erro` : dica);

  const cabecalho = (
    <div className="dialogo-cab">
      <div className="dlg-titulo">
        <p className="rotulo-marca">Teste de criativo, pausado</p>
        <h2 id={`${ids}-t`} ref={titulo} tabIndex={-1}>
          {criado ? 'Pedido criado' : 'Testar contra outra peça'}
        </h2>
      </div>
      <button className="btn btn--icon btn--ghost" type="button" onClick={fechar} aria-label="Fechar" disabled={enviando}>
        <Icone nome="x" />
      </button>
    </div>
  );

  return (
    <dialog
      ref={ref}
      className="dialogo dialogo--lado p42-gaveta"
      aria-labelledby={`${ids}-t`}
      onClose={() => {
        aoFechar();
        devolverFoco();
      }}
      onClick={(e) => {
        if (e.target === ref.current && !enviando) fechar();
      }}
    >
      {criado ? (
        <div className="dialogo-form">
          {cabecalho}
          <div className="dialogo-corpo">
            <div className="pd-feito">
              <span className="vazio-ic vazio-ic--ok" aria-hidden="true">
                <Icone nome="check" />
              </span>
              <p>
                <b>Teste de criativo: {criado.name}.</b> Ele espera a aprovação com o código do app. Nada é criado na Meta nem no Regem antes disso.
              </p>
            </div>
          </div>
          <div className="dialogo-acoes">
            <button className="btn" type="button" onClick={fechar}>
              Fechar
            </button>
            {criado.action_id && (
              <Link className="btn btn--primary" href={`/aprovacoes?pedido=${criado.action_id}`}>
                Ver em Aprovações
              </Link>
            )}
          </div>
        </div>
      ) : (
        <form className="dialogo-form" onSubmit={(e) => disparar(pedir(e))} noValidate>
          {cabecalho}
          <div className="dialogo-corpo" ref={corpo}>
            {impede && (
              <div className="pd-aviso pd-aviso--perigo" role="alert">
                <Icone nome="alert-circle" pequeno />
                <div>
                  <b>{impede.titulo}</b>
                  <span id={`${ids}-impede`}>{impede.texto}</span>
                  {impede.contas && (
                    <Link className="btn btn--primary btn--sm" href="/contas">
                      Abrir Contas conectadas
                    </Link>
                  )}
                </div>
              </div>
            )}
            <p className="lite-frase">
              Dois criativos da mesma oferta rodam lado a lado, <b>com a mesma verba e o mesmo público</b>: só o criativo muda. Cada um tem o seu cupom, e <b>quem decide é o caixa</b>: os
              pedidos confirmados de cada um.
            </p>
            <div className="r8t-bracos">
              <section className="r8t-braco" aria-labelledby={`${ids}-a-t`}>
                <h3 id={`${ids}-a-t`}>
                  <span className="r8-letra" aria-hidden="true">
                    A
                  </span>{' '}
                  <span className="sr-only">Criativo A: </span>a peça aberta
                </h3>
                <div className="r8t-peca">
                  <b>{peca.current.title}</b>
                  <p>{peca.current.body}</p>
                </div>
                <MidiasDoCriativo id={`${ids}-ma`} letra="A" midias={midias} marcada={campos.midiaA} aoMarcar={(m) => mudar({ midiaA: m })} desligado={enviando} erro={erroDe('midiaA')} />
                <div className="campo">
                  <label htmlFor={`${ids}-ca`}>Cupom do criativo A</label>
                  <input
                    className="input"
                    id={`${ids}-ca`}
                    data-campo="cupomA"
                    autoComplete="off"
                    maxLength={20}
                    placeholder="Como SEXTAFOTO"
                    value={campos.cupomA}
                    onChange={(e) => mudar({ cupomA: e.target.value.toUpperCase() })}
                    disabled={enviando}
                    aria-invalid={invalido('cupomA')}
                    aria-describedby={descrito('cupomA', `${ids}-ca-d`)}
                  />
                  <p className="campo-dica" id={`${ids}-ca-d`}>
                    De 4 a 20 letras maiúsculas ou números.
                  </p>
                </div>
                <p className="r8t-linha">
                  O texto do anúncio termina com: <code>{linhaDoCupomNaPrevia(campos.cupomA, campos)}</code>
                </p>
              </section>
              <section className="r8t-braco" aria-labelledby={`${ids}-b-t`}>
                <h3 id={`${ids}-b-t`}>
                  <span className="r8-letra" aria-hidden="true">
                    B
                  </span>{' '}
                  <span className="sr-only">Criativo B: </span>a outra peça
                </h3>
                <div className="campo">
                  <label htmlFor={`${ids}-pb`}>A outra peça aprovada</label>
                  <select
                    className="input"
                    id={`${ids}-pb`}
                    data-campo="pecaB"
                    value={campos.pecaB ?? ''}
                    onChange={(e) => mudar({ pecaB: e.target.value || null })}
                    disabled={enviando}
                    aria-invalid={invalido('pecaB')}
                    aria-describedby={descrito('pecaB', `${ids}-pb-d`)}
                  >
                    {outras.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.current.title}
                      </option>
                    ))}
                  </select>
                  <p className="campo-dica" id={`${ids}-pb-d`}>
                    Só as peças aprovadas em Criativos.
                  </p>
                </div>
                {pecaB && (
                  <div className="r8t-peca">
                    <b>{pecaB.current.title}</b>
                    <p>{pecaB.current.body}</p>
                  </div>
                )}
                <MidiasDoCriativo id={`${ids}-mb`} letra="B" midias={midias} marcada={campos.midiaB} aoMarcar={(m) => mudar({ midiaB: m })} desligado={enviando} erro={erroDe('midiaB')} />
                <div className="campo">
                  <label htmlFor={`${ids}-cb`}>Cupom do criativo B</label>
                  <input
                    className="input"
                    id={`${ids}-cb`}
                    data-campo="cupomB"
                    autoComplete="off"
                    maxLength={20}
                    placeholder="Como SEXTAVIDEO"
                    value={campos.cupomB}
                    onChange={(e) => mudar({ cupomB: e.target.value.toUpperCase() })}
                    disabled={enviando}
                    aria-invalid={invalido('cupomB')}
                    aria-describedby={descrito('cupomB', `${ids}-cb-d`)}
                  />
                  <p className="campo-dica" id={`${ids}-cb-d`}>
                    Diferente do cupom do A.
                  </p>
                </div>
                <p className="r8t-linha">
                  O texto do anúncio termina com: <code>{linhaDoCupomNaPrevia(campos.cupomB, campos)}</code>
                </p>
              </section>
            </div>

            <fieldset className="campo">
              <legend>O desconto dos dois cupons</legend>
              <div className="pd-escolha">
                {(
                  [
                    ['percentual', 'Em %'],
                    ['valor', 'Em reais'],
                  ] as const
                ).map(([t, rotulo]) => (
                  <label key={t} className="pd-opcao">
                    <input type="radio" name={`${ids}-tipo`} value={t} checked={campos.tipo === t} onChange={() => mudar({ tipo: t, valor: t === 'percentual' ? '10' : '5,00' })} disabled={enviando} />
                    {rotulo}
                  </label>
                ))}
              </div>
              <div className="r8t-desconto">
                <div className="campo">
                  <label htmlFor={`${ids}-v`}>{campos.tipo === 'percentual' ? 'Desconto (%)' : 'Desconto (R$)'}</label>
                  <div className="pd-valor">
                    {campos.tipo === 'valor' && <span aria-hidden="true">R$</span>}
                    <input
                      id={`${ids}-v`}
                      data-campo="valor"
                      inputMode="decimal"
                      autoComplete="off"
                      maxLength={8}
                      value={campos.valor}
                      onChange={(e) => mudar({ valor: e.target.value })}
                      disabled={enviando}
                      aria-invalid={invalido('valor')}
                      aria-describedby={erro?.campo === 'valor' ? `${ids}-erro` : undefined}
                    />
                    {campos.tipo === 'percentual' && <span aria-hidden="true">%</span>}
                  </div>
                </div>
                <div className="campo">
                  <label htmlFor={`${ids}-m`}>
                    Pedido mínimo <span className="campo-dica">Opcional.</span>
                  </label>
                  <div className="pd-valor">
                    <span aria-hidden="true">R$</span>
                    <input
                      id={`${ids}-m`}
                      data-campo="minimo"
                      inputMode="decimal"
                      autoComplete="off"
                      maxLength={10}
                      value={campos.minimo}
                      onChange={(e) => mudar({ minimo: e.target.value })}
                      disabled={enviando}
                      aria-invalid={invalido('minimo')}
                      aria-describedby={erro?.campo === 'minimo' ? `${ids}-erro` : undefined}
                    />
                  </div>
                </div>
              </div>
              <p className="campo-dica">
                O mesmo desconto nos dois: só o criativo muda. O Liame cria os dois cupons no Regem depois da aprovação, valendo até {validadeDosCupons(hoje)} (45 dias), e eles não deixam de valer quando o
                teste acaba.
              </p>
            </fieldset>

            <div className="campo">
              <label htmlFor={`${ids}-n`}>Nome do teste</label>
              <input
                className="input"
                id={`${ids}-n`}
                data-campo="nome"
                autoComplete="off"
                maxLength={60}
                value={campos.nome}
                onChange={(e) => mudar({ nome: e.target.value })}
                disabled={enviando}
                aria-invalid={invalido('nome')}
                aria-describedby={descrito('nome', `${ids}-n-d`)}
              />
              <p className="campo-dica" id={`${ids}-n-d`}>
                A campanha na Meta sai como “Teste · {campos.nome.trim() || '…'}”.
              </p>
            </div>

            {lojas.length > 1 && (
              <div className="campo">
                <label htmlFor={`${ids}-l`}>A loja</label>
                <select
                  className="input"
                  id={`${ids}-l`}
                  data-campo="loja"
                  value={campos.loja ?? ''}
                  onChange={(e) => mudar({ loja: e.target.value || null, bairros: [] })}
                  disabled={enviando}
                  aria-invalid={invalido('loja')}
                  aria-describedby={erro?.campo === 'loja' ? `${ids}-erro` : undefined}
                >
                  {lojas.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name}
                    </option>
                  ))}
                </select>
              </div>
            )}

            <fieldset className="campo">
              <legend>Quem vê os dois</legend>
              <div className="seg cn-quem" role="group" aria-label="Como escolher quem vê">
                {(
                  [
                    ['raio', 'Raio em volta da loja', 'compass'],
                    ['bairros', 'Bairros', 'map-pin'],
                  ] as const
                ).map(([q, rotulo, icone]) => (
                  <button key={q} type="button" aria-pressed={campos.quem === q} disabled={enviando || (loja !== null && !loja.has_address)} onClick={() => mudar({ quem: q })}>
                    <Icone nome={icone} pequeno />
                    {rotulo}
                  </button>
                ))}
              </div>
              {campos.quem === 'bairros' && loja ? (
                <BairrosDaCampanha
                  key={loja.id}
                  id={`${ids}-bairros`}
                  brandId={brandId}
                  loja={{ id: loja.id, name: loja.name }}
                  marcados={campos.bairros}
                  aoMudar={(bairros) => mudar({ bairros })}
                  desligado={enviando}
                  erro={erroDe('bairros')}
                />
              ) : (
                <>
                  <div className="pd-escolha">
                    {raios.map((r) => (
                      <label key={r.rotulo} className="pd-opcao">
                        <input type="radio" name={`${ids}-raio`} value={r.km} checked={campos.raio === r.km} disabled={enviando} aria-describedby={`${ids}-raio-d`} onChange={() => mudar({ raio: r.km })} />
                        {r.rotulo}
                      </label>
                    ))}
                  </div>
                  {loja && (
                    <span className="campo-dica" id={`${ids}-raio-d`}>
                      {dicaDoRaio(campos.raio, loja)} O mesmo público nos dois conjuntos.
                    </span>
                  )}
                </>
              )}
            </fieldset>

            <div className="campo">
              <label htmlFor={`${ids}-vb`}>Verba diária do teste inteiro</label>
              <div className="pd-valor">
                <span aria-hidden="true">R$</span>
                <input
                  id={`${ids}-vb`}
                  data-campo="verba"
                  inputMode="decimal"
                  autoComplete="off"
                  maxLength={10}
                  value={campos.verba}
                  onChange={(e) => mudar({ verba: e.target.value })}
                  disabled={enviando}
                  aria-invalid={invalido('verba')}
                  aria-describedby={descrito('verba', `${ids}-vb-d`)}
                />
              </div>
              <p className="campo-dica" id={`${ids}-vb-d`}>
                Metade para cada criativo, no mínimo R$ 10,00 cada. {teto === null ? 'A empresa ainda não definiu o teto por campanha.' : `Teto por campanha: ${moeda(teto)} por dia.`}
              </p>
            </div>

            {erro && (
              <p className="campo-erro" id={`${ids}-erro`} role="alert" tabIndex={-1}>
                {erro.texto}
              </p>
            )}
            <p className="pd-efeito" role="status">
              {efeitoDoTeste(campos.verba)}
            </p>
            <div className="pd-bloco">
              <p className="rotulo-marca">Como o teste anda</p>
              <ul className="r8t-notas">
                <li>
                  <Icone nome="pause" pequeno />
                  <span>Tudo nasce pausado: a campanha de teste, os dois conjuntos e os dois anúncios. Ativar é outro pedido, com outra aprovação.</span>
                </li>
                <li>
                  <Icone nome="clock" pequeno />
                  <span>O Liame olha no fim de cada semana inteira (os dias 7, 14, 21 e 28) e só dá vencedor quando a diferença não cabe no acaso. Em 28 dias o teste acaba, com ou sem vencedor.</span>
                </li>
                <li>
                  <Icone nome="users" pequeno />
                  <span>Não é o teste dividido da Meta: os dois conjuntos disputam o mesmo público, e a mesma pessoa pode ver os dois anúncios. O cupom de cada um diz de qual anúncio veio o pedido.</span>
                </li>
                <li>
                  <Icone nome="sliders" pequeno />
                  <span>Enquanto o teste roda, a campanha de teste fica fora do ritmo da semana.</span>
                </li>
                <li>
                  <Icone nome="shield" pequeno />
                  <span>O pedido vai para Aprovações, com o código do app.</span>
                </li>
              </ul>
            </div>
          </div>
          <div className="dialogo-acoes">
            <button className="btn" type="button" onClick={fechar} disabled={enviando}>
              Cancelar
            </button>
            {/* `aria-disabled` e não `disabled`: o botão desligado perderia o foco e o motivo lido junto. */}
            <button className="btn btn--primary" type="submit" aria-disabled={impede || enviando ? true : undefined} aria-describedby={impede ? `${ids}-impede` : undefined}>
              {enviando ? 'Pedindo…' : 'Pedir o teste'}
            </button>
          </div>
        </form>
      )}
    </dialog>
  );
}
