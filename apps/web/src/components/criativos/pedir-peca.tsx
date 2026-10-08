'use client';

import type { AdPieceOptionsResponse, CreateAdPieceRequest } from '@liame/contracts';
import Link from 'next/link';
import { type FormEvent, type RefObject, useEffect, useRef, useState } from 'react';
import { Icone } from '@/components/ui/icone';
import { useDialogo } from '@/components/ui/use-dialogo';
import type { Problema } from '@/lib/api';
import { disparar } from '@/lib/disparar';
import { anuncioNoPedido, DESTINOS, erroDaPeca, estimativaDoPedido, ofertaNoPedido, variacoesDoPedido } from './textos';

// "Pedir uma peça" (protótipo P10, na entrega do texto): a oferta de Minha marca, para onde o anúncio leva, quantas
// variações, de onde o Criativo parte e o que a peça precisa dizer ou evitar, com a estimativa do custo antes de pedir.
// Quem decide se o pedido entra é o servidor (regras de texto, limite de IA, um pedido por vez).

interface Props {
  opcoes: AdPieceOptionsResponse;
  /** O anúncio de referência já escolhido (o "Fazer variações" de um anúncio que vendeu). */
  anuncioInicial: string | null;
  reserva: RefObject<HTMLElement | null>;
  aoFechar: () => void;
  aoPedir: (corpo: Omit<CreateAdPieceRequest, 'brand_id'>) => Promise<Problema | null>;
}

