'use client';

import type { CommentAutoReplyResponse, PasskeyAssertion } from '@liame/contracts';
import { type FormEvent, type RefObject, useId, useRef, useState } from 'react';
import { ConfirmarComChave } from '@/components/seguranca/confirmar-com-chave';
import { Icone } from '@/components/ui/icone';
import { useDialogo } from '@/components/ui/use-dialogo';
import { api, chamar, mensagemDe, novaChave } from '@/lib/api';
import { disparar } from '@/lib/disparar';
import { type FormasDeConfirmar, useFormasDeConfirmar } from '@/lib/sessao';
import { botaoDoAutomatico, erroDoAutomatico, estadoDoAutomatico, pedeConfirmacao, resumoDoAutomatico, TIPOS_DO_AUTOMATICO } from './textos';

// O atendimento automático na tela Comentários (mockups/prototipo-comentarios.html, P38 versão 2; A6 · Z11, parte 2e-2;
// D-A6-92 e D-A6-104): a linha no topo, com o que está valendo, e a gaveta para ligar, desligar e marcar os tipos. Ligar
// e somar um tipo pedem o Dono ou um Administrador e a confirmação (a chave de acesso ou o código do app); desligar e
// tirar um tipo valem na hora, sem código, para quem aprova. Só aparece com a função liberada para a empresa.

/** A linha no topo: ligado ou desligado, o que ele fez nesta hora e o botão da gaveta. */
export function LinhaDoAutomatico({ r, aoAbrir }: { r: CommentAutoReplyResponse; aoAbrir: () => void }) {
  return (
    <div className={`com-auto${r.enabled ? ' com-auto--ligado' : ''}`} id="com-auto">
      <div className="com-auto-txt">
        <span className="com-auto-cab">
          <Icone nome="zap" pequeno />
          <b>Atendimento automático</b>
          <span className={`st ${r.enabled ? 'st--concluido' : 'st--espera'}`}>
            <span className="dot" aria-hidden="true" />
            {r.enabled ? 'Ligado' : 'Desligado'}
          </span>
        </span>
        <span className="com-auto-sub">{resumoDoAutomatico(r)}</span>
      </div>
      <button className="btn btn--sm" type="button" data-com-auto aria-haspopup="dialog" onClick={aoAbrir}>
        {botaoDoAutomatico(r)}
        <span className="sr-only"> o atendimento automático</span>
      </button>
    </div>
  );
}

type Props = {
  r: CommentAutoReplyResponse;
  reserva: RefObject<HTMLElement | null>;
  aoSalvar: (novo: CommentAutoReplyResponse, aviso: string) => void;
  aoFechar: () => void;
  /** Como a pessoa confirma, no lugar da sessão (os testes de desenho). */
  confirmar?: FormasDeConfirmar;
};

/** O que vai para a API: ligado, os tipos e, para ligar ou somar, a confirmação. */
type Mudanca = { enabled: boolean; kinds: string[]; code?: string; passkey?: PasskeyAssertion };

