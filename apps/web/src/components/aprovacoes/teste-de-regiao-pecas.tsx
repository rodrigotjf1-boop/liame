import { REGION_TEST_WEEKS_BEFORE, type RegionTestResponse } from '@liame/contracts';
import { bairrosAntesENoTeste, type LinhaDosBairros, reguaDaFaixa } from './teste-de-regiao-textos';

// As peças do teste de região em Aprovações (plano da região, R8; protótipo dos testes aprovado pelo dono em 13/11/2026;
// D-RG-102): a tabela dos pedidos por bairro (nas 4 semanas de antes, no pedido; antes e no teste, no resultado) e a régua
// da faixa do resultado. Sem animação: a régua aparece pronta.

const ANTES = 'Antes (por semana)';
const NO_TESTE = 'No teste (por semana)';

type PropsDaTabela = {
  /** O que o leitor de tela ouve antes da tabela (`caption`). */
  legenda: string;
  linhas: readonly LinhaDosBairros[];
  /** Os outros bairros somados: com eles, a tabela ganha a coluna "No teste (por semana)" e a linha de baixo (o resultado). */
  outros?: { antes: string; noTeste: string };
};

/**
 * Os pedidos por bairro, o do teste marcado. Sem `outros`, só as semanas de antes (o pedido); com `outros`, antes e no
 * teste, com os outros bairros somados embaixo. A tabela não rola de lado: o nome quebra a linha e, no espaço estreito, a
 * de três colunas vira um bloco por bairro (`r8-bairros`, em aprovacoes.css).
 */
export function TabelaDosBairros({ legenda, linhas, outros }: PropsDaTabela) {
  const noTeste = outros !== undefined;
  const sub = (alvo: boolean) => (alvo ? (noTeste ? 'sem anúncio no teste' : 'o bairro do teste') : noTeste ? 'com anúncio, como sempre' : 'segue com anúncio, para comparar');
  return (
    <div className="r8-envolve">
      <table className={noTeste ? 'tabela r8-tabela r8-ab r8-bairros' : 'tabela r8-tabela r8-ab'}>
        <caption className="sr-only">{legenda}</caption>
        <thead>
          <tr>
            <th scope="col">Bairro</th>
            <th scope="col" className="n">
              {ANTES}
            </th>
            {noTeste && (
              <th scope="col" className="n">
                {NO_TESTE}
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {linhas.map((b) => (
            <tr key={`${b.alvo ? 'alvo' : 'outro'}:${b.nome}`} className={b.alvo ? 'r8-frente' : undefined}>
              <th scope="row" className={b.alvo ? 'r8-frente' : undefined}>
                {b.nome}
                <small>{sub(b.alvo)}</small>
              </th>
              <td className={b.alvo ? 'n r8-frente' : 'n'} data-col={ANTES}>
                {b.antes}
              </td>
              {noTeste && (
                <td className={b.alvo ? 'n r8-frente' : 'n'} data-col={NO_TESTE}>
                  {b.noTeste}
                  {b.obs && <small>{b.obs}</small>}
                </td>
              )}
            </tr>
          ))}
        </tbody>
        {outros && (
          <tfoot>
            <tr>
              <th scope="row">Os outros bairros, somados</th>
              <td className="n" data-col={ANTES}>
                {outros.antes}
              </td>
              <td className="n" data-col={NO_TESTE}>
                {outros.noTeste}
              </td>
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}

/**
 * A tabela do resultado, "Os pedidos por bairro, antes e no teste": o bairro do teste primeiro, os de comparar que ficaram
 * na conta e os outros bairros somados. Nada sem a leitura dos dias do teste (`orders_during`).
 */
export function TabelaAntesENoTeste({ t }: { t: Pick<RegionTestResponse, 'district' | 'weeks' | 'days' | 'result'> }) {
  const a = bairrosAntesENoTeste(t);
  if (!a) return null;
  return (
    <TabelaDosBairros
      legenda={`Os pedidos de entrega por semana no caixa, por bairro: nas ${REGION_TEST_WEEKS_BEFORE} semanas antes do pedido e nos ${t.days} dias do teste`}
      linhas={a.linhas}
      outros={a.outros}
    />
  );
}

/**
 * A régua da faixa: de 0 ao fim da escala, a parte da faixa (de X a Y pedidos por semana) e o ponto mais provável. É uma
 * imagem com a frase para o leitor de tela; os rótulos de baixo repetem os números para quem vê. Nada sem a conta (`effect`).
 */
export function ReguaDaFaixa({ resultado }: { resultado: RegionTestResponse['result'] }) {
  const efeito = resultado?.effect;
  if (!efeito) return null;
  const r = reguaDaFaixa(efeito);
  return (
    <div className="r8-faixa" role="img" aria-label={r.rotulo}>
      <div className="r8-faixa-trilho">
        <span className="r8-faixa-parte" style={{ left: `${r.de}%`, width: `${r.largura}%` }} />
        <span className="r8-faixa-ponto" style={{ left: `${r.ponto}%` }} />
      </div>
      <div className="r8-faixa-rot">
        <span>0</span>
        <span>{r.meio}</span>
        <span>{r.fim}</span>
      </div>
    </div>
  );
}
