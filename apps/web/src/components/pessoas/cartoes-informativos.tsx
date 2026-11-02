import { Icone } from '@/components/ui/icone';

// Cartões fixos da tela (textos do protótipo aprovado).

const PROTECAO = [
  'O convite só funciona para o e-mail convidado e vence em 7 dias.',
  'Quem administra usa o próprio login, com app autenticador.',
  'Gasto acima do limite volta para você aprovar.',
  'Tudo o que cada pessoa faz fica registrado, e você recebe um resumo por semana.',
  'Você remove o acesso na hora, e a pessoa sai de todas as sessões.',
  'A conta é sempre sua: só o dono transfere a propriedade, muda a cobrança ou exclui a conta.',
];
/** A linha a mais, com as agências (P27): entra antes da última. */
const PROTECAO_AGENCIA = 'Uma agência só entra com o seu aceite, até onde você escolher, e sai quando você desfizer o vínculo.';

export function CartaoProtecao({ comAgencias = false }: { comAgencias?: boolean }) {
  const linhas = comAgencias ? [...PROTECAO.slice(0, -1), PROTECAO_AGENCIA, PROTECAO.at(-1)!] : PROTECAO;
  return (
    <article className="card anima" style={{ ['--i' as string]: 2 }} aria-labelledby="ap-t">
      <h2 className="card-titulo" id="ap-t">
        Como o seu acesso fica protegido
      </h2>
      <ul className="protecao">
        {linhas.map((t) => (
          <li key={t}>
            <Icone nome="check" pequeno />
            <span>{t}</span>
          </li>
        ))}
      </ul>
    </article>
  );
}

export function CartaoAgencia({ comAgencias = false }: { comAgencias?: boolean }) {
  if (comAgencias) {
    return (
      <article className="card anima" style={{ ['--i' as string]: 3 }} aria-labelledby="ag-t">
        <h2 className="card-titulo" id="ag-t">
          Agência ou consultor com time
        </h2>
        <p className="lite-frase">
          A agência pede para cuidar da conta pelo seu e-mail. Você escolhe até onde o time dela vai e o limite de gasto, vê cada
          pessoa pelo nome e desfaz o vínculo quando quiser. A cobrança fica sempre com você.
        </p>
      </article>
    );
  }
  return (
    <article className="card anima" style={{ ['--i' as string]: 3 }} aria-labelledby="ag-t">
      <h2 className="card-titulo" id="ag-t">
        Agência ou consultor com várias empresas
      </h2>
      <p className="lite-frase">
        A pessoa vê todas as empresas que a convidaram num só login e troca entre elas no seletor do alto do menu, como na conta de
        administrador do Google Ads. Cada dono continua mandando na sua.
      </p>
    </article>
  );
}

type Celula = ['sim' | 'nao' | 'parcial', string];
const LINHAS: [string, Celula[]][] = [
  ['Dono', [['sim', 'Sim'], ['sim', 'Sim'], ['sim', 'Sim'], ['sim', 'Sim'], ['sim', 'Sim'], ['sim', 'Sim']]],
  ['Administrador', [['sim', 'Sim'], ['parcial', 'Até o limite'], ['sim', 'Sim'], ['parcial', 'Sim, menos o dono'], ['parcial', 'Se você liberar'], ['nao', 'Não']]],
  ['Gestor', [['sim', 'Sim'], ['parcial', 'Até o limite'], ['sim', 'Sim'], ['nao', 'Não'], ['nao', 'Não'], ['nao', 'Não']]],
  ['Aprovador', [['sim', 'Sim'], ['parcial', 'Até o limite'], ['nao', 'Não'], ['nao', 'Não'], ['nao', 'Não'], ['nao', 'Não']]],
  ['Somente leitura', [['sim', 'Sim'], ['nao', 'Não'], ['nao', 'Não'], ['nao', 'Não'], ['nao', 'Não'], ['nao', 'Não']]],
  ['Só relatórios por e-mail', [['parcial', 'Por e-mail'], ['nao', 'Não'], ['nao', 'Não'], ['nao', 'Não'], ['nao', 'Não'], ['nao', 'Não']]],
];
const COLUNAS = ['Ver resultados', 'Aprovar', 'Operar campanhas e equipe', 'Convidar e remover pessoas', 'Cobrança', 'Transferir ou excluir a conta'];

export function TabelaNiveis({ comAgencias = false }: { comAgencias?: boolean }) {
  return (
    <article className="card anima" style={{ ['--i' as string]: 4, marginTop: 'var(--sp-4)' }} aria-labelledby="nv-t">
      <div className="card-cab">
        <div>
          <h2 id="nv-t">O que cada nível pode fazer</h2>
          <p className="card-sub">Os níveis seguem o modelo do Google Ads: a pessoa recebe só o que precisa.</p>
        </div>
      </div>
      <div className="table-wrap">
        <table className="tabela tabela-niveis">
          <caption className="sr-only">O que cada nível de acesso pode fazer</caption>
          <thead>
            <tr>
              <th scope="col">Nível</th>
              {COLUNAS.map((c) => (
                <th scope="col" key={c}>
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {LINHAS.map(([nivel, celulas]) => (
              <tr key={nivel}>
                <th scope="row">{nivel}</th>
                {celulas.map(([tipo, texto], i) => (
                  <td key={COLUNAS[i]} data-rot={COLUNAS[i]}>
                    <span className={tipo}>{texto}</span>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {comAgencias && (
        <p className="tabela-nota">
          Quem vem de uma agência segue a mesma tabela, até o nível que você deu à agência, com duas diferenças: nunca convida nem remove
          pessoas da sua empresa e nunca vê a cobrança, nem como Administrador.
        </p>
      )}
    </article>
  );
}
