import Link from 'next/link';
import type { ReactNode } from 'react';
import { Estado } from '@/components/ui/estado';
import { Faixa } from '@/components/ui/faixa';
import { Icone } from '@/components/ui/icone';
import { inteiro } from '@/lib/formato';
import type { Modo } from '@/lib/modo';
import type { CaixaDoTeto, ContaDaTela, Enviadas, MensagemDaLista, Selo } from './textos';

// O corpo da tela "Mensagens" para uma conta do RegemCast (protótipo P15): as faixas do que impede o envio, as três
// caixas do topo (a conta do WhatsApp, o teto de gasto e o que há pronto) e "O que foi enviado". Só desenha o que
// `contaDaTela` montou.

type Props = {
  conta: ContaDaTela;
  modo: Modo;
  podeVerContas: boolean;
  aoVer: (id: string) => void;
  aoTentarDeNovo: () => void;
};

export function SeloDaMensagem({ selo }: { selo: Selo }) {
  return (
    <span className={`st st--${selo.classe}`}>
      {selo.ponto && <span className="dot" aria-hidden="true" />}
      {selo.rotulo}
    </span>
  );
}

function AbrirContas({ pode }: { pode: boolean }) {
  if (!pode) return null;
  return (
    <div className="vazio-acoes">
      <Link className="btn btn--primary" href="/contas">
        Abrir Contas conectadas
      </Link>
    </div>
  );
}

function TentarDeNovo({ aoTentar, primario = true }: { aoTentar: () => void; primario?: boolean }) {
  return (
    <div className="vazio-acoes">
      <button className={primario ? 'btn btn--primary' : 'btn'} type="button" onClick={aoTentar}>
        <Icone nome="refresh" pequeno />
        Tentar de novo
      </button>
    </div>
  );
}

export function MensagensConteudo({ conta, modo, podeVerContas, aoVer, aoTentarDeNovo }: Props) {
  if (conta.tipo === 'sem_autorizacao') {
    return (
      <div className="card">
        <Estado icone="plug" titulo="Conecte o RegemCast de novo" acao={<AbrirContas pode={podeVerContas} />}>
          O RegemCast não aceitou a conexão desta conta: ela foi desligada lá, ou não vale mais. Enquanto isso, o Liame não lê as mensagens. {podeVerContas ? 'Conecte de novo em Contas conectadas.' : 'Quem conecta é quem cuida das contas da empresa.'}
        </Estado>
      </div>
    );
  }
  if (conta.tipo === 'sem_permissao') {
    return (
      <div className="card">
        <Estado icone="lock" titulo="A conexão com o RegemCast não deixa ler as mensagens" acao={<AbrirContas pode={podeVerContas} />}>
          O RegemCast está conectado, mas a permissão dada ao Liame não inclui ver as campanhas, os públicos, os modelos e o teto de gasto. Quem dá a permissão é o dono da conta, no RegemCast.
        </Estado>
      </div>
    );
  }
  if (conta.tipo === 'fora_do_ar') {
    return (
      <div className="card">
        <Estado icone="alert-circle" perigo titulo="Não foi possível ler as mensagens" acao={<TentarDeNovo aoTentar={aoTentarDeNovo} />}>
          O RegemCast não respondeu agora. Nada mudou; tente de novo em instantes.
        </Estado>
      </div>
    );
  }

  return (
    <div className="mens">
      {conta.avisos.map((a) => (
        <Faixa key={a.chave} tipo={a.tipo} icone={<Icone nome={a.icone} />} titulo={a.titulo} texto={a.texto} />
      ))}
      <div className="mens-topo">
        <div className="mens-caixa" id="mens-conta">
          <span>Conta do WhatsApp</span>
          <b>{conta.conta.selo ? <SeloDaMensagem selo={conta.conta.selo} /> : conta.conta.titulo}</b>
          <span>{conta.conta.sub}</span>
        </div>
        <CaixaDoTetoDeGasto teto={conta.teto} />
        <div className="mens-caixa" id="mens-pronto">
          <span>Pronto para usar</span>
          <b>{conta.pronto.titulo}</b>
          <span>{conta.pronto.sub}</span>
        </div>
      </div>
      <OQueFoiEnviado enviadas={conta.enviadas} modo={modo} aoVer={aoVer} aoTentarDeNovo={aoTentarDeNovo} />
    </div>
  );
}

function CaixaDoTetoDeGasto({ teto }: { teto: CaixaDoTeto }) {
  if (teto.tipo === 'texto') {
    return (
      <div className="mens-caixa" id="mens-teto">
        <span>Teto de gasto</span>
        <b>{teto.titulo}</b>
        <span>{teto.sub}</span>
      </div>
    );
  }
  return (
    <div className="mens-caixa" id="mens-teto">
      {teto.periodos.map((p) => (
        <div className="mens-periodo" key={p.chave}>
          <span>{p.rotulo}</span>
          <b className="num">{p.valor}</b>
          <div className={p.cheio ? 'mens-teto mens-teto--cheio' : 'mens-teto'} role="img" aria-label={p.descricao}>
            <i style={{ width: `${p.largura}%` }} />
          </div>
        </div>
      ))}
      <span>{teto.sub}</span>
      {teto.notas.map((n) => (
        <span key={n}>{n}</span>
      ))}
    </div>
  );
}

function Cartao({ children, sub }: { children: ReactNode; sub?: string }) {
  return (
    <article className="card" id="mens-enviadas" aria-labelledby="t-mens-env">
      <div className="card-cab">
        <div>
          <h2 id="t-mens-env">O que foi enviado</h2>
          {sub && <p className="card-sub">{sub}</p>}
        </div>
      </div>
      {children}
    </article>
  );
}