export function GavetaDoAutomatico({ r, reserva, aoSalvar, aoFechar, confirmar }: Props) {
  const ids = useId();
  const chaveLigado = useRef<HTMLInputElement>(null);
  const campoCodigo = useRef<HTMLInputElement>(null);
  const { ref, fechar, devolverFoco } = useDialogo({ focoInicial: chaveLigado, reserva });
  const idempotencia = useRef(novaChave());
  const [ligado, setLigado] = useState(r.enabled);
  const [tipos, setTipos] = useState<string[]>(r.kinds);
  const [codigo, setCodigo] = useState('');
  const [erroCodigo, setErroCodigo] = useState('');
  const [erroGeral, setErroGeral] = useState('');
  const [enviando, setEnviando] = useState(false);
  const { temApp, temChave } = useFormasDeConfirmar(confirmar);
  const depois = { enabled: ligado, kinds: TIPOS_DO_AUTOMATICO.map((t) => t.id).filter((k) => tipos.includes(k)) };
  const mudou = depois.enabled !== r.enabled || depois.kinds.join() !== TIPOS_DO_AUTOMATICO.map((t) => t.id).filter((k) => r.kinds.includes(k)).join();
  const comConfirmacao = pedeConfirmacao(r, depois);
  // Quem não liga (o aprovador) só pode desligar e tirar um tipo: a chave e os tipos não marcados ficam travados.
  const travaLigar = !r.can_enable && !r.enabled;

  function conferir(): boolean {
    setErroCodigo('');
    setErroGeral('');
    if (depois.enabled && depois.kinds.length === 0) {
      setErroGeral('Para ligar, marque pelo menos um tipo de comentário.');
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
      api.PUT('/v1/comments/auto-reply', {
        headers: { 'Idempotency-Key': idempotencia.current },
        body: { brand_id: r.brand_id, enabled: mudanca.enabled, kinds: mudanca.kinds as ('elogio' | 'marcacao')[], ...(mudanca.code ? { code: mudanca.code } : {}), ...(mudanca.passkey ? { passkey: mudanca.passkey } : {}) },
      }),
    );
    setEnviando(false);
    if (res.ok) {
      const aviso = !res.data.enabled
        ? 'Atendimento automático desligado. A partir de agora, nenhuma resposta sai sem a aprovação de uma pessoa.'
        : r.enabled
          ? 'Salvo. O atendimento automático responde sozinho só os tipos marcados.'
          : 'Atendimento automático ligado. Os elogios e as marcações marcados saem sozinhos; reclamações e perguntas esperam você.';
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
    setErroGeral(res.problema.status >= 500 ? mensagemDe(res.problema) : erroDoAutomatico(res.problema));
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
          <h2 id={`${ids}-t`}>Atendimento automático</h2>
          <button className="btn btn--ghost btn--icon" type="button" onClick={fechar} aria-label="Fechar" disabled={enviando}>
            <Icone nome="x" />
          </button>
        </div>
        <div className="dialogo-corpo">
          {erroGeral && (
            <p className="dialogo-erro" role="alert" id="com-auto-erro">
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
                id="com-auto-ligado"
                checked={ligado}
                disabled={travaLigar || enviando}
                aria-describedby={`${ids}-estado${travaLigar ? ` ${ids}-so-dono` : ''}`}
                onChange={(e) => setLigado(e.target.checked)}
              />
              <b id={`${ids}-chave`}>O Liame responde sozinho</b>
            </label>
            <p className="campo-dica" id={`${ids}-estado`}>
              {estadoDoAutomatico(r)}
            </p>
            {travaLigar && (
              <p className="nota" id={`${ids}-so-dono`}>
                <Icone nome="lock" />
                <span>Só o Dono ou um Administrador liga. Quem aprova vê como funciona e, quando ele estiver ligado, pode desligar.</span>
              </p>
            )}
            {nota('shield', 'Ligar, desligar e cada resposta automática ficam na auditoria, com quem fez e quando.')}
          </section>
          <fieldset className="com-auto-bloco">
            <legend>O que o Liame responde sozinho</legend>
            {TIPOS_DO_AUTOMATICO.map((t) => {
              const marcado = tipos.includes(t.id);
              return (
                <label className="check com-auto-tipo" key={t.id}>
                  <input
                    type="checkbox"
                    data-com-auto-tipo={t.id}
                    checked={marcado}
                    // Quem não liga só tira: o que não está marcado fica travado para ele.
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
            {r.enabled
              ? nota('info', 'Tirar um tipo vale na hora; somar um tipo pede a sua confirmação.')
              : nota('info', 'Ao ligar, ele responde também os elogios e as marcações das últimas 24 horas que ainda esperam você, com o texto que o Social media escreveu.')}
          </fieldset>
          <section className="com-auto-bloco" aria-labelledby={`${ids}-espera`}>
            <h3 id={`${ids}-espera`}>O que sempre espera você</h3>
            {nota('message', 'Vão para você com o passo a passo e as sugestões de resposta.', 'Reclamações.')}
            {nota('info', 'Por enquanto, vão para você com uma sugestão.', 'Perguntas.')}
            {nota('eye-off', 'O Liame nunca responde; ocultar espera a sua aprovação.', 'Golpe ou ofensa.')}
          </section>
          <section className="com-auto-bloco" aria-labelledby={`${ids}-como`}>
            <h3 id={`${ids}-como`}>Como a resposta sai</h3>
            {nota('reply', 'Em nome da marca, terminando com “· resposta automática”: os Termos (6.3) prometem avisar quem conversa com um funcionário de IA.')}
            {nota('check', 'Uma resposta por pessoa em cada post, e nunca a um comentário da própria marca.')}
            {nota('clock', `No máximo ${r.hourly_limit} respostas sozinho por hora; o que passar espera a hora seguinte.`)}
            {nota('undo', 'Cada uma aparece na lista como “Respondido sozinho”, e quem aprova pode apagá-la em Aprovações, sem código.')}
          </section>
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
            <button className={`btn${comConfirmacao && temChave ? '' : ' btn--primary'}`} type="submit" id="com-auto-salvar" disabled={enviando} aria-busy={enviando}>
              {enviando ? 'Salvando…' : comConfirmacao && temChave ? 'Salvar com o código' : depois.enabled && !r.enabled ? 'Ligar o atendimento automático' : 'Salvar'}
            </button>
          )}
        </div>
      </form>
    </dialog>
  );
}
