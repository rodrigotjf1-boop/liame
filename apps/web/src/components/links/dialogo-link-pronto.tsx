'use client';

import type { TrackingLink } from '@liame/contracts';
import { type RefObject, useId, useRef } from 'react';
import { useAvisar } from '@/components/ui/avisos';
import { Faixa } from '@/components/ui/faixa';
import { Icone } from '@/components/ui/icone';
import { useDialogo } from '@/components/ui/use-dialogo';
import { disparar } from '@/lib/disparar';
import { copiar } from './copiar';
import { baixar, pngDoQr, QrLink, svgDoQr } from './qr-link';
import { arquivoDoQr, classePlataforma, ondeColar, rotuloPlataforma, textoAnuncio } from './textos';

// "Link pronto" / "Parâmetros e QR" (protótipo P3): o link com rastreio, os parâmetros para colar no
// anúncio da plataforma da campanha e o QR para material impresso. O Liame não escreve nos anúncios.

type Props = {
  link: TrackingLink;
  /** Recém-criado (`true`), o mesmo que já existia (`false`) ou aberto da lista (`null`). */
  criado: boolean | null;
  reserva: RefObject<HTMLElement | null>;
  aoFechar: () => void;
};

export function DialogoLinkPronto({ link, criado, reserva, aoFechar }: Props) {
  const campoLink = useRef<HTMLInputElement>(null);
  const { ref, fechar, devolverFoco } = useDialogo({ focoInicial: campoLink, reserva });
  const avisar = useAvisar();
  const ids = useId();
  const loja = link.unit?.name ?? 'loja';
  const campanha = link.campaign?.name ?? 'a campanha do link';
  const onde = link.platform_params ? ondeColar(link.platform_params.field, link.provider, link.destination_url) : null;

  async function copiarTexto(texto: string, feito: string) {
    const ok = await copiar(texto);
    avisar(ok ? feito : 'Não deu para copiar: selecione o texto e copie à mão.', { tipo: ok ? 'ok' : 'perigo' });
  }

  async function baixarPng() {
    try {
      baixar(await pngDoQr(link.tracking_url), arquivoDoQr(link, 'png'));
      avisar('QR baixado em PNG.');
    } catch {
      avisar('Não deu para gerar o PNG. Tente o SVG.', { tipo: 'perigo' });
    }
  }

  function baixarSvg() {
    baixar(new Blob([svgDoQr(link.tracking_url)], { type: 'image/svg+xml' }), arquivoDoQr(link, 'svg'));
    avisar('QR baixado em SVG.');
  }

  return (
    <dialog
      ref={ref}
      className="dialogo dialogo--largo"
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
          <h2 id={`${ids}-t`}>{criado === null ? `${link.name}: parâmetros e QR` : `Link pronto: ${link.name}`}</h2>
          <button className="btn btn--ghost btn--icon" type="button" onClick={fechar} aria-label="Fechar">
            <Icone nome="x" />
          </button>
        </div>
        <div className="dialogo-corpo">
          {criado !== null && (
            <Faixa
              tipo="acao"
              icone={<Icone nome="check" />}
              titulo={criado ? 'Link criado' : 'Esse link já existia'}
              texto={`Código ${link.code} · campanha ${campanha} · ${link.ad ? `anúncio ${link.ad.name}` : 'todos os anúncios'}.`}
            />
          )}

          <div className="campo">
            <label htmlFor={`${ids}-link`}>Link com rastreio</label>
            <div className="copiar-linha">
              <input ref={campoLink} className="input" id={`${ids}-link`} readOnly value={link.tracking_url} onFocus={(e) => e.currentTarget.select()} />
              <button className="btn" type="button" onClick={() => disparar(copiarTexto(link.tracking_url, 'Link copiado.'))}>
                <Icone nome="copy" />
                Copiar link
              </button>
            </div>
            <p className="campo-dica">Para a bio, o WhatsApp da loja e o QR impresso. Destino: cardápio online da {loja}.</p>
          </div>

          {link.platform_params && onde && (
            <section className="param-bloco" aria-labelledby={`${ids}-plat`}>
              <h3 id={`${ids}-plat`}>
                <span className={classePlataforma(link.provider)}>{rotuloPlataforma(link.provider)}</span>
                {onde.titulo}
              </h3>
              <div className="param-codigo">
                <code>{link.platform_params.value}</code>
                <button className="btn btn--sm" type="button" onClick={() => disparar(copiarTexto(link.platform_params!.value, onde.copiado))}>
                  <Icone nome="copy" pequeno />
                  Copiar
                </button>
              </div>
              <p className="campo-dica">{onde.dica}</p>
            </section>
          )}

          <section className="qr-bloco" aria-labelledby={`${ids}-qr`}>
            <div className="qr-link">
              <QrLink texto={link.tracking_url} rotulo={`QR do link ${link.name}`} />
            </div>
            <div className="qr-txt">
              <h3 id={`${ids}-qr`}>QR para material impresso</h3>
              <p className="campo-dica">
                Ele abre o link com rastreio. Pedido feito pelo QR conta para a campanha {campanha} ({textoAnuncio(link).toLowerCase()}).
              </p>
              <div className="seg-acoes">
                <button className="btn btn--sm" type="button" onClick={() => disparar(baixarPng())}>
                  <Icone nome="download" pequeno />
                  Baixar PNG
                </button>
                <button className="btn btn--sm" type="button" onClick={baixarSvg}>
                  <Icone nome="download" pequeno />
                  Baixar SVG
                </button>
              </div>
            </div>
          </section>

          <p className="dialogo-nota">
            <Icone nome="info" pequeno />
            <span>O Liame não escreve na Meta nem no Google: você cola os parâmetros no anúncio. Na leitura da manhã seguinte, a conferência dos anúncios ativos mostra se ficou certo.</span>
          </p>
        </div>
        <div className="dialogo-acoes">
          <button className="btn btn--primary" type="button" onClick={fechar}>
            Pronto
          </button>
        </div>
      </div>
    </dialog>
  );
}
