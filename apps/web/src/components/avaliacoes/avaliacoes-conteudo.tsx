import Link from 'next/link';
import { Estado } from '@/components/ui/estado';
import { Faixa } from '@/components/ui/faixa';
import { Icone } from '@/components/ui/icone';
import type { Aviso, ItemDaLista, Selo, TelaDasAvaliacoes } from './textos';

// O corpo da tela "Avaliações" (protótipo P17): o que falta para haver avaliações, ou as faixas da loja que parou de
// ser lida e da resposta que espera a aprovação, as três caixas do topo e a lista, com "Responder" e "Ver a resposta".
// Só desenha o que `telaDasAvaliacoes` montou: a resposta é escrita e aprovada em Aprovações.

type Props = {
  tela: TelaDasAvaliacoes;
  podeVerContas: boolean;
};

function AbrirContas({ pode, primario = true }: { pode: boolean; primario?: boolean }) {
  if (!pode) return null;
  return (
    <Link className={primario ? 'btn btn--primary' : 'btn'} href="/contas">
      Abrir Contas conectadas
    </Link>
  );
}

function AcoesDoEstado({ pode }: { pode: boolean }) {
  if (!pode) return null;
  return (
    <div className="vazio-acoes">
      <AbrirContas pode />
    </div>
  );
}

export function Estrelas({ n }: { n: number }) {
  const cheias = Math.max(0, Math.min(5, Math.round(n)));
  return (
    <span className="estrelas" role="img" aria-label={`${cheias} de 5 estrelas`}>
      {'★'.repeat(cheias)}
      <i>{'★'.repeat(5 - cheias)}</i>
    </span>
  );
}

function SeloDaResposta({ selo }: { selo: Selo }) {
  return (
    <span className={`st st--${selo.classe}`}>
      <span className="dot" aria-hidden="true" />
      {selo.rotulo}
    </span>
  );
}

function Avisos({ avisos, podeVerContas }: { avisos: Aviso[]; podeVerContas: boolean }) {
  return (
    <>
      {avisos.map((a) => (
        <Faixa key={a.chave} tipo={a.tipo} icone={<Icone nome={a.icone} />} titulo={a.titulo} texto={a.texto} acao={a.contas ? <AbrirContas pode={podeVerContas} primario={false} /> : undefined} />
      ))}
    </>
  );
}

function Item({ item }: { item: ItemDaLista }) {
  return (
    <li className="av-item">
      <div>
        <div className="av-item-cab">
          <Estrelas n={item.estrelas} />
          <span>{item.sob}</span>
        </div>
        <p className={item.texto ? 'av-item-txt' : 'av-item-txt av-item-txt--vazio'}>{item.texto ?? 'Só a nota, sem texto.'}</p>
      </div>
      <div className="av-item-acao">
        <SeloDaResposta selo={item.selo} />
        {item.acao?.tipo === 'ver' && (
          <Link className="btn btn--sm btn--primary" href={item.acao.href}>
            Ver a resposta
          </Link>
        )}
        {item.acao?.tipo === 'responder' && (
          <Link className="btn btn--sm" href={item.acao.href}>
            <Icone nome="pencil" pequeno />
            Responder
          </Link>
        )}
      </div>
    </li>
  );
}