export function DialogoPedirPeca({ opcoes, anuncioInicial, reserva, aoFechar, aoPedir }: Props) {
  const ofertas = opcoes.offers.map(ofertaNoPedido);
  const primeira = ofertas.find((o) => !o.impedida) ?? null;
  const quantidades = variacoesDoPedido(opcoes.limits);
  const campoDaOferta = useRef<HTMLSelectElement>(null);
  const paragrafoDoErro = useRef<HTMLParagraphElement>(null);
  const { ref, fechar, devolverFoco } = useDialogo({ focoInicial: campoDaOferta, reserva });
  const [oferta, setOferta] = useState(primeira?.texto ?? ofertas[0]?.texto ?? '');
  const [destino, setDestino] = useState<'cardapio' | 'whatsapp'>('cardapio');
  const [variacoes, setVariacoes] = useState(quantidades.includes(3) ? 3 : (quantidades[0] ?? opcoes.limits.variations_min));
  const [anuncio, setAnuncio] = useState(anuncioInicial && opcoes.reference_ads.some((a) => a.ad_id === anuncioInicial) ? anuncioInicial : '');
  const [instrucao, setInstrucao] = useState('');
  const [erro, setErro] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  const escolhida = ofertas.find((o) => o.texto === oferta) ?? null;
  const referencia = opcoes.reference_ads.find((a) => a.ad_id === anuncio) ?? null;
  const estimativa = estimativaDoPedido(opcoes.ai, opcoes.usd_brl, variacoes);

  // O foco vai para o erro depois que ele está na tela: pedido pelo estado, não por `requestAnimationFrame` (o quadro
  // pode chegar antes de o parágrafo existir, e o foco ficaria solto).
  const [focoNoErro, setFocoNoErro] = useState(0);
  useEffect(() => {
    if (focoNoErro) paragrafoDoErro.current?.focus({ preventScroll: true });
  }, [focoNoErro]);
  function falha(texto: string) {
    setErro(texto);
    setFocoNoErro((n) => n + 1);
  }

  async function enviar(e: FormEvent) {
    e.preventDefault();
    if (!escolhida) return falha('Escolha o que anunciar.');
    if (escolhida.impedida) return falha(escolhida.impedida);
    setErro(null);
    setEnviando(true);
    const problema = await aoPedir({ offer: escolhida.texto, destination: destino, variations: variacoes, ...(instrucao.trim() ? { instruction: instrucao.trim() } : {}), ...(anuncio ? { reference_ad_id: anuncio } : {}) });
    setEnviando(false);
    if (problema) falha(erroDaPeca(problema).texto);
  }

  return (
    <dialog
      ref={ref}
      id="dlg-peca"
      className="dialogo dialogo--largo"
      aria-labelledby="dlg-peca-t"
      onClose={() => {
        aoFechar();
        devolverFoco();
      }}
      onClick={(e) => {
        if (e.target === ref.current && !enviando) fechar();
      }}
    >
      <form className="dialogo-form" noValidate onSubmit={(e) => disparar(enviar(e))}>
        <div className="dialogo-cab">
          <div className="dlg-titulo">
            <p className="rotulo-marca">Criativo</p>
            <h2 id="dlg-peca-t">Pedir uma peça</h2>
          </div>
          <button className="btn btn--ghost btn--icon" type="button" onClick={fechar} aria-label="Fechar" disabled={enviando}>
            <Icone nome="x" />
          </button>
        </div>
        <div className="dialogo-corpo" id="peca-corpo">
          <div className="campo">
            <label htmlFor="pp-oferta">O que anunciar</label>
            <select className="input" id="pp-oferta" ref={campoDaOferta} value={oferta} onChange={(e) => setOferta(e.target.value)} aria-describedby="pp-oferta-dica">
              {ofertas.map((o) => (
                <option key={o.texto} value={o.texto}>
                  {o.texto}
                  {o.impedida ? ' · não vai ao Criativo' : ''}
                </option>
              ))}
            </select>
            <p className="campo-dica" id="pp-oferta-dica">
              As ofertas vêm de Minha marca, com o preço que uma pessoa conferiu. O Criativo não inventa oferta nem preço.{' '}
              {escolhida?.impedida ? <b>{escolhida.impedida}</b> : escolhida?.semPreco ? 'Esta oferta não escreve um preço: a peça sai sem preço. ' : ''}
              <Link className="link-bt" href="/marca">
                Cadastrar outra oferta em Minha marca
              </Link>
            </p>
          </div>

          <fieldset className="campo">
            <legend>O que você quer</legend>
            <div className="pd-escolha">
              <label className="pd-opcao">
                <input type="radio" name="pp-tipo" value="texto-imagem" disabled />
                <Icone nome="image" />
                Texto e imagem
              </label>
              <label className="pd-opcao">
                <input type="radio" name="pp-tipo" value="texto" checked readOnly />
                <Icone nome="pencil" />
                Só o texto
              </label>
            </div>
            <p className="campo-dica">Por enquanto o Criativo faz só o texto. A imagem a partir da foto do seu produto chega numa próxima fase.</p>
          </fieldset>

          <fieldset className="campo">
            <legend>Para onde o anúncio leva</legend>
            <div className="pd-escolha">
              {(['cardapio', 'whatsapp'] as const).map((d) => (
                <label className="pd-opcao" key={d}>
                  <input type="radio" name="pp-destino" value={d} checked={destino === d} onChange={() => setDestino(d)} />
                  <Icone nome={d === 'cardapio' ? 'utensils' : 'message'} />
                  {DESTINOS[d]!.rotulo}
                </label>
              ))}
            </div>
          </fieldset>

          <fieldset className="campo">
            <legend>Quantas variações</legend>
            <div className="pd-escolha">
              {quantidades.map((q) => (
                <label className="pd-opcao" key={q}>
                  <input type="radio" name="pp-n" value={q} checked={variacoes === q} onChange={() => setVariacoes(q)} />
                  {q}
                </label>
              ))}
            </div>
          </fieldset>

          <div className="pd-bloco">
            <p className="rotulo-marca">De onde o Criativo parte</p>
            {opcoes.reference_ads.length > 0 && (
              <div className="campo">
                <label htmlFor="pp-anuncio">Um anúncio que já vendeu</label>
                <select className="input" id="pp-anuncio" value={anuncio} onChange={(e) => setAnuncio(e.target.value)}>
                  <option value="">Nenhum: só Minha marca</option>
                  {opcoes.reference_ads.map((a) => (
                    <option key={a.ad_id} value={a.ad_id}>
                      {anuncioNoPedido(a)}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <ul className="pp-partida">
              {referencia ? (
                <li>
                  <Icone nome="check" />
                  <span>
                    O anúncio <b>“{referencia.name}”</b>, com {referencia.orders} {referencia.orders === 1 ? 'pedido confirmado' : 'pedidos confirmados'} no caixa em 7 dias.
                  </span>
                </li>
              ) : (
                <li data-falta="">
                  <Icone nome="info" />
                  <span>{opcoes.reference_ads.length ? 'Sem anúncio de referência: o Criativo parte só de Minha marca.' : 'A marca ainda não tem anúncio com pedido confirmado nos últimos 7 dias. O Criativo parte só de Minha marca.'}</span>
                </li>
              )}
              <li>
                <Icone nome="check" />
                <span>
                  <b>Minha marca{opcoes.dossier_version ? ` (versão ${opcoes.dossier_version})` : ''}:</b> a voz da casa, a oferta e o que a marca não diz.
                </span>
              </li>
            </ul>
          </div>

          <div className="campo">
            <label htmlFor="pp-instr">
              Algo que a peça precisa dizer ou evitar? <span className="campo-dica">Opcional.</span>
            </label>
            <textarea className="area" id="pp-instr" rows={2} maxLength={opcoes.limits.instruction_max} placeholder="Ex.: fale da retirada no balcão" value={instrucao} onChange={(e) => setInstrucao(e.target.value)} aria-describedby="pp-erro" />
          </div>
          {erro && (
            <p className="campo-erro" id="pp-erro" ref={paragrafoDoErro} role="alert" tabIndex={-1}>
              {erro}
            </p>
          )}
          {estimativa && (
            <p className="pd-efeito" id="pp-custo" role="status">
              {estimativa}
            </p>
          )}
          <p className="pd-nota">
            <Icone nome="shield" />
            <span>Cada peça passa pela conferência antes de aparecer. Nenhum dado de cliente vai para o fornecedor de IA. Nada vai para a Meta por aqui.</span>
          </p>
        </div>
        <div className="dialogo-acoes">
          <button className="btn" type="button" onClick={fechar} disabled={enviando}>
            Cancelar
          </button>
          <button className="btn btn--primary" type="submit" disabled={enviando} aria-busy={enviando}>
            {enviando ? 'Pedindo…' : variacoes === 1 ? 'Pedir a peça' : 'Pedir as peças'}
          </button>
        </div>
      </form>
    </dialog>
  );
}
