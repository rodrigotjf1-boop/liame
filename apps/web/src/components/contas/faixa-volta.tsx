import { Faixa } from '@/components/ui/faixa';
import { Icone } from '@/components/ui/icone';
import type { Faixa as FaixaDaVolta } from './textos';

// Faixa do topo na volta da plataforma (protótipo aprovado): escolher contas, conferindo e recusada.

type Props = {
  faixa: FaixaDaVolta;
  aoEscolher: () => void;
  aoTentarDeNovo: (() => void) | null;
  aoConferirDeNovo: () => void;
};

export function FaixaVolta({ faixa, aoEscolher, aoTentarDeNovo, aoConferirDeNovo }: Props) {
  return (
    <Faixa
      tipo={faixa.tipo === 'escolher' ? 'acao' : faixa.tipo === 'erro' ? 'perigo' : undefined}
      icone={
        <>
          {faixa.tipo === 'escolher' && <Icone nome="check" />}
          {faixa.tipo === 'erro' && <Icone nome="alert-circle" />}
          {faixa.tipo === 'conferindo' && <span className="girando" />}
          {faixa.tipo === 'demorando' && <Icone nome="clock" />}
        </>
      }
      titulo={faixa.titulo}
      texto={faixa.texto}
      acao={
        <>
          {faixa.tipo === 'escolher' && (
            <button className="btn btn--primary" type="button" onClick={aoEscolher}>
              Escolher contas
            </button>
          )}
          {faixa.tipo === 'erro' && aoTentarDeNovo && (
            <button className="btn" type="button" onClick={aoTentarDeNovo}>
              Tentar de novo
            </button>
          )}
          {faixa.tipo === 'demorando' && (
            <button className="btn" type="button" onClick={aoConferirDeNovo}>
              <Icone nome="refresh" />
              Conferir de novo
            </button>
          )}
        </>
      }
    />
  );
}
