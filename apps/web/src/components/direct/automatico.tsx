'use client';

import type { DirectAutoReplyPreviewResponse, DirectAutoReplyRequest, DirectAutoReplyResponse, PasskeyAssertion } from '@liame/contracts';
import { type FormEvent, type RefObject, useEffect, useId, useRef, useState } from 'react';
import { ConfirmarComChave } from '@/components/seguranca/confirmar-com-chave';
import { Icone } from '@/components/ui/icone';
import { useDialogo } from '@/components/ui/use-dialogo';
import { api, chamar, novaChave } from '@/lib/api';
import { disparar } from '@/lib/disparar';
import { type FormasDeConfirmar, useFormasDeConfirmar } from '@/lib/sessao';
import {
  AVISO_DO_DIRECT,
  botaoDoAutomaticoDoDirect,
  erroDoAutomaticoDoDirect,
  estadoDoAutomaticoDoDirect,
  pedeConfirmacaoDoDirect,
  quemEscreveu,
  resumoDoAutomaticoDoDirect,
  TIPOS_DO_AUTOMATICO_DO_DIRECT,
} from './textos';

// O atendimento automático na tela Direct (mockups/prototipo-direct.html, P39 versão 2; A6 · Z12, parte 5b; D-A6-115 e
// D-A6-119): a linha no topo da caixa, com o que está valendo, e a gaveta para ligar, desligar e marcar os tipos, com a
// prévia. Ligar e somar um tipo pedem o Dono ou um Administrador e a confirmação (a chave de acesso ou o código do app);
// desligar e tirar um tipo valem na hora, sem código, para quem aprova. Só aparece com a função liberada para a empresa.
// As classes de estilo são as do automático dos comentários (`com-auto*`): o mesmo desenho do P38 versão 2.

/** A linha no topo da caixa: ligado ou desligado, o que ele fez nesta hora e o botão da gaveta. */
export function LinhaDoAutomaticoDoDirect({ r, aoAbrir }: { r: DirectAutoReplyResponse; aoAbrir: () => void }) {
  return (
    <div className={`com-auto${r.enabled ? ' com-auto--ligado' : ''}`} id="dir-auto">
      <div className="com-auto-txt">
        <span className="com-auto-cab">
          <Icone nome="zap" pequeno />
          <b>Atendimento automático</b>
          <span className={`st ${r.enabled ? 'st--concluido' : 'st--espera'}`}>
            <span className="dot" aria-hidden="true" />
            {r.enabled ? 'Ligado' : 'Desligado'}
          </span>
        </span>
        <span className="com-auto-sub">{resumoDoAutomaticoDoDirect(r)}</span>
      </div>
      <button className="btn btn--sm" type="button" data-dir-auto aria-haspopup="dialog" onClick={aoAbrir}>
        {botaoDoAutomaticoDoDirect(r)}
        <span className="sr-only"> o atendimento automático do Direct</span>
      </button>
    </div>
  );
}

type Props = {
  r: DirectAutoReplyResponse;
  reserva: RefObject<HTMLElement | null>;
  aoSalvar: (novo: DirectAutoReplyResponse, aviso: string) => void;
  aoFechar: () => void;
  /** Como a pessoa confirma, no lugar da sessão (os testes de desenho). */
  confirmar?: FormasDeConfirmar;
};

/** O que vai para a API: ligado, os tipos e, para ligar ou somar, a confirmação. */
type Mudanca = { enabled: boolean; kinds: string[]; code?: string; passkey?: PasskeyAssertion };

