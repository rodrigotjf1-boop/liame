import type { RefObject } from 'react';
import { Icone, type NomeIcone } from '@/components/ui/icone';
import { AVISO_DE_NITIDEZ, type Fase, FALHA_DE_CONEXAO, RECUSA, type Recusa, terminou, tituloDoEnvio } from './textos';

// A lista do envio (P20): cada arquivo com a barra e o que aconteceu com ele (entrou; entrou com aviso; não entrou,
// com o motivo; não foi, com "Tentar de novo"). Fica no topo da tela até a pessoa fechar.

export type ItemDoEnvio = {
  id: string;
  nome: string;
  fase: Fase;
  pct: number;
  recusa?: Recusa;
  /** O que a pessoa lê quando o envio não foi (a conexão caiu, o servidor não guardou, com o código de rastreio). */
  falha?: string;
  /** A prévia do próprio arquivo (endereço `blob:` do navegador); nulo quando não é imagem. */
  previa: string | null;
};

type Props = {
  itens: ItemDoEnvio[];
  tituloRef: RefObject<HTMLHeadingElement | null>;
  aoTentarDeNovo: (id: string) => void;
  aoFechar: () => void;
};

function Situacao({ tipo, icone, texto }: { tipo?: 'perigo' | 'aviso' | 'ok'; icone?: NomeIcone; texto: string }) {
  return (
    <span className={`ft-fila-st${tipo ? ` ft-fila-st--${tipo}` : ''}`}>
      {icone && <Icone nome={icone} pequeno />}
      <span>{texto}</span>
    </span>
  );
}

function Barra({ nome, pct }: { nome: string; pct: number }) {
  return (
    <div className="ft-barra" role="progressbar" aria-label={`Envio de ${nome}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
      <span style={{ width: `${pct}%` }} />
    </div>
  );
}

function Linha({ item, aoTentarDeNovo }: { item: ItemDoEnvio; aoTentarDeNovo: (id: string) => void }) {
  let meio;
  if (item.fase === 'na_fila') meio = <Situacao texto="Na fila…" />;
  else if (item.fase === 'enviando')
    meio = (
      <>
        <Barra nome={item.nome} pct={item.pct} />
        <Situacao texto={`Enviando… ${item.pct}%`} />
      </>
    );
  else if (item.fase === 'conferindo')
    meio = (
      <>
        <Barra nome={item.nome} pct={100} />
        <Situacao texto="Conferindo a foto…" />
      </>
    );
  else if (item.fase === 'recusada') meio = <Situacao tipo="perigo" icone="ban" texto={RECUSA[item.recusa ?? 'nao_abre']} />;
  else if (item.fase === 'falhou') meio = <Situacao tipo="perigo" icone="alert-circle" texto={item.falha ?? FALHA_DE_CONEXAO} />;
  else if (item.fase === 'aviso') meio = <Situacao tipo="aviso" icone="alert" texto={AVISO_DE_NITIDEZ} />;
  else meio = <Situacao tipo="ok" icone="check-circle" texto="Entrou." />;
  return (
    <li className="ft-fila-item">
      <span className="ft-fila-mini" aria-hidden="true">
        {item.previa ? <img src={item.previa} alt="" /> : <Icone nome="file" />}
      </span>
      <span className="ft-fila-txt">
        <span className="ft-fila-nome">{item.nome}</span>
        {meio}
      </span>
      {item.fase === 'falhou' && (
        <button className="btn btn--sm" type="button" data-ft-de-novo-item={item.id} onClick={() => aoTentarDeNovo(item.id)}>
          <Icone nome="refresh" pequeno />
          Tentar de novo
          <span className="sr-only"> o envio de {item.nome}</span>
        </button>
      )}
    </li>
  );
}

export function FilaDoEnvio({ itens, tituloRef, aoTentarDeNovo, aoFechar }: Props) {
  if (!itens.length) return null;
  const fases = itens.map((i) => i.fase);
  return (
    <section className="ft-fila" aria-labelledby="ft-fila-t">
      <div className="ft-fila-cab">
        <h2 id="ft-fila-t" tabIndex={-1} ref={tituloRef}>
          {tituloDoEnvio(fases)}
        </h2>
        {fases.every(terminou) && (
          <button className="btn btn--sm btn--ghost" type="button" data-ft-limpar onClick={aoFechar}>
            Fechar a lista
          </button>
        )}
      </div>
      <ul className="ft-fila-lista">
        {itens.map((i) => (
          <Linha key={i.id} item={i} aoTentarDeNovo={aoTentarDeNovo} />
        ))}
      </ul>
    </section>
  );
}
