'use client';

import { BRAND_SEARCH_TERMS, type BrandDossierContent, cleanSearchTerm, searchTermProblem, searchThemesStart } from '@liame/contracts';
import { type KeyboardEvent, useId, useRef, useState } from 'react';
import { Icone } from '@/components/ui/icone';
import { api, chamar } from '@/lib/api';
import { disparar } from '@/lib/disparar';

// Os termos de busca da loja na Identidade (R9; D-RG-98 a D-RG-100, protótipo `prototipo-marca.html`, "Termos de busca"):
// até 3, conferidos ao pôr pela mesma regra do servidor (o contrato) e pelo teste de frase (as regras da Liame e o que a
// marca não diz). O servidor confere de novo ao salvar. Embaixo, a prévia dos primeiros temas da campanha do Google.

type Props = {
  conteudo: BrandDossierContent;
  mudar: (c: BrandDossierContent) => void;
  marca: { id: string };
  anunciar: (texto: string) => void;
};

export function TermosDeBusca({ conteudo: c, mudar, marca, anunciar }: Props) {
  const id = useId();
  const campo = useRef<HTMLInputElement>(null);
  const [digitado, setDigitado] = useState('');
  const [erro, setErro] = useState('');
  const [nota, setNota] = useState('');
  const [conferindo, setConferindo] = useState(false);
  const termos = c.identity.search_terms;
  const cheio = termos.length >= BRAND_SEARCH_TERMS.max;

  const comTermos = (lista: string[]) => {
    const n = structuredClone(c);
    n.identity.search_terms = lista;
    return n;
  };

  async function adicionar() {
    if (conferindo) return;
    const { term, stripped } = cleanSearchTerm(digitado);
    const problema = searchTermProblem(term, { others: termos, competitors: c.competitors.items.map((i) => i.text) });
    if (problema) {
      setNota('');
      setErro(problema);
      return campo.current?.focus();
    }
    // As regras de texto, como o teste de frase (com a lista do que a marca não diz que está sendo editada). Sem resposta,
    // o termo entra: o servidor confere de novo ao salvar.
    setConferindo(true);
    const r = await chamar(() => api.POST('/v1/brand-dossier/check', { body: { brand_id: marca.id, text: term, forbidden: c.forbidden.items.map((i) => i.text) } }));
    setConferindo(false);
    const hit = r.ok ? r.data.hits[0] : undefined;
    if (hit) {
      setNota('');
      setErro(hit.owner === 'marca' ? `“${term}” bate no que a marca não diz (“${hit.text}”).` : `“${term}” bate numa regra da Liame (${hit.text}).`);
      return campo.current?.focus();
    }
    mudar(comTermos([...termos, term]));
    setErro('');
    setNota(stripped ? `O Liame já põe “perto de mim” e “delivery” nos temas: o termo ficou “${term}”.` : '');
    setDigitado('');
    anunciar(`Adicionado: ${term}`);
    campo.current?.focus();
  }

  const enter = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    disparar(adicionar());
  };

  const temas = searchThemesStart(termos);
  const descricao = [`${id}-dica`, erro ? `${id}-erro` : ''].filter(Boolean).join(' ');

  return (
    <div className="campo mk-termos">
      <span className="campo-rot" id={`${id}-rot`}>
        <b>Termos de busca da loja</b>{' '}
        <span className="campo-dica" id={`${id}-dica`}>
          Até {BRAND_SEARCH_TERMS.max}, com até {BRAND_SEARCH_TERMS.maxLength} letras cada: o que alguém digita no Google para achar uma casa como a sua. Sem nome de concorrente.
        </span>
      </span>
      <ul className="mk-lista" aria-labelledby={`${id}-rot`}>
        {termos.length ? (
          termos.map((t, i) => (
            <li key={`${i}-${t}`}>
              <span>{t}</span>
              <button
                className="btn btn--sm btn--icon btn--ghost"
                type="button"
                aria-label={`Tirar ${t}`}
                onClick={() => {
                  mudar(comTermos(termos.filter((_, j) => j !== i)));
                  setErro('');
                  setNota('');
                  anunciar(`Tirado: ${t}`);
                  // A linha de adicionar volta quando a lista sai do máximo: o foco vai para ela no próximo desenho.
                  requestAnimationFrame(() => campo.current?.focus());
                }}
              >
                <Icone nome="minus" />
              </button>
            </li>
          ))
        ) : (
          <li className="fixo">
            <span className="mk-vazia-txt">Nenhum termo ainda.</span>
          </li>
        )}
      </ul>
      {cheio ? (
        <p className="mk-termos-cheio">
          São {BRAND_SEARCH_TERMS.max} termos, o máximo. Tire um para pôr outro.
        </p>
      ) : (
        <div className="mk-add">
          <label className="sr-only" htmlFor={`${id}-novo`}>
            Novo termo de busca
          </label>
          <input
            ref={campo}
            className="input"
            id={`${id}-novo`}
            maxLength={BRAND_SEARCH_TERMS.maxLength + 20}
            placeholder="Como alguém procura, como “hambúrguer”"
            value={digitado}
            onChange={(e) => setDigitado(e.target.value)}
            onKeyDown={enter}
            aria-describedby={descricao}
            aria-invalid={erro ? true : undefined}
          />
          <button className="btn btn--sm" type="button" onClick={() => disparar(adicionar())} disabled={conferindo}>
            <Icone nome="plus" pequeno />
            {conferindo ? 'Conferindo…' : 'Adicionar'}
          </button>
        </div>
      )}
      {erro && (
        <p className="campo-erro" id={`${id}-erro`} role="alert">
          {erro}
        </p>
      )}
      {nota && (
        <p className="mk-info" role="status">
          <Icone nome="info" pequeno />
          <span>{nota}</span>
        </p>
      )}
      <div className="mk-termos-previa">
        <b>Na campanha do Google, os temas começam assim</b>
        {temas.length ? (
          <ul aria-label="Os primeiros temas de busca">
            {temas.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
        ) : (
          <span className="mk-vazia-txt">Sem termo, a campanha do Google começa só com a categoria do Perfil da Empresa no Google, quando o perfil está ligado.</span>
        )}
        <span className="campo-dica">Depois vêm os bairros de quem vê, escolhidos ao criar a campanha. Com o Perfil da Empresa no Google ligado, a categoria dele entra antes, sozinha. O tema é pista para o Google, não garantia.</span>
      </div>
    </div>
  );
}