export function GavetaDoAutomaticoDoDirect({ r, reserva, aoSalvar, aoFechar, confirmar }: Props) {
  const ids = useId();
  const chaveLigado = useRef<HTMLInputElement>(null);
  const campoCodigo = useRef<HTMLInputElement>(null);
  const { ref, fechar, devolverFoco } = useDialogo({ focoInicial: chaveLigado, reserva });
  const idempotencia = useRef(novaChave());
  const [ligado, setLigado] = useState(r.enabled);
  // Desligado e sem tipo ainda: os tipos começam marcados (como no P39), para ligar com um clique.
  const [tipos, setTipos] = useState<string[]>(r.enabled || r.kinds.length ? r.kinds : TIPOS_DO_AUTOMATICO_DO_DIRECT.map((t) => t.id));
  const [codigo, setCodigo] = useState('');
  const [erroCodigo, setErroCodigo] = useState('');
  const [erroGeral, setErroGeral] = useState('');
  const [enviando, setEnviando] = useState(false);
  const { temApp, temChave } = useFormasDeConfirmar(confirmar);
  const [previa, setPrevia] = useState<DirectAutoReplyPreviewResponse['items'] | 'carregando' | 'erro'>('carregando');

  useEffect(() => {
    let vivo = true;
    disparar(
      chamar(() => api.GET('/v1/direct/auto-reply/preview', { params: { query: { brand_id: r.brand_id } } })).then((res) => {
        if (vivo) setPrevia(res.ok ? res.data.items : 'erro');
      }),
    );
    return () => {
      vivo = false;
    };
  }, [r.brand_id]);

  const depois = { enabled: ligado, kinds: TIPOS_DO_AUTOMATICO_DO_DIRECT.map((t) => t.id).filter((k) => tipos.includes(k)) };
  // Desligado antes e depois, os tipos marcados não mudam nada (eles começam marcados para ligar com um clique).
  const mudou = depois.enabled !== r.enabled || (depois.enabled && depois.kinds.join() !== TIPOS_DO_AUTOMATICO_DO_DIRECT.map((t) => t.id).filter((k) => r.kinds.includes(k)).join());
  const comConfirmacao = pedeConfirmacaoDoDirect(r, depois);
  // Quem não liga (o aprovador) só pode desligar e tirar um tipo: a chave e os tipos não marcados ficam travados.
  const travaLigar = !r.can_enable && !r.enabled;

  function conferir(): boolean {
    setErroCodigo('');
    setErroGeral('');
    if (depois.enabled && depois.kinds.length === 0) {
      setErroGeral('Para ligar, marque pelo menos um tipo de conversa.');
      return false;
    }
    return true;
  }

  async function salvar(e: FormEvent) {
    e.preventDefault();
    if (!conferir()) return;
    if (!mudou) return fechar();
    const mudanca: Mudanca = { ...depois };
    if (comConfirmacao) {
      if (!temApp) return;
      const cod = codigo.trim();
      if (!/^\d{6}$/.test(cod)) {
        setErroCodigo('Para ligar ou somar um tipo, digite os 6 números do app autenticador.');
        campoCodigo.current?.focus();
        return;
      }
      mudanca.code = cod;
    }
    await mandar(mudanca);
  }

  async function comChave(passkey: PasskeyAssertion) {
    if (!conferir()) return;
    await mandar({ ...depois, passkey });
  }

  async function mandar(mudanca: Mudanca) {
    setEnviando(true);
    const res = await chamar(() =>
      api.PUT('/v1/direct/auto-reply', {
        headers: { 'Idempotency-Key': idempotencia.current },
        body: {
          brand_id: r.brand_id,
          enabled: mudanca.enabled,
          kinds: mudanca.kinds as DirectAutoReplyRequest['kinds'],
          ...(mudanca.code ? { code: mudanca.code } : {}),
          ...(mudanca.passkey ? { passkey: mudanca.passkey } : {}),
        },
      }),
    );
    setEnviando(false);
    if (res.ok) {
      const aviso = !res.data.enabled
        ? 'Atendimento automático desligado. Nenhuma resposta sai sem uma pessoa da equipe.'
        : r.enabled
          ? 'Salvo. O automático responde só os tipos marcados.'
          : 'Atendimento automático ligado. As próximas mensagens que ele sabe responder saem sozinhas, com o aviso.';
      aoSalvar(res.data, aviso);
      return fechar();
    }
    idempotencia.current = novaChave();
    if (mudanca.code && (res.problema.code === 'codigo-invalido' || res.problema.errors?.some((x) => x.path === 'code'))) {
      setCodigo('');
      setErroCodigo(res.problema.code === 'codigo-invalido' ? 'O código não confere. Digite o que aparece agora no app autenticador.' : 'Digite os 6 números do app autenticador.');
      campoCodigo.current?.focus();
      return;
    }
    setErroGeral(erroDoAutomaticoDoDirect(res.problema));
  }

  const nota = (icone: Parameters<typeof Icone>[0]['nome'], texto: string, forte?: string) => (
    <p className="nota">
      <Icone nome={icone} />
      <span>
        {forte && <b>{forte} </b>}
        {texto}
      </span>
    </p>
  );

  return (
    <dialog
      ref={ref}
      className="dialogo dialogo--lado com-gaveta"
      aria-labelledby={`${ids}-t`}
      onClose={() => {
        aoFechar();
        devolverFoco();
      }}
    >
      <form className="dialogo-form" onSubmit={(e) => disparar(salvar(e))} noValidate>
        <div className="dialogo-cab">
          <h2 id={`${ids}-t`}>Atendimento automático do Direct</h2>
          <button className="btn btn--ghost btn--icon" type="button" onClick={fechar} aria-label="Fechar" disabled={enviando}>
            <Icone nome="x" />
          </button>
        </div>
        <div className="dialogo-corpo">
          {erroGeral && (
            <p className="dialogo-erro" role="alert">
              <Icone nome="alert" pequeno />
              <span>{erroGeral}</span>
            </p>
          )}
          <section className="com-auto-bloco" aria-labelledby={`${ids}-chave`}>
            <label className="check com-auto-chave">
              <input
                ref={chaveLigado}
                type="checkbox"
                role="switch"
                id="dir-auto-ligado"
                checked={ligado}
                disabled={travaLigar || enviando}
                aria-describedby={`${ids}-estado${travaLigar ? ` ${ids}-so-dono` : ''}`}
                onChange={(e) => setLigado(e.target.checked)}
              />
              <b id={`${ids}-chave`}>O Liame responde sozinho no Direct</b>
            </label>
            <p className="campo-dica" id={`${ids}-estado`}>
              {estadoDoAutomaticoDoDirect(r)}
            </p>
            {travaLigar && (
              <p className="nota" id={`${ids}-so-dono`}>
                <Icone nome="lock" />
                <span>Ligar é do Dono ou de um Administrador. Quem aprova vê como funciona e, quando ele estiver ligado, pode desligar.</span>
              </p>
            )}
            {nota('shield', 'Ligar, desligar e cada resposta automática ficam na auditoria, com quem fez e quando.')}
          </section>
          <fieldset className="com-auto-bloco">
            <legend>O que o Liame responde sozinho</legend>
            {TIPOS_DO_AUTOMATICO_DO_DIRECT.map((t) => {
              const marcado = tipos.includes(t.id);
              return (
                <label className="check com-auto-tipo" key={t.id}>
                  <input
                    type="checkbox"
                    data-dir-auto-tipo={t.id}
                    checked={marcado}
                    disabled={enviando || (!r.can_enable && !marcado)}
                    onChange={(e) => setTipos((atual) => (e.target.checked ? [...atual, t.id] : atual.filter((x) => x !== t.id)))}
                  />
                  <span>
                    <b>{t.rotulo}</b>
                    <span>{t.texto}</span>
                  </span>
                </label>
              );
            })}
            {nota('info', 'As perguntas que ele sabe responder com certeza entram quando o Social media escrever as respostas do Direct.')}
          </fieldset>
          <section className="com-auto-bloco" aria-labelledby={`${ids}-espera`}>
            <h3 id={`${ids}-espera`}>O que sempre espera você</h3>
            {nota('message', 'Vão para você com o passo a passo.', 'Reclamações e perguntas.')}
            {nota('user-plus', 'Quem escreve que quer falar com alguém da equipe.', 'Quem pede uma pessoa.')}
            {nota('alert', 'O Liame nunca responde golpe.', 'Golpe ou ofensa.')}
          </section>
          <section className="com-auto-bloco" aria-labelledby={`${ids}-como`}>
            <h3 id={`${ids}-como`}>Como a resposta sai</h3>
            {nota('reply', `Em nome da marca, terminando com “${AVISO_DO_DIRECT}”: os Termos (6.3 e 5.5) prometem o aviso de IA e o caminho para uma pessoa.`)}
            {nota('check', 'Uma resposta automática por mensagem; no máximo duas seguidas na mesma conversa. A seguinte vai para você.')}
            {nota('clock', `No máximo ${r.hourly_limit} respostas sozinho por hora, e nunca fora da janela de 24 horas da Meta.`)}
            {nota('instagram', 'Até a Meta aprovar o Liame, ele só responde sozinho a quem tem papel no app.')}
          </section>
          <details className="com-auto-previa" id="dir-auto-previa" open={!r.enabled}>
            <summary>Veja como ele teria respondido</summary>
            {previa === 'carregando' ? (
              <p className="campo-dica" aria-busy="true">
                Montando a prévia…
              </p>
            ) : previa === 'erro' ? (
              <p className="campo-dica">Não deu para montar a prévia agora. Isso não muda nada no atendimento.</p>
            ) : previa.length === 0 ? (
              <p className="campo-dica">Nenhuma conversa das últimas 24 horas que ele saberia responder sozinho.</p>
            ) : (
              <>
                <p className="campo-dica">Com as conversas das últimas 24 horas que ele sabe responder. Nada disto foi enviado.</p>
                <ul className="com-auto-ex">
                  {previa.map((p) => (
                    <li key={p.conversation_id}>
                      <span className="com-auto-ex-cab">
                        <b>{quemEscreveu(p.username)}</b>
                        <span>{p.kind === 'mencao' ? 'Menção no story' : 'Elogio'}</span>
                      </span>
                      {p.message && <span className="com-auto-ex-fala">{p.message}</span>}
                      <span className="com-auto-ex-resposta">
                        <span className="sr-only">Resposta que sairia: </span>
                        {p.reply}
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </details>
          {comConfirmacao && temChave && (
            <ConfirmarComChave
              rotulo="Salvar com a chave"
              impedido={enviando}
              alternativa={temApp ? 'use o código do app' : 'tente de novo'}
              antes={conferir}
              aoErro={setErroGeral}
              aoProvar={comChave}
            />
          )}
          {comConfirmacao && temApp && (
            <div className="campo">
              <label htmlFor={`${ids}-cod`}>{temChave ? 'Ou o código do app autenticador' : 'Código do app autenticador'}</label>
              <span className="campo-dica" id={`${ids}-cod-dica`}>
                Ligar e somar um tipo pedem a sua confirmação: a chave de acesso ou os 6 números do app. Fica na auditoria.
              </span>
              <input
                ref={campoCodigo}
                className="input campo-mono"
                id={`${ids}-cod`}
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                value={codigo}
                onChange={(e) => setCodigo(e.target.value)}
                aria-invalid={erroCodigo ? true : undefined}
                aria-describedby={`${ids}-cod-dica${erroCodigo ? ` ${ids}-cod-erro` : ''}`}
              />
              {erroCodigo && (
                <p className="campo-erro" id={`${ids}-cod-erro`}>
                  {erroCodigo}
                </p>
              )}
            </div>
          )}
        </div>
        <div className="dialogo-acoes">
          <button className="btn" type="button" onClick={fechar} disabled={enviando}>
            {mudou ? 'Cancelar' : 'Fechar'}
          </button>
          {mudou && (!comConfirmacao || temApp) && (
            <button className={`btn${comConfirmacao && temChave ? '' : ' btn--primary'}`} type="submit" id="dir-auto-salvar" disabled={enviando} aria-busy={enviando}>
              {enviando ? 'Salvando…' : comConfirmacao && temChave ? 'Salvar com o código' : depois.enabled && !r.enabled ? 'Ligar o atendimento automático' : 'Salvar'}
            </button>
          )}
        </div>
      </form>
    </dialog>
  );
}