function OQueFoiEnviado({ enviadas, modo, aoVer, aoTentarDeNovo }: { enviadas: Enviadas; modo: Modo; aoVer: (id: string) => void; aoTentarDeNovo: () => void }) {
  if (enviadas.tipo === 'sem_permissao') {
    return (
      <Cartao>
        <Estado compacto icone="lock" titulo="A conexão com o RegemCast não deixa ler as campanhas">
          A permissão dada ao Liame não inclui ver as campanhas de mensagens. Quem dá a permissão é o dono da conta, no RegemCast.
        </Estado>
      </Cartao>
    );
  }
  if (enviadas.tipo === 'indisponivel') {
    return (
      <Cartao>
        <Estado compacto icone="alert-circle" perigo titulo="Não foi possível ler as campanhas agora" acao={<TentarDeNovo aoTentar={aoTentarDeNovo} primario={false} />}>
          O RegemCast não respondeu a esta leitura. Nada mudou; tente de novo em instantes.
        </Estado>
      </Cartao>
    );
  }
  if (enviadas.tipo === 'vazia') {
    return (
      <Cartao>
        <Estado compacto icone="send" titulo="Nenhuma mensagem enviada ainda">
          Quando uma campanha de mensagens do RegemCast começar a sair, o resultado fica aqui: quantas pessoas receberam, leram e responderam, e quantas falharam.
        </Estado>
        {enviadas.fora && <p className="eixo-nota">{enviadas.fora}</p>}
      </Cartao>
    );
  }

  return (
    <Cartao sub="As campanhas de mensagens que o RegemCast enviou por esta conta, das mais novas para as mais antigas.">
      {modo === 'lite' ? (
        <>
          <p className="lite-frase lite-frase--grande">
            {enviadas.frase.map((t, i) => (t.forte ? <b key={i}>{t.t}</b> : <span key={i}>{t.t}</span>))}
          </p>
          <ul className="mens-lista" aria-label="Mensagens enviadas">
            {enviadas.itens.map((m) => (
              <ItemDaLista key={m.id} m={m} aoVer={aoVer} />
            ))}
          </ul>
        </>
      ) : (
        <div className="table-wrap">
          <table className="tabela tabela--pilha">
            <caption className="sr-only">Mensagens enviadas, com o resultado de cada uma</caption>
            <thead>
              <tr>
                <th scope="col">Mensagem</th>
                <th scope="col" className="n">
                  Receberam
                </th>
                <th scope="col" className="n">
                  Leram
                </th>
                <th scope="col" className="n">
                  Responderam
                </th>
                <th scope="col" className="n">
                  Falharam
                </th>
                <th scope="col">
                  <span className="sr-only">Abrir</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {enviadas.itens.map((m) => (
                <tr key={m.id}>
                  <th scope="row">
                    {m.nome}
                    <span className="camp-canal">
                      <SeloDaMensagem selo={m.selo} />
                      {m.sob && <span>{m.sob}</span>}
                    </span>
                  </th>
                  <td className="n num" data-rot="Receberam">
                    {inteiro(m.receberam)}
                  </td>
                  <td className="n num" data-rot="Leram">
                    {inteiro(m.leram)}
                    {m.receberam > 0 && <span className="sub">{m.leramPct}% de quem recebeu</span>}
                  </td>
                  <td className="n num" data-rot="Responderam">
                    {inteiro(m.responderam)}
                  </td>
                  <td className="n num" data-rot="Falharam">
                    {inteiro(m.falharam)}
                  </td>
                  <td className="n mens-acao">
                    <BotaoVer m={m} aoVer={aoVer} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="eixo-nota">“Receberam” é a mensagem entregue, que é a que a Meta cobra. O Liame não vê o nome nem o telefone de ninguém.</p>
      {enviadas.mais && <p className="eixo-nota">{enviadas.mais}</p>}
      {enviadas.fora && <p className="eixo-nota">{enviadas.fora}</p>}
    </Cartao>
  );
}

function BotaoVer({ m, aoVer }: { m: MensagemDaLista; aoVer: (id: string) => void }) {
  return (
    <button className="btn btn--sm" type="button" data-mens-ver={m.id} onClick={() => aoVer(m.id)} aria-label={`Ver a mensagem ${m.nome}`}>
      Ver
    </button>
  );
}

function ItemDaLista({ m, aoVer }: { m: MensagemDaLista; aoVer: (id: string) => void }) {
  return (
    <li className="mens-item">
      <div className="mens-item-nome">
        <b>{m.nome}</b>
        <span>
          {[m.sob, `${inteiro(m.receberam)} ${m.receberam === 1 ? 'recebeu' : 'receberam'}`].filter(Boolean).join(' · ')}
        </span>
        {m.selo.rotulo !== 'Enviada' && (
          <span>
            <SeloDaMensagem selo={m.selo} />
          </span>
        )}
      </div>
      <div className="mens-item-valor">
        <b>{m.receberam > 0 ? `${inteiro(m.leram)} ${m.leram === 1 ? 'leu' : 'leram'} (${m.leramPct}%)` : 'Ninguém recebeu ainda'}</b>
        <span>
          {inteiro(m.responderam)} {m.responderam === 1 ? 'respondeu' : 'responderam'} · {inteiro(m.falharam)} {m.falharam === 1 ? 'falhou' : 'falharam'}
        </span>
      </div>
      <BotaoVer m={m} aoVer={aoVer} />
    </li>
  );
}
