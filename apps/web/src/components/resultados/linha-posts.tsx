import Link from 'next/link';
import { Icone } from '@/components/ui/icone';
import { TextoRico } from './pecas';
import type { PostNaLista } from './posts';
import type { Frase } from './textos';

// A linha dos posts, no cartão "De onde vieram os pedidos" (mockups/prototipo-posts-resultados.html, A6 · P32, aprovado
// em 01/11/2026): quantos pedidos vieram pelo link dos posts e quanto isso deu no caixa, com o atalho para a Agenda. No
// Pro, embaixo, os posts que trouxeram pedido. Só aparece quando a marca tem post com o link no período (quem decide é
// o servidor); o atalho, só para quem pode abrir a Agenda.

export function LinhaPosts({ frase, posts = [], podeVerAgenda }: { frase: Frase; posts?: PostNaLista[]; podeVerAgenda: boolean }) {
  return (
    <>
      <p className="ms-linha ps-linha">
        <Icone nome="link" pequeno />
        <span>
          <TextoRico frase={frase} />
          {podeVerAgenda && (
            <>
              {' '}
              <Link href="/agenda">Ver na Agenda</Link>
            </>
          )}
        </span>
      </p>
      {posts.length > 0 && (
        <ul className="ps-posts" aria-label="Os posts que trouxeram pedido">
          {posts.map((p) => (
            <li key={p.id}>
              <span>
                {p.titulo}
                <small>{p.rede}</small>
              </span>
              <span className="num">{p.valor}</span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
