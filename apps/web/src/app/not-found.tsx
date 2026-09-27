import type { Metadata } from 'next';

// Endereço que não existe. A página fica estática de propósito: ela entra na árvore de toda rota, e deixá-la
// dinâmica tiraria a pré-renderização das telas de entrada. Como rota desconhecida recebe a CSP com nonce
// do proxy, os scripts desta página não rodam: tudo aqui funciona sem JavaScript (link comum).
export const metadata: Metadata = { title: 'Página não encontrada · Liame' };

export default function NaoEncontrada() {
  return (
    <main className="tela-cheia">
      <div className="vazio">
        <h1>Página não encontrada</h1>
        <p>O endereço pode ter mudado ou não existe.</p>
        <a className="btn btn--primary" href="/">
          Voltar ao início
        </a>
      </div>
    </main>
  );
}
