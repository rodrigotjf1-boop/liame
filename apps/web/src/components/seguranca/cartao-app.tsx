'use client';

import type { SecuritySummaryResponse } from '@liame/contracts';
import { dataCompleta } from '@/lib/formato';
import { liberacao, type SituacaoApp } from './textos';

// Cartão "App autenticador" nas quatro situações do protótipo aprovado: entrou com o app (troca na
// hora), entrou com código de recuperação (pedido de 24 h), pedido feito (espera) e sem app.

type Props = {
  resumo: SecuritySummaryResponse;
  situacao: SituacaoApp;
  agora: Date;
  pedindo: boolean;
  aoTrocar: () => void;
  aoAtivar: () => void;
  aoPedirTroca: () => void;
};

export function CartaoApp({ resumo, situacao, agora, pedindo, aoTrocar, aoAtivar, aoPedirTroca }: Props) {
  const pedido = resumo.change_request ? liberacao(resumo.change_request.usable_after, agora) : null;
  return (
    <article className="card anima" style={{ ['--i' as string]: 1 }} aria-labelledby="t-app">
      <div className="card-cab">
        <div>
          <h2 id="t-app">App autenticador</h2>
          <p className="card-sub">O código de 6 dígitos que o app gera a cada 30 segundos.</p>
        </div>
        {resumo.mfa_enabled_since ? (
          <span className="st st--concluido">
            <span className="dot" aria-hidden="true" />
            Ativo desde {dataCompleta(resumo.mfa_enabled_since)}
          </span>
        ) : (
          <span className="st st--espera">
            <span className="dot" aria-hidden="true" />
            Não ativado
          </span>
        )}
      </div>

      {situacao === 'app' && (
        <>
          <p className="seg-txt">
            Trocou de celular? Com o app antigo ainda em mãos, a troca é na hora: você escaneia um QR novo e confirma com um código.
          </p>
          <div className="seg-acoes">
            <button className="btn" type="button" onClick={aoTrocar}>
              Trocar de celular
            </button>
          </div>
        </>
      )}

      {situacao === 'recuperacao' && (
        <>
          <p className="seg-txt">
            Sem o celular antigo, a troca precisa de um pedido: ele vale em 24 horas, e avisamos por e-mail para você poder cancelar se não
            foi você.
          </p>
          <div className="seg-acoes">
            <button className="btn btn--primary" type="button" onClick={aoPedirTroca} disabled={pedindo} aria-busy={pedindo}>
              {pedindo ? 'Pedindo…' : 'Pedir a troca do app'}
            </button>
          </div>
        </>
      )}

      {situacao === 'pedido' && pedido && (
        <>
          {pedido.liberado ? (
            <p className="seg-txt">
              <b>Pedido liberado.</b> Você já pode trocar o app autenticador. Não foi você? Troque a senha: isso cancela o pedido.
            </p>
          ) : (
            <p className="seg-txt">
              <b>Pedido feito.</b> A troca libera {pedido.quando}. Até lá, entre com os códigos de recuperação. Não foi você? Troque a senha:
              isso cancela o pedido.
            </p>
          )}
          <div className="seg-acoes">
            <button className="btn" type="button" disabled={!pedido.liberado} onClick={aoTrocar}>
              {pedido.liberado ? 'Trocar o app' : `Trocar o app (libera em ${pedido.falta})`}
            </button>
          </div>
        </>
      )}

      {situacao === 'sem-app' && (
        <>
          <p className="seg-txt">O seu nível não exige, mas o app protege a sua conta mesmo que a senha vaze. Leva um minuto.</p>
          <div className="seg-acoes">
            <button className="btn btn--primary" type="button" onClick={aoAtivar}>
              Ativar o app autenticador
            </button>
          </div>
        </>
      )}
    </article>
  );
}
