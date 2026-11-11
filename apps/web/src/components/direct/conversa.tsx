'use client';

import type { DirectConversationResponse, DirectMessage, DirectSuggestion } from '@liame/contracts';
import { type FormEvent, useEffect, useId, useRef, useState } from 'react';
import { Estado } from '@/components/ui/estado';
import { Icone } from '@/components/ui/icone';
import { api, chamar, mensagemDe, type Problema } from '@/lib/api';
import { disparar } from '@/lib/disparar';
import { quandoComHora } from '@/lib/formato';
import { anexoDaMensagem, bytesDoTexto, ESPACO_DA_RESPOSTA, erroDaResposta, janelaDaConversa, quemEscreveu, recusaDaResposta, saiuSozinha, situacaoDoEnvio } from './textos';

// A conversa aberta (P39): quem escreveu, a janela da Meta, as mensagens guardadas e a resposta. Mandar passa pelo
// atendimento aberto (a tela pede a confirmação uma vez e abre por 8 horas); o pedido nasce aprovado e sai na volta
// seguinte do executor, e a conversa mostra "enviando…" até a mensagem chegar à conversa do Liame (ou o porquê de não
// ter saído).

const INSTAGRAM_DIRECT = 'https://www.instagram.com/direct/inbox/';
/** De quanto em quanto a tela olha se a resposta saiu, e até quantas vezes (o executor anda a cada poucos segundos). */
const OLHAR_MS = 2_000;
const OLHAR_VEZES = 30;

type Carga = { tipo: 'carregando' } | { tipo: 'ok'; dados: DirectConversationResponse } | { tipo: 'erro'; problema: Problema };
type Envio = { id: string; texto: string; situacao: 'enviando' | 'erro'; motivo: string | null };

type Props = {
  marca: string;
  marcaNome: string;
  id: string;
  /** Muda a cada leitura da tela (de minuto em minuto, e depois de cada mudança): a conversa lê de novo. */
  leitura: number;
  /** No estreito, a conversa toma o lugar da lista: o foco vai para o nome de quem escreveu. */
  focar: boolean;
  agora: Date;
  /** A pessoa responde no Direct (o Dono, os Administradores e quem aprova). */
  podeResponder: boolean;
  /** Pede o atendimento aberto (a confirmação, se ainda não está aberto); falso: a pessoa desistiu. */
  garantirAtendimento: () => Promise<boolean>;
  /** O atendimento venceu no meio do caminho (o servidor recusou com 409). */
  atendimentoVenceu: () => void;
  /** A conversa mudou (lida, respondida, concluída): a lista lê de novo. */
  aoMudar: () => void;
  aoVoltar: () => void;
  avisar: (texto: string, opcoes?: { tipo?: 'ok' | 'perigo' }) => void;
};

