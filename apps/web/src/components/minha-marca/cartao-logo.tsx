'use client';

import type { BrandLogoResponse } from '@liame/contracts';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { ConfirmaNaLinha } from '@/components/ui/confirma-na-linha';
import { Icone } from '@/components/ui/icone';
import { api, chamar, mensagemDe } from '@/lib/api';
import { disparar } from '@/lib/disparar';
import { enviarLogoDaMarca, problemaDaLogo } from './logo-da-marca';

// A logo do restaurante em Minha marca (A6 · Z15, parte 1; P43 aprovado em 11/11/2026; D-A6-138), no desenho da logo da
// agência (P29): a logo como o servidor guardou e como ela aparece no selo do vídeo montado; enviar, trocar e tirar,
// para quem edita Minha marca. O envio vale na hora (não espera "Salvar"): a logo é um arquivo só, conferido pelo servidor.

type Estado = { tipo: 'lendo' } | { tipo: 'ok'; dados: BrandLogoResponse } | { tipo: 'erro'; texto: string };

export function CartaoLogo({ brandId, nomeDaMarca, podeEditar, aoAvisar }: { brandId: string; nomeDaMarca: string; podeEditar: boolean; aoAvisar: (texto: string, tipo?: 'ok' | 'perigo') => void }) {
  const ids = useId();
  const arquivo = useRef<HTMLInputElement>(null);
  const [estado, setEstado] = useState<Estado>({ tipo: 'lendo' });
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [tirando, setTirando] = useState(false);

  const ler = useCallback(async () => {
    const r = await chamar(() => api.GET('/v1/brands/{id}/logo', { params: { path: { id: brandId } } }));
    setEstado(r.ok ? { tipo: 'ok', dados: r.data } : { tipo: 'erro', texto: mensagemDe(r.problema) });
  }, [brandId]);

  useEffect(() => {
    setEstado({ tipo: 'lendo' });
    setErro(null);
    disparar(ler());
  }, [ler]);

  async function escolher(f: File | undefined) {
    if (!f) return;
    const problema = problemaDaLogo(f);
    if (problema) {
      setErro(problema);
      arquivo.current?.focus();
      return;
    }
    setErro(null);
    setEnviando(true);
    const r = await enviarLogoDaMarca(brandId, f);
    setEnviando(false);
    if (!r.ok) {
      setErro(mensagemDe(r.problema));
      arquivo.current?.focus();
      return;
    }
    setEstado({ tipo: 'ok', dados: r.data });
    aoAvisar('Logo guardada. O vídeo montado pode usar a logo a partir de agora.', 'ok');
  }

  async function tirar() {
    setEnviando(true);
    const r = await chamar(() => api.DELETE('/v1/brands/{id}/logo', { params: { path: { id: brandId } } }));
    setEnviando(false);
    setTirando(false);
    if (!r.ok) return setErro(mensagemDe(r.problema));
    await ler();
    aoAvisar('Logo tirada.', 'ok');
    arquivo.current?.focus();
  }

  const dados = estado.tipo === 'ok' ? estado.dados : null;
  const logo = dados?.logo ?? null;
  const iniciais = nomeDaMarca
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((x) => x.charAt(0).toLocaleUpperCase('pt-BR'))
    .join('');

  return (
    <article className="card mk-logo" aria-labelledby={`${ids}-t`} aria-busy={estado.tipo === 'lendo' || enviando || undefined}>
      <div className="mk-geral-linha">
        <div>
          <p className="rotulo-marca">Logo do restaurante</p>
          <p className="mk-geral-tit" id={`${ids}-t`}>
            {logo ? 'A logo que o Liame usa nos vídeos montados' : 'Ainda sem logo'}
          </p>
        </div>
      </div>
      {estado.tipo === 'erro' ? (
        <p className="nota" role="alert">
          <Icone nome="alert-circle" pequeno />
          <span>Não foi possível ler a logo. {estado.texto}</span>
        </p>
      ) : (
        <div className="logo-linha">
          {logo?.url ? (
            <>
              <img className="mk-logo-img" src={logo.url} alt={`Logo da ${nomeDaMarca}`} />
              <span className="mk-logo-selo" aria-label="Como a logo aparece no selo do vídeo">
                <img src={logo.url} alt="" />
              </span>
            </>
          ) : (
            <span className="logo-ag logo-ag--vazio" aria-hidden="true">
              {iniciais || <Icone nome="store" pequeno />}
            </span>
          )}
          <span className="lite-frase">
            {logo
              ? 'No vídeo montado, a logo vai num selo redondo, quando você liga a opção.'
              : 'Sem logo, o vídeo montado não oferece a opção da logo. As outras telas não mudam.'}
          </span>
        </div>
      )}
      {podeEditar && dados && (
        <div className="campo">
          <label htmlFor={`${ids}-arquivo`}>{logo ? 'Trocar a logo' : 'Enviar a logo'}</label>
          <input
            ref={arquivo}
            className="input input-arquivo"
            id={`${ids}-arquivo`}
            type="file"
            accept="image/png,image/jpeg"
            disabled={!dados.logo_available || enviando}
            onChange={(e) => {
              disparar(escolher(e.target.files?.[0]));
              e.target.value = '';
            }}
            aria-invalid={erro ? true : undefined}
            aria-describedby={`${ids}-dica${erro ? ` ${ids}-erro` : ''}`}
          />
          <span className="campo-dica" id={`${ids}-dica`}>
            {dados.logo_available
              ? 'PNG ou JPG, até 1 MB. SVG não: ele pode levar código. O Liame guarda uma cópia sobre fundo branco, até 512 × 512 px.'
              : 'O envio de logo não está disponível agora. Tente mais tarde.'}
          </span>
          {erro && (
            <span className="campo-erro" id={`${ids}-erro`} role="alert">
              {erro}
            </span>
          )}
          {enviando && (
            <span className="campo-dica" role="status">
              Enviando a logo…
            </span>
          )}
          {logo &&
            (tirando ? (
              <ConfirmaNaLinha
                texto="Tirar a logo? O vídeo montado deixa de oferecer a opção da logo."
                rotulo="Tirar a logo"
                rotuloOcupado="Tirando…"
                voltar="Manter"
                ocupado={enviando}
                aoConfirmar={() => disparar(tirar())}
                aoCancelar={() => setTirando(false)}
              />
            ) : (
              <button className="btn btn--ghost btn--sm mk-logo-tirar" type="button" onClick={() => setTirando(true)} disabled={enviando}>
                Tirar a logo
              </button>
            ))}
        </div>
      )}
    </article>
  );
}
