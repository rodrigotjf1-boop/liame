import type { AttentionItem } from '@liame/contracts';
import Link from 'next/link';
import { plataforma } from '@/components/contas/textos';
import { acaoDoAviso, gravidadeDe, oQueFazer, rotuloDaGravidade } from './textos';

// Um aviso de mídia (protótipo aprovado): gravidade, plataforma, o que aconteceu, o motivo e o que fazer.

type Props = {
  item: AttentionItem;
  podeVerContas: boolean;
  podeConectar: boolean;
  aoReconectar: () => void;
};

export function ItemAviso({ item, podeVerContas, podeConectar, aoReconectar }: Props) {
  const g = gravidadeDe(item.severity);
  const plat = item.provider ? plataforma(item.provider) : null;
  const acao = acaoDoAviso(item.kind);
  return (
    <li className="card aviso-midia" data-sev={g}>
      <div className="aviso-topo">
        <span className={`sev sev--${g}`}>{rotuloDaGravidade(g)}</span>
        {plat && <span className={`plat plat--${plat.classe}`}>{plat.nome}</span>}
      </div>
      <h2 className="aviso-titulo">{item.title}</h2>
      <p className="aviso-det">{item.detail}</p>
      <p className="aviso-fazer">
        <b>O que fazer:</b> {oQueFazer(item.action)}
      </p>
      {acao === 'abrir-contas' && podeVerContas && (
        <div className="seg-acoes">
          <Link className="btn btn--sm btn--primary" href="/contas">
            Abrir Contas conectadas
          </Link>
        </div>
      )}
      {acao === 'reconectar' && podeConectar && (
        <div className="seg-acoes">
          <button className="btn btn--sm" type="button" onClick={aoReconectar} aria-label={`Conectar de novo: ${item.title}`}>
            Conectar de novo
          </button>
        </div>
      )}
    </li>
  );
}