export function ConversaDoDirect({ marca, marcaNome, id, leitura, focar, agora, podeResponder, garantirAtendimento, atendimentoVenceu, aoMudar, aoVoltar, avisar }: Props) {
  const ids = useId();
  const titulo = useRef<HTMLElement>(null);
  const campo = useRef<HTMLTextAreaElement>(null);
  const [carga, setCarga] = useState<Carga>({ tipo: 'carregando' });
  const [texto, setTexto] = useState('');
  const [erro, setErro] = useState<string | null>(null);
  const [envio, setEnvio] = useState<Envio | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const [tentativa, setTentativa] = useState(0);
  const vivo = useRef(true);

  useEffect(() => {
    vivo.current = true;
    return () => {
      vivo.current = false;
    };
  }, []);

  useEffect(() => {
    let atual = true;
    setCarga((c) => (c.tipo === 'ok' && c.dados.conversation.id === id ? c : { tipo: 'carregando' }));
    disparar(
      chamar(() => api.GET('/v1/direct/conversations/{id}', { params: { path: { id }, query: { brand_id: marca } } })).then(async (r) => {
        if (!atual) return;
        setCarga(r.ok ? { tipo: 'ok', dados: r.data } : { tipo: 'erro', problema: r.problema });
        // Abrir tira o "não lida" da lista do Liame (nada muda no Instagram).
        if (r.ok && r.data.conversation.unread) {
          const lida = await chamar(() => api.POST('/v1/direct/conversations/{id}/read', { params: { path: { id } }, body: { brand_id: marca } }));
          if (atual && lida.ok) {
            setCarga({ tipo: 'ok', dados: lida.data });
            aoMudar();
          }
        }
      }),
    );
    return () => {
      atual = false;
    };
  }, [id, marca, tentativa, leitura, aoMudar]);

  // No estreito, o foco vai para o nome de quem escreveu quando a conversa abre (uma vez).
  const focou = useRef(false);
  useEffect(() => {
    if (!focar || focou.current || carga.tipo !== 'ok') return;
    focou.current = true;
    titulo.current?.focus();
  }, [focar, carga.tipo]);

  /** Olha o pedido até ele sair (ou não), e lê a conversa de novo. */
  async function acompanhar(pedido: string, enviado: string) {
    for (let i = 0; i < OLHAR_VEZES; i += 1) {
      await new Promise((ok) => setTimeout(ok, OLHAR_MS));
      if (!vivo.current) return;
      const r = await chamar(() => api.GET('/v1/actions/{id}', { params: { path: { id: pedido } } }));
      if (!r.ok) continue;
      const s = situacaoDoEnvio(r.data.status, r.data.status_reason);
      if (!s.fim) continue;
      if (s.ok) {
        setEnvio(null);
        setTentativa((t) => t + 1);
        aoMudar();
        avisar('Resposta enviada no Direct.');
        return;
      }
      setEnvio({ id: pedido, texto: enviado, situacao: 'erro', motivo: s.texto });
      setTexto((t) => t || enviado);
      return;
    }
    // Demorou mais que o normal: a resposta segue no trilho, e a lista mostra quando sair.
    setEnvio(null);
    setTentativa((t) => t + 1);
    aoMudar();
  }

  async function mandar(e: FormEvent) {
    e.preventDefault();
    const recusa = recusaDaResposta(texto);
    if (recusa) {
      setErro(recusa);
      campo.current?.focus();
      return;
    }
    setErro(null);
    if (!(await garantirAtendimento())) return;
    const enviado = texto.trim();
    setOcupado(true);
    const r = await chamar(() => api.POST('/v1/direct/conversations/{id}/reply', { params: { path: { id } }, body: { brand_id: marca, text: enviado } }));
    setOcupado(false);
    if (!r.ok) {
      if (r.problema.code === 'atendimento-fechado') {
        // Venceu entre a tela e o servidor: pede a confirmação de novo, com o texto onde está.
        atendimentoVenceu();
        setErro('O atendimento fechou. Confirme de novo e mande.');
        return;
      }
      setErro(erroDaResposta(r.problema));
      if (r.problema.status === 404) aoMudar();
      return;
    }
    setTexto('');
    const s = situacaoDoEnvio(r.data.status, r.data.status_reason);
    if (s.fim && !s.ok) {
      setTexto(enviado);
      setErro(s.texto);
      return;
    }
    setEnvio({ id: r.data.action_id, texto: enviado, situacao: 'enviando', motivo: null });
    disparar(acompanhar(r.data.action_id, enviado));
  }

  async function concluir() {
    setOcupado(true);
    setErro(null);
    const r = await chamar(() => api.POST('/v1/direct/conversations/{id}/conclude', { params: { path: { id } }, body: { brand_id: marca } }));
    setOcupado(false);
    if (!r.ok) return setErro(mensagemDe(r.problema));
    setCarga({ tipo: 'ok', dados: r.data });
    aoMudar();
    avisar('Conversa concluída. Se a pessoa escrever de novo, ela volta para "Esperam resposta".');
  }

  if (carga.tipo === 'carregando') {
    return (
      <div className="dir-conv-vazia" aria-busy="true">
        <p className="campo-dica">Abrindo a conversa…</p>
      </div>
    );
  }
  if (carga.tipo === 'erro') {
    return (
      <Estado
        icone="alert-circle"
        perigo
        compacto
        titulo={carga.problema.status === 404 ? 'A conversa não está mais no Liame' : 'Não deu para abrir a conversa'}
        acao={
          <div className="vazio-acoes">
            <button className="btn btn--sm" type="button" onClick={() => setTentativa((t) => t + 1)}>
              <Icone nome="refresh" pequeno />
              Tentar de novo
            </button>
          </div>
        }
      >
        {carga.problema.status === 404 ? 'Ela pode ter passado dos 90 dias ou saído do Instagram.' : mensagemDe(carga.problema)}
      </Estado>
    );
  }

  const { conversation: c, messages, suggestion: sugestao } = carga.dados;
  const janela = janelaDaConversa(c, agora);
  const quem = quemEscreveu(c.username);
  const usados = bytesDoTexto(texto.trim());
  const naJanela = c.status !== 'fora' && c.window_until !== null;

  return (
    <>
      <div className="dir-conv-cab">
        <button className="btn btn--sm btn--ghost dir-voltar" type="button" onClick={aoVoltar}>
          <Icone nome="chevron-left" pequeno />
          Voltar
        </button>
        <div className="dir-conv-quem">
          <b id="dir-conv-t" ref={titulo} tabIndex={-1}>
            {quem}
          </b>
          <span>Última mensagem {quandoComHora(c.last_message_at, agora)}</span>
        </div>
        <a className="btn btn--sm btn--ghost" href={INSTAGRAM_DIRECT} target="_blank" rel="noopener noreferrer">
          <Icone nome="external" pequeno />
          Abrir no Instagram
        </a>
      </div>
      <p className={`dir-janela${janela.nivel === 'atencao' ? ' dir-janela--atencao' : janela.nivel === 'fechada' ? ' dir-janela--fechada' : ''}`}>
        <Icone nome={janela.nivel === 'fechada' ? 'lock' : janela.nivel === 'atencao' ? 'alert' : 'clock'} />
        <span>{janela.texto}</span>
      </p>
      <div className="dir-fio" role="log" aria-label={`Mensagens com ${quem}`}>
        {messages.length === 0 && <p className="campo-dica">Nenhuma mensagem guardada nesta conversa.</p>}
        {messages.map((m) => (
          <Mensagem key={m.id} m={m} marcaNome={marcaNome} agora={agora} />
        ))}
        {envio && !(envio.situacao === 'enviando' && messages.some((m) => m.direction === 'saida' && m.text === envio.texto)) && (
          <div className="dir-msg dir-msg--nossa">
            <p className="dir-bolha">{envio.texto}</p>
            <span className={`dir-msg-meta${envio.situacao === 'erro' ? ' dir-msg-meta--erro' : ''}`} role="status">
              {envio.situacao === 'erro' ? envio.motivo : 'enviando…'}
            </span>
          </div>
        )}
      </div>
      {sugestao && (
        <SugestaoDoDirect
          s={sugestao}
          aoUsar={
            podeResponder && naJanela
              ? (t) => {
                  setTexto(t);
                  setErro(null);
                  campo.current?.focus();
                }
              : null
          }
        />
      )}
      {!podeResponder ? (
        <div className="dir-travado">
          <Icone nome="eye" />
          <span>
            <b>Você vê as conversas, mas não responde.</b> Responder no Direct é do Dono, dos Administradores e de quem aprova. Peça a quem cuida de Pessoas e acessos.
          </span>
        </div>
      ) : !naJanela ? (
        <div className="dir-travado">
          <Icone nome="lock" />
          <span>
            <b>Não dá para responder agora.</b> A Meta só deixa a marca responder até 24 horas depois da última mensagem da pessoa. Quando ela escrever de novo, a conversa volta para
            “Esperam resposta”.
          </span>
        </div>
      ) : sugestao?.kind === 'golpe' ? (
        // Golpe (P39): nada sai para esta conversa; concluir tira da lista do Liame.
        <div className="dir-resp">
          {erro && (
            <p className="campo-erro" role="alert">
              {erro}
            </p>
          )}
          <div className="dir-resp-pe">
            <span className="dir-resp-dica">Nada sai para esta conversa. Concluir tira da lista do Liame; o Instagram não muda.</span>
            <button className="btn" type="button" disabled={ocupado} onClick={() => disparar(concluir())}>
              <Icone nome="check" pequeno />
              Concluir a conversa
            </button>
          </div>
        </div>
      ) : (
        <form className="dir-resp" onSubmit={(e) => disparar(mandar(e))} noValidate>
          <label htmlFor={`${ids}-texto`}>Sua resposta para {quem}</label>
          <textarea
            ref={campo}
            className="input"
            id={`${ids}-texto`}
            value={texto}
            placeholder="Escreva a resposta"
            disabled={ocupado}
            aria-invalid={erro ? true : undefined}
            aria-describedby={`${ids}-dica${erro ? ` ${ids}-erro` : ''}`}
            onChange={(e) => setTexto(e.target.value)}
          />
          {erro && (
            <p className="campo-erro" id={`${ids}-erro`} role="alert">
              {erro}
            </p>
          )}
          <div className="dir-resp-pe">
            <span className="dir-resp-dica" id={`${ids}-dica`}>
              Sai em nome da {marcaNome}, no Direct da marca, e fica na auditoria com o seu nome. Espaço: <span className="num">{usados.toLocaleString('pt-BR')}</span> de 1.000 (letra com
              acento conta 2).
            </span>
            {c.status === 'espera' && (
              <button className="btn btn--ghost" type="button" disabled={ocupado} onClick={() => disparar(concluir())}>
                Concluir sem responder
              </button>
            )}
            <button className="btn btn--primary" type="submit" disabled={ocupado || usados > ESPACO_DA_RESPOSTA} aria-busy={ocupado}>
              <Icone nome="send" pequeno />
              {ocupado ? 'Mandando…' : 'Mandar'}
            </button>
          </div>
        </form>
      )}
    </>
  );
}

