'use client';

import type { DirectAiSuggestionResponse } from '@liame/contracts';
import { useEffect, useRef, useState } from 'react';
import { Icone } from '@/components/ui/icone';
import { api, chamar } from '@/lib/api';
import { disparar } from '@/lib/disparar';
import { dicaDoPedido, erroDaSugestao, faltaDaSugestao, ficaramDeFora, semIaDoDirect } from './textos';

// A sugestão do Social media numa conversa que espera resposta (A6 · Z12, parte 4b-2b; P39; D-A6-110 e D-A6-145). A
// pessoa pede ("Pedir ao Social media"), o Liame devolve a sugestão já conferida, e "Usar esta" só põe o texto no campo
// da resposta: mandar continua com a pessoa, com o atendimento aberto. Nada é guardado: a sugestão vive nesta tela, e a
// conversa monta este painel de novo (vazio) quando a pessoa escreve outra mensagem.

type Aviso = { texto: string; deNovo: boolean };

type Props = {
  marca: string;
  conversa: string;
  /** `pergunta` ou `reclamacao`: a conversa só mostra este painel nesses dois. */
  tipo: string | null;
  /** Põe o texto no campo da resposta (a pessoa ainda lê, muda e manda). */
  aoUsar: (texto: string) => void;
  /** A conversa deixou de esperar resposta, ou saiu do Liame: a tela lê de novo. */
  aoReler: () => void;
};

export function SugestaoDoSocial({ marca, conversa, tipo, aoUsar, aoReler }: Props) {
  const [pedindo, setPedindo] = useState(false);
  const [dados, setDados] = useState<DirectAiSuggestionResponse | null>(null);
  /** O "Pedir outra" vale uma vez por mensagem (P39). */
  const [outra, setOutra] = useState(false);
  const [aviso, setAviso] = useState<Aviso | null>(null);
  const vivo = useRef(true);

  useEffect(() => {
    vivo.current = true;
    return () => {
      vivo.current = false;
    };
  }, []);

  async function pedir(deNovo: boolean) {
    if (pedindo) return;
    setPedindo(true);
    setAviso(null);
    // "Pedir outra": as que a pessoa já viu vão junto, para as novas serem outras.
    const previous = deNovo && dados ? dados.suggestions.map((s) => ({ focus: s.focus, text: s.text })) : [];
    const r = await chamar(() => api.POST('/v1/direct/conversations/{id}/suggestion', { params: { path: { id: conversa } }, body: { brand_id: marca, previous } }));
    if (!vivo.current) return;
    setPedindo(false);
    if (!r.ok) {
      const e = erroDaSugestao(r.problema);
      setAviso({ texto: e.texto, deNovo: e.deNovo });
      if (e.reler) aoReler();
      return;
    }
    if (r.data.origin !== 'ia' || r.data.suggestions.length === 0) {
      setAviso(semIaDoDirect(r.data));
      return;
    }
    setDados(r.data);
    if (deNovo) setOutra(true);
  }

  return <PainelDoSocial tipo={tipo} dados={dados} pedindo={pedindo} outra={outra} aviso={aviso} aoPedir={(deNovo) => disparar(pedir(deNovo))} aoUsar={aoUsar} />;
}

type Painel = {
  tipo: string | null;
  /** A sugestão na tela (a do Social media, já conferida); nula antes de pedir e quando ele não sugeriu. */
  dados: DirectAiSuggestionResponse | null;
  pedindo: boolean;
  /** Já pediu outra para esta mensagem. */
  outra: boolean;
  /** Por que não veio, e se vale pedir de novo. */
  aviso: Aviso | null;
  aoPedir: (deNovo: boolean) => void;
  aoUsar: (texto: string) => void;
};

/** O que a pessoa vê (sem estado, para o teste montar cada situação): o pedido, a espera, a sugestão e o porquê de não ter vindo. */
export function PainelDoSocial({ tipo, dados, pedindo, outra, aviso, aoPedir, aoUsar }: Painel) {
  const reclamacao = (dados?.kind ?? tipo) === 'reclamacao';
  const espera = pedindo && (
    <p className="dir-social-espera">
      <span className="girando" aria-hidden="true" />
      <span>O Social media está escrevendo, e o Compliance confere antes de chegar aqui.</span>
    </p>
  );
  const nota = aviso && !pedindo && (
    <p className="dir-social-aviso">
      <Icone nome="info" />
      <span>{aviso.texto}</span>
    </p>
  );

  // Ainda sem sugestão na tela: o botão de pedir, a espera ou o porquê de não ter vindo.
  if (!dados) {
    const podePedir = !aviso || aviso.deNovo;
    return (
      <div className="dir-social" aria-live="polite">
        {espera}
        {nota}
        {!pedindo && podePedir && (
          <div className="dir-social-pedir">
            <button className="btn btn--sm" type="button" onClick={() => aoPedir(false)}>
              <Icone nome="sparkles" pequeno />
              {aviso ? 'Pedir de novo' : 'Pedir ao Social media'}
            </button>
            {!aviso && <span className="campo-dica">{dicaDoPedido(tipo)}</span>}
          </div>
        )}
      </div>
    );
  }

  const falta = faltaDaSugestao(dados);
  const fora = ficaramDeFora(dados);
  const podeOutra = !outra && (!aviso || aviso.deNovo);
  return (
    <div className="dir-social" aria-live="polite">
      <div className="dir-sug" role="region" aria-label={reclamacao ? 'Sugestões do Social media' : 'Sugestão do Social media'}>
        <p className="dir-sug-cab">
          <Icone nome="sparkles" />
          <b>{reclamacao ? 'Sugestões do Social media' : 'Sugestão do Social media'}</b>
          {reclamacao ? (
            <span>escolha um jeito de responder</span>
          ) : (
            dados.answered && (
              <span className="dir-conferido">
                <Icone nome="check" />
                Conferido com Minha marca
              </span>
            )
          )}
        </p>
        {falta && (
          <p className="dir-falta">
            <Icone nome="alert" />
            <span>{falta}</span>
          </p>
        )}
        {reclamacao ? (
          <div className="dir-opcoes">
            {dados.suggestions.map((s) => (
              <div className="dir-opcao" key={`${s.focus}:${s.text}`}>
                <div className="dir-opcao-cab">
                  <b>{s.focus}</b>
                  {s.check === 'passou' ? (
                    <span className="dir-conferido">
                      <Icone nome="check" />
                      Conferido
                    </span>
                  ) : (
                    <span className="dir-confira">
                      <Icone nome="alert" />
                      Confira antes de mandar
                    </span>
                  )}
                </div>
                <p>{s.text}</p>
                <div>
                  <button className="btn btn--sm" type="button" disabled={pedindo} onClick={() => aoUsar(s.text)}>
                    Usar este
                  </button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="dir-sug-texto">{dados.suggestions[0]!.text}</p>
        )}
        {fora && <p className="campo-dica">{fora}</p>}
        {espera}
        {nota}
        {reclamacao && outra && !pedindo && <p className="campo-dica">Você já pediu outras sugestões para esta mensagem.</p>}
        {(!reclamacao || (podeOutra && !pedindo)) && (
          <div className="dir-sug-acoes">
            {!reclamacao && (
              <button className="btn btn--sm" type="button" disabled={pedindo} onClick={() => aoUsar(dados.suggestions[0]!.text)}>
                Usar esta
              </button>
            )}
            {podeOutra && !pedindo && (
              <button className="btn btn--sm btn--ghost" type="button" onClick={() => aoPedir(true)}>
                <Icone nome="refresh" pequeno />
                {reclamacao ? 'Pedir outras' : 'Pedir outra'}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
