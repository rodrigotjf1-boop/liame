'use client';

import type { BrandDossierContent, BrandPhraseHit, DossierSection, SystemProof } from '@liame/contracts';
import { type KeyboardEvent, useEffect, useId, useRef, useState } from 'react';
import { useAvisar } from '@/components/ui/avisos';
import { Icone } from '@/components/ui/icone';
import { api, chamar } from '@/lib/api';
import { disparar } from '@/lib/disparar';
import { acrescentar, alternarJeito, type ChaveDeLista, itensDaLista, JEITOS, MAX_JEITOS, REGRAS_LIAME, resultadoFalado, tirar } from './textos';

// Os campos de cada parte da marca (protótipo P6): os mesmos no editor (gaveta) e no preenchimento guiado.
// O texto que pode bater numa regra (a frase da identidade, o exemplo da voz) é conferido no servidor enquanto a
// pessoa escreve, com a lista de regras da marca que ela está editando (sem IA).

type Props = {
  secao: DossierSection;
  conteudo: BrandDossierContent;
  mudar: (c: BrandDossierContent) => void;
  provas: SystemProof[];
  marca: { id: string; nome: string };
  /** Anuncia para quem ouve a tela (o que foi adicionado, o resultado do teste). */
  anunciar: (texto: string) => void;
};