export function AvaliacoesConteudo({ tela, podeVerContas }: Props) {
  if (tela.tipo === 'desligada') {
    return (
      <div className="card">
        <Estado icone="message" titulo="As avaliações do Google ainda não estão ligadas para esta empresa">
          Quem liga é a Liame, a pedido do dono. Com a função desligada, o Liame não lê nada do perfil da empresa no Google.
        </Estado>
      </div>
    );
  }
  if (tela.tipo === 'sem_perfil') {
    return (
      <div className="card">
        <Estado icone="plug" titulo="Conecte o perfil da empresa no Google" acao={<AcoesDoEstado pode={podeVerContas} />}>
          {`É o perfil que aparece no Google Maps e na busca, com as avaliações. Conectado, o Liame passa a ler as avaliações.${podeVerContas ? '' : ' Quem conecta é quem cuida das contas da empresa.'}`}
        </Estado>
      </div>
    );
  }
  if (tela.tipo === 'sem_permissao') {
    return (
      <div className="card">
        <Estado icone="lock" titulo="A autorização do Google não inclui o perfil da empresa" acao={<AcoesDoEstado pode={podeVerContas} />}>
          {`O Google está conectado para os anúncios, mas ler as avaliações pede uma permissão a mais. ${podeVerContas ? 'Autorize o Google de novo em Contas conectadas: as contas ligadas continuam como estão.' : 'Quem autoriza de novo é quem cuida das contas da empresa; as contas ligadas continuam como estão.'}`}
        </Estado>
      </div>
    );
  }
  if (tela.tipo === 'esperando_google') {
    return (
      <div className="card">
        <Estado icone="clock" titulo="O Google ainda não liberou o acesso ao perfil">
          O pedido de acesso foi feito e está em análise no Google, que não informa o prazo. Enquanto isso, o Liame não consegue ler as avaliações. Nada precisa ser feito: o Liame avisa em Atenção quando as lojas aparecerem, para você escolher.
        </Estado>
      </div>
    );
  }
  if (tela.tipo === 'outra') {
    return (
      <div className="card">
        <Estado icone="info" titulo="Não foi possível mostrar as avaliações">
          Esta tela recebeu do servidor uma situação que ela ainda não conhece. Atualize a página; se continuar assim, fale com a Liame.
        </Estado>
      </div>
    );
  }
  if (tela.tipo === 'primeira_leitura') {
    return (
      <div className="av">
        <Avisos avisos={tela.avisos} podeVerContas={podeVerContas} />
        <div className="card">
          <Estado icone="clock" titulo="A primeira leitura das avaliações ainda não terminou">
            O perfil da empresa no Google está ligado. Quando o Liame terminar de ler as avaliações dos últimos 12 meses, elas aparecem aqui.
          </Estado>
        </div>
      </div>
    );
  }
  if (tela.tipo === 'vazia') {
    return (
      <div className="av">
        <Avisos avisos={tela.avisos} podeVerContas={podeVerContas} />
        <div className="card">
          <Estado icone="message" titulo="Nenhuma avaliação ainda">
            Quando alguém avaliar a sua empresa no Google, a avaliação aparece aqui.
          </Estado>
        </div>
      </div>
    );
  }

  return (
    <div className="av">
      <Avisos avisos={tela.avisos} podeVerContas={podeVerContas} />
      {tela.esperando && (
        <Faixa
          tipo="acao"
          icone={<Icone nome="message" />}
          titulo={tela.esperando.titulo}
          texto={tela.esperando.texto}
          acao={
            <Link className="btn btn--primary" href={tela.esperando.href}>
              {tela.esperando.botao}
            </Link>
          }
        />
      )}
      {tela.tudoRespondido && <Faixa icone={<Icone nome="check-circle" />} titulo="Nenhuma avaliação sem resposta" texto="Quando chegar uma nova, ela aparece no topo da lista." />}
      <div className="av-topo">
        {tela.caixas.map((c) => (
          <div className="av-caixa" id={c.id} key={c.id}>
            <span>{c.rotulo}</span>
            <b className="num">{c.valor}</b>
            <span>{c.sub}</span>
          </div>
        ))}
      </div>
      <article className="card" id="av-lista" aria-labelledby="t-av-lista">
        <div className="card-cab">
          <div>
            <h2 id="t-av-lista">As avaliações</h2>
            <p className="card-sub">As sem resposta vêm primeiro, das notas mais baixas para as mais altas.</p>
          </div>
        </div>
        {tela.itens.length ? (
          <ul className="av-lista" aria-label="Avaliações do Google">
            {tela.itens.map((i) => (
              <Item key={i.id} item={i} />
            ))}
          </ul>
        ) : (
          <Estado icone="message" compacto titulo="Nenhuma avaliação nos últimos 12 meses">
            O Liame guarda as avaliações feitas ou alteradas nos últimos 12 meses. As mais antigas continuam no perfil da empresa no Google.
          </Estado>
        )}
        {tela.notas.map((n) => (
          <p className="eixo-nota" key={n}>
            {n}
          </p>
        ))}
      </article>
    </div>
  );
}