/**
 * A sugestão sem IA (parte 4a; P39): a resposta pronta do elogio e da menção no story (com "Usar esta"), o "como
 * proceder" da reclamação e o aviso do golpe. Um tipo que esta versão da tela não conhece não aparece (V23).
 */
function SugestaoDoDirect({ s, aoUsar }: { s: DirectSuggestion; aoUsar: ((texto: string) => void) | null }) {
  if (s.kind === 'golpe') {
    return (
      <div className="dir-sug dir-sug--golpe">
        <p className="dir-sug-cab">
          <Icone nome="alert" />
          <b>Parece golpe</b>
        </p>
        <p className="dir-sug-texto">O Liame não sugere resposta a golpe. Concluir tira a conversa da lista do Liame; denunciar e bloquear ficam no Instagram.</p>
      </div>
    );
  }
  if (s.kind === 'passos' && s.steps.length) {
    return (
      <div className="dir-sug">
        <p className="dir-sug-cab">
          <Icone nome="sparkles" />
          <b>Como proceder</b>
          <span>numa reclamação</span>
        </p>
        <ol className="dir-passos">
          {s.steps.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ol>
      </div>
    );
  }
  if (s.kind === 'pronta' && s.text) {
    const texto = s.text;
    return (
      <div className="dir-sug">
        <p className="dir-sug-cab">
          <Icone nome="sparkles" />
          <b>Resposta pronta</b>
          <span>sem IA, como a do elogio nos comentários</span>
        </p>
        <p className="dir-sug-texto">{texto}</p>
        {aoUsar && (
          <div>
            <button className="btn btn--sm" type="button" onClick={() => aoUsar(texto)}>
              Usar esta
            </button>
          </div>
        )}
      </div>
    );
  }
  return null;
}

/** Uma mensagem: o texto em balão, ou a frase do que só o Instagram guarda (foto, vídeo, story). */
function Mensagem({ m, marcaNome, agora }: { m: DirectMessage; marcaNome: string; agora: Date }) {
  const nossa = m.direction === 'saida';
  const anexo = anexoDaMensagem(m);
  // A resposta que saiu pelo atendimento automático (parte 5b; P39 versão 2): "Liame, sozinho".
  const sozinha = nossa && saiuSozinha(m.text);
  const meta = (
    <span className="dir-msg-meta">
      {nossa && <span>{sozinha ? 'Liame, sozinho' : marcaNome}</span>}
      <span>{quandoComHora(m.sent_at, agora)}</span>
    </span>
  );
  return (
    <div className={`dir-msg ${nossa ? 'dir-msg--nossa' : 'dir-msg--deles'}`}>
      {anexo ? (
        <div className="dir-anexo">
          <Icone nome={anexo.story ? 'instagram' : m.kind === 'imagem' ? 'image' : m.kind === 'video' ? 'video' : 'file'} />
          <span>
            {anexo.texto}
            {m.text ? `: ${m.text}` : ''}. O Liame não guarda fotos, vídeos, áudios nem stories:{' '}
            <a href={INSTAGRAM_DIRECT} target="_blank" rel="noopener noreferrer">
              ver no Instagram
            </a>
            .
          </span>
        </div>
      ) : (
        <p className="dir-bolha">{m.text}</p>
      )}
      {meta}
    </div>
  );
}