export function CamposDaSecao({ secao, conteudo, mudar, provas, marca, anunciar }: Props) {
  const c = conteudo;
  const proibidas = c.forbidden.items.map((i) => i.text);
  const texto = (campo: keyof BrandDossierContent['identity'] | 'do_example' | 'dont_example', valor: string) => {
    const n = structuredClone(c);
    if (campo === 'do_example' || campo === 'dont_example') n.voice[campo] = valor;
    else n.identity[campo] = valor;
    mudar(n);
  };

  switch (secao) {
    case 'identidade':
      return (
        <div className="mk-campos">
          <CampoTexto rotulo="Em uma frase" valor={c.identity.summary} max={240} aoMudar={(v) => texto('summary', v)} conferir={{ marca: marca.id, proibidas }} />
          <CampoTexto rotulo="Para quem" dica="Quem mais pede. Sem nome de cliente." valor={c.identity.audience} max={240} aoMudar={(v) => texto('audience', v)} />
          <CampoTexto rotulo="O que tem de diferente" valor={c.identity.differentiator} max={240} aoMudar={(v) => texto('differentiator', v)} />
          <CampoAno valor={c.identity.since} aoMudar={(v) => texto('since', v)} />
        </div>
      );
    case 'voz':
      return (
        <div className="mk-campos">
          <Jeitos conteudo={c} mudar={mudar} />
          <ListaEditavel chave="voice.rules" conteudo={c} mudar={mudar} rotulo="Regras de escrita" novo='Nova regra, como "Frases curtas."' anunciar={anunciar} />
          <CampoTexto rotulo="Exemplo de como sim" valor={c.voice.do_example} max={240} aoMudar={(v) => texto('do_example', v)} conferir={{ marca: marca.id, proibidas }} />
          <CampoTexto rotulo="Exemplo de como não" dica="O jeito que a marca nunca usa." valor={c.voice.dont_example} max={240} aoMudar={(v) => texto('dont_example', v)} />
        </div>
      );
    case 'provas':
      return (
        <div className="mk-campos">
          {provas.length > 0 && (
            <div className="campo">
              <span className="campo-rot">
                <b>Do caixa do Regem</b> <span className="campo-dica">Mudam sozinhas quando o número muda.</span>
              </span>
              <ul className="mk-lista">
                {provas.map((p) => (
                  <li className="fixo" key={p.text}>
                    <Icone nome="lock" pequeno />
                    <span>
                      {p.text}
                      <small>{p.source}</small>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <ListaEditavel chave="proof.stated" conteudo={c} mudar={mudar} rotulo="Informadas por você" novo='Nova prova, como "Nota 4,8 no iFood"' motivo="Onde dá para conferir" anunciar={anunciar} />
        </div>
      );
    case 'proibido':
      return (
        <div className="mk-campos">
          <div className="campo">
            <span className="campo-rot">
              <b>Regras da Liame</b> <span className="campo-dica">Valem para todas as marcas e não saem.</span>
            </span>
            <ul className="mk-lista">
              {REGRAS_LIAME.map((r) => (
                <li className="fixo" key={r.texto}>
                  <Icone nome="lock" pequeno />
                  <span>
                    {r.texto}
                    <small>{r.motivo}</small>
                  </span>
                </li>
              ))}
            </ul>
          </div>
          <ListaEditavel chave="forbidden.items" conteudo={c} mudar={mudar} rotulo={`Regras da ${marca.nome}`} novo='Frase ou palavra, como "o melhor do Rio"' motivo="Por quê" anunciar={anunciar} />
          <TesteDeFrase marca={marca.id} proibidas={proibidas} anunciar={anunciar} />
        </div>
      );
    case 'concorrentes':
      return (
        <div className="mk-campos">
          <ListaEditavel chave="competitors.items" conteudo={c} mudar={mudar} rotulo="Concorrentes" novo="Nome do concorrente" motivo="O que ele faz diferente" anunciar={anunciar} />
        </div>
      );
    case 'regiao':
      return (
        <div className="mk-campos">
          <CampoTexto
            rotulo="Onde entrega"
            dica="Bairros ou distância. Sem endereço de cliente."
            valor={c.region.area}
            max={240}
            aoMudar={(v) => {
              const n = structuredClone(c);
              n.region.area = v;
              mudar(n);
            }}
          />
          <label className="check">
            <input
              type="checkbox"
              checked={c.region.pickup}
              onChange={(e) => {
                const n = structuredClone(c);
                n.region.pickup = e.target.checked;
                mudar(n);
              }}
            />
            Tem retirada no balcão
          </label>
        </div>
      );
    case 'produtos':
      return (
        <div className="mk-campos">
          <ListaEditavel chave="products.items" conteudo={c} mudar={mudar} rotulo="Carros-chefe" novo="Novo produto" anunciar={anunciar} />
        </div>
      );
    case 'ofertas':
      return (
        <div className="mk-campos">
          <ListaEditavel chave="offers.items" conteudo={c} mudar={mudar} rotulo="Ofertas em vigor" novo="Nova oferta" anunciar={anunciar} />
        </div>
      );
    case 'datas':
      return (
        <div className="mk-campos">
          <ListaEditavel chave="seasonality.items" conteudo={c} mudar={mudar} rotulo="Datas e dias" novo="Nova data ou dia forte" anunciar={anunciar} />
        </div>
      );
  }
}

// ------------------------------------------------------------------ campos

function CampoTexto({
  rotulo,
  dica,
  valor,
  max,
  aoMudar,
  conferir,
}: {
  rotulo: string;
  dica?: string;
  valor: string;
  max: number;
  aoMudar: (v: string) => void;
  /** Confere o texto nas regras da Liame e da marca enquanto a pessoa escreve. */
  conferir?: { marca: string; proibidas: string[] };
}) {
  const id = useId();
  const hits = useConferencia(conferir ? valor : '', conferir?.marca ?? null, conferir?.proibidas ?? []);
  return (
    <div className="campo">
      <label htmlFor={id}>
        {rotulo}
        {dica && <span className="campo-dica"> {dica}</span>}
      </label>
      <textarea className="area" id={id} rows={2} maxLength={max} value={valor} onChange={(e) => aoMudar(e.target.value)} aria-describedby={hits.length ? `${id}-aviso` : undefined} />
      {hits.length > 0 && (
        <p className="mk-aviso" id={`${id}-aviso`} role="status">
          <Icone nome="alert" pequeno />
          <span>
            Bate numa regra ({hits.map((h) => `${h.owner === 'marca' ? `“${h.text}”` : h.text}${h.why ? `: ${h.why}` : ''}`).join('; ')}). Os funcionários de IA não vão repetir este trecho.
          </span>
        </p>
      )}
    </div>
  );
}

function CampoAno({ valor, aoMudar }: { valor: string; aoMudar: (v: string) => void }) {
  const id = useId();
  const ano = new Date().getFullYear();
  return (
    <div className="campo">
      <label htmlFor={id}>Desde que ano</label>
      <input
        className="input mk-ano"
        id={id}
        type="number"
        inputMode="numeric"
        min={1900}
        max={ano}
        value={valor}
        onChange={(e) => aoMudar(e.target.value.slice(0, 4))}
        aria-describedby={`${id}-dica`}
      />
      <p className="campo-dica" id={`${id}-dica`}>
        Quatro números, como {ano - 5}. Vazio, se não quiser dizer.
      </p>
    </div>
  );
}

function Jeitos({ conteudo, mudar }: { conteudo: BrandDossierContent; mudar: (c: BrandDossierContent) => void }) {
  const avisar = useAvisar();
  return (
    <fieldset className="campo">
      <legend>
        Jeitos de falar <span className="campo-dica">Até {MAX_JEITOS}.</span>
      </legend>
      <div className="mk-chips">
        {JEITOS.map((j) => (
          <button
            key={j}
            className="chip"
            type="button"
            aria-pressed={conteudo.voice.traits.includes(j)}
            onClick={() => {
              const r = alternarJeito(conteudo, j);
              if (r.erro) return avisar(r.erro, { tipo: 'perigo' });
              mudar(r.conteudo);
            }}
          >
            {j}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

/** Uma lista editável: o que já tem (com "Tirar") e a linha de adicionar, com o porquê quando a lista pede. */
function ListaEditavel({
  chave,
  conteudo,
  mudar,
  rotulo,
  novo,
  motivo,
  anunciar,
}: {
  chave: ChaveDeLista;
  conteudo: BrandDossierContent;
  mudar: (c: BrandDossierContent) => void;
  rotulo: string;
  novo: string;
  /** O rótulo do segundo campo (o porquê), quando a lista tem. */
  motivo?: string;
  anunciar: (texto: string) => void;
}) {
  const id = useId();
  const avisar = useAvisar();
  const [texto, setTexto] = useState('');
  const [porque, setPorque] = useState('');
  const campo = useRef<HTMLInputElement>(null);
  const itens = itensDaLista(conteudo, chave);

  function adicionar() {
    const r = acrescentar(conteudo, chave, { text: texto, why: porque });
    if (r.erro) {
      avisar(r.erro, { tipo: 'perigo' });
      return campo.current?.focus();
    }
    mudar(r.conteudo);
    anunciar(`Adicionado: ${texto.trim()}`);
    setTexto('');
    setPorque('');
    campo.current?.focus();
  }
  const enter = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    adicionar();
  };

  return (
    <div className="campo">
      <span className="campo-rot" id={`${id}-rot`}>
        <b>{rotulo}</b>
      </span>
      <ul className="mk-lista" aria-labelledby={`${id}-rot`}>
        {itens.length ? (
          itens.map((item, i) => (
            <li key={`${i}-${item.text}`}>
              <span>
                {item.text}
                {item.why ? <small>{item.why}</small> : null}
              </span>
              <button
                className="btn btn--sm btn--icon btn--ghost"
                type="button"
                aria-label={`Tirar ${item.text}`}
                onClick={() => {
                  mudar(tirar(conteudo, chave, i));
                  anunciar(`Tirado: ${item.text}`);
                  campo.current?.focus();
                }}
              >
                <Icone nome="minus" />
              </button>
            </li>
          ))
        ) : (
          <li className="fixo">
            <span className="mk-vazia-txt">Nada ainda.</span>
          </li>
        )}
      </ul>
      <div className={motivo ? 'mk-add mk-add--dupla' : 'mk-add'}>
        <label className="sr-only" htmlFor={`${id}-novo`}>
          {novo}
        </label>
        <input ref={campo} className="input" id={`${id}-novo`} maxLength={160} placeholder={novo} value={texto} onChange={(e) => setTexto(e.target.value)} onKeyDown={enter} />
        {motivo && (
          <>
            <label className="sr-only" htmlFor={`${id}-motivo`}>
              {motivo}
            </label>
            <input className="input" id={`${id}-motivo`} maxLength={200} placeholder={motivo} value={porque} onChange={(e) => setPorque(e.target.value)} onKeyDown={enter} />
          </>
        )}
        <button className="btn btn--sm" type="button" onClick={adicionar}>
          <Icone nome="plus" pequeno />
          Adicionar
        </button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ teste de frase

/** Testar uma frase nas regras da Liame e nas da marca (as que estão sendo editadas), sem IA. */
function TesteDeFrase({ marca, proibidas, anunciar }: { marca: string; proibidas: string[]; anunciar: (t: string) => void }) {
  const id = useId();
  const [frase, setFrase] = useState('');
  const [resultado, setResultado] = useState<{ hits: BrandPhraseHit[] } | { erro: string } | null>(null);
  const [testando, setTestando] = useState(false);

  async function testar() {
    const t = frase.trim();
    if (!t) return;
    setTestando(true);
    const r = await chamar(() => api.POST('/v1/brand-dossier/check', { body: { brand_id: marca, text: t, forbidden: proibidas } }));
    setTestando(false);
    if (!r.ok) {
      setResultado({ erro: 'Não deu para testar agora. Tente de novo em instantes.' });
      return;
    }
    setResultado({ hits: r.data.hits });
    anunciar(resultadoFalado(r.data.hits.length));
  }

  return (
    <div className="mk-teste">
      <div className="campo">
        <label htmlFor={id}>
          Testar uma frase <span className="campo-dica">Os funcionários de IA conferem assim antes de qualquer texto aparecer.</span>
        </label>
        <div className="mk-add">
          <input
            className="input"
            id={id}
            maxLength={300}
            placeholder="Escreva uma frase de anúncio"
            value={frase}
            onChange={(e) => setFrase(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return;
              e.preventDefault();
              disparar(testar());
            }}
          />
          <button className="btn btn--sm" type="button" onClick={() => disparar(testar())} disabled={testando}>
            Testar
          </button>
        </div>
      </div>
      <div aria-live="polite">
        {resultado && 'erro' in resultado && <p className="campo-erro">{resultado.erro}</p>}
        {resultado && 'hits' in resultado && resultado.hits.length === 0 && (
          <p className="mk-resultado mk-resultado--ok">
            <Icone nome="check-circle" pequeno /> Passa nas regras.
          </p>
        )}
        {resultado && 'hits' in resultado && resultado.hits.length > 0 && (
          <ul className="mk-resultado mk-resultado--ruim">
            {resultado.hits.map((h, i) => (
              <li key={i}>
                <Icone nome="ban" pequeno />
                <span>
                  <b>Não passa</b>: {h.owner === 'marca' ? `“${h.text}”` : h.text}
                  {h.why ? `: ${h.why}` : ''} · regra {h.owner === 'marca' ? 'da marca' : 'da Liame'}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/** Confere um texto nas regras enquanto a pessoa escreve (espera ela parar de digitar; sem IA). */
function useConferencia(texto: string, marca: string | null, proibidas: string[]): BrandPhraseHit[] {
  const [hits, setHits] = useState<BrandPhraseHit[]>([]);
  // A dependência do efeito é o texto da lista (o array muda a cada desenho).
  const lista = JSON.stringify(proibidas);
  useEffect(() => {
    const t = texto.trim();
    if (!marca || t.length < 3) {
      setHits([]);
      return;
    }
    let vivo = true;
    const espera = setTimeout(() => {
      disparar(
        chamar(() => api.POST('/v1/brand-dossier/check', { body: { brand_id: marca, text: t, forbidden: JSON.parse(lista) as string[] } })).then((r) => {
          // Sem resposta, o aviso some: quem garante é a conferência do servidor antes de qualquer texto aparecer.
          if (vivo) setHits(r.ok ? r.data.hits : []);
        }),
      );
    }, 600);
    return () => {
      vivo = false;
      clearTimeout(espera);
    };
  }, [texto, marca, lista]);
  return hits;
}
