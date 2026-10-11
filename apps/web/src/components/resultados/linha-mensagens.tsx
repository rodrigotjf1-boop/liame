import Link from 'next/link';
import { Icone } from '@/components/ui/icone';
import { TextoRico } from './pecas';
import type { Frase } from './textos';

// A linha das mensagens de WhatsApp, no cartão "De onde vieram os pedidos" (mockups/prototipo-mensagens-resultados.html,
// A5 · P15, parte C, aprovado em 10/10/2026): quantos pedidos vieram pelo cupom das mensagens e quanto isso deu no
// caixa, com o atalho para Mensagens. Só aparece quando a marca tem cupom de mensagem no período (quem decide é o
// servidor); o atalho, só para quem pode abrir a tela Mensagens.

export function LinhaMensagens({ frase, podeVerMensagens }: { frase: Frase; podeVerMensagens: boolean }) {
  return (
    <p className="ms-linha">
      <Icone nome="message" pequeno />
      <span>
        <TextoRico frase={frase} />
        {podeVerMensagens && (
          <>
            {' '}
            <Link href="/mensagens">Ver em Mensagens</Link>
          </>
        )}
      </span>
    </p>
  );
}
