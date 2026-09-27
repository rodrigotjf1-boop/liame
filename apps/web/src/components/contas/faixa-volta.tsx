import { Icone } from '@/components/ui/icone';
import type { Faixa } from './textos';

// Faixa do topo na volta da plataforma (protótipo aprovado): escolher contas, conferindo e recusada.

type Props = {
  faixa: Faixa;
  aoEscolher: () => void;
  aoTentarDeNovo: (() => void) | null;
  aoConferirDeNovo: () => void;
};

export function FaixaVolta({ faixa, aoEscolher, aoTentarDeNovo, aoConferirDeNovo }: Props) {
  const classe = faixa.tipo === 'escolher' ? ' faixa--acao' : faixa.tipo === 'erro' ? ' faixa--perigo' : '';
  return (
    <div className={`faixa${classe}`} role={faixa.tipo === 'erro' ? 'alert' : 'status'}>
      <div className="faixa-ic" aria-hidden="true">
        {faixa.tipo === 'escolher' && <Icone nome="check" />}
        {faixa.tipo === 'erro' && <Icone nome="alert-circle" />}
        {faixa.tipo === 'conferindo' && <span className="girando" />}
        {faixa.tipo === 'demorando' && <Icone nome="clock" />}
      </div>
      <div className="faixa-txt">
        <b>{faixa.titulo}</b>
        <span>{faixa.texto}</span>
      </div>
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
    </div>
  );
}
