'use client';

import { type FormEvent, useEffect, useRef, useState } from 'react';
import { mandarRetorno } from '@/components/explicar/pedir';
import { COMENTARIO_MAXIMO, discordoValido, type MotivoDoDiscordo, MOTIVOS_DO_DISCORDO } from '@/components/explicar/textos';
import { copiar } from '@/components/links/copiar';
import { useAvisar } from '@/components/ui/avisos';
import { Icone } from '@/components/ui/icone';
import { mensagemDe } from '@/lib/api';
import { disparar } from '@/lib/disparar';

// O rodapé de cada resposta da LIA (protótipo P5): "Fez sentido", "Discordo" (com os motivos, logo abaixo) e
// "Copiar". O retorno fica guardado no Liame, com a resposta; não vai ao fornecedor do modelo (Política 7.5).

export function RetornoDaMensagem({ id, usageId, texto }: { id: string; usageId: string | null; texto: string }) {
  const avisar = useAvisar();
  const [fase, setFase] = useState<'nenhuma' | 'fez_sentido' | 'registrado'>('nenhuma');
  const [aberto, setAberto] = useState(false);
  const [motivos, setMotivos] = useState<MotivoDoDiscordo[]>([]);
  const [comentario, setComentario] = useState('');
  const [erro, setErro] = useState(false);
  const [ocupado, setOcupado] = useState(false);
  const [copiado, setCopiado] = useState<'sim' | 'nao' | null>(null);
  const discordo = useRef<HTMLButtonElement>(null);
  const primeiro = useRef<HTMLInputElement>(null);
  const formulario = useRef<HTMLFormElement>(null);
  const botaoCopiar = useRef<HTMLButtonElement>(null);
  const volta = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Aberto, o formulário aparece inteiro na lista (até o "Enviar motivo") e o foco vai para o primeiro motivo.
  useEffect(() => {
    if (!aberto) return;
    formulario.current?.scrollIntoView({ block: 'nearest' });
    primeiro.current?.focus({ preventScroll: true });
  }, [aberto]);
  // Registrado, o foco fica no "Copiar" (o grupo de botões saiu).
  useEffect(() => {
    if (fase === 'registrado') botaoCopiar.current?.focus();
  }, [fase]);
  useEffect(
    () => () => {
      if (volta.current) clearTimeout(volta.current);
    },
    [],
  );

  async function fezSentido() {
    if (!usageId || ocupado || fase === 'fez_sentido') return;
    setOcupado(true);
    const r = await mandarRetorno(usageId, { veredito: 'fez_sentido' });
    setOcupado(false);
    if (!r.ok) return avisar(mensagemDe(r.problema), { tipo: 'perigo' });
    setAberto(false);
    setFase('fez_sentido');
    avisar('Obrigado pelo retorno.');
  }

  async function enviar(evento: FormEvent) {
    evento.preventDefault();
    if (!usageId || ocupado) return;
    if (!discordoValido(motivos, comentario)) {
      setErro(true);
      primeiro.current?.focus();
      return;
    }
    setErro(false);
    setOcupado(true);
    const r = await mandarRetorno(usageId, { veredito: 'discordo', motivos, comentario });
    setOcupado(false);
    if (!r.ok) return avisar(mensagemDe(r.problema), { tipo: 'perigo' });
    setAberto(false);
    setFase('registrado');
    avisar('Motivo registrado. Obrigado: ele fica guardado com esta resposta.');
  }

  async function copiarResposta() {
    const ok = await copiar(texto);
    setCopiado(ok ? 'sim' : 'nao');
    if (volta.current) clearTimeout(volta.current);
    volta.current = setTimeout(() => setCopiado(null), 2200);
  }

  function marcar(valor: MotivoDoDiscordo, marcado: boolean) {
    setErro(false);
    setMotivos((atuais) => (marcado ? [...atuais.filter((m) => m !== valor), valor] : atuais.filter((m) => m !== valor)));
  }

  const botaoDeCopiar = (
    <button ref={botaoCopiar} className="btn btn--sm btn--ghost" type="button" onClick={() => disparar(copiarResposta())}>
      <Icone nome="copy" />
      <span aria-live="polite">{copiado === 'sim' ? 'Copiado' : copiado === 'nao' ? 'Não deu para copiar' : 'Copiar'}</span>
    </button>
  );

  // Resposta sem a chamada registrada (não deveria acontecer): fica só o "Copiar".
  if (!usageId) return <div className="msg-pe">{botaoDeCopiar}</div>;

  return (
    <>
      {fase === 'registrado' ? (
        <div className="msg-pe">
          <span className="st st--concluido">
            <Icone nome="check" pequeno />
            Motivo registrado
          </span>
          {botaoDeCopiar}
        </div>
      ) : (
        <div className="msg-pe" role="group" aria-label="Esta resposta fez sentido?">
          <button className="btn btn--sm btn--ghost" type="button" aria-pressed={fase === 'fez_sentido'} aria-busy={ocupado && !aberto} onClick={() => disparar(fezSentido())}>
            <Icone nome="thumb-up" />
            Fez sentido
          </button>
          <button
            ref={discordo}
            className="btn btn--sm btn--ghost"
            type="button"
            aria-expanded={aberto}
            aria-controls={`disc-msg-${id}`}
            onClick={() => {
              setErro(false);
              setAberto((a) => !a);
            }}
          >
            <Icone nome="thumb-down" />
            Discordo
          </button>
          {botaoDeCopiar}
        </div>
      )}
      {fase !== 'registrado' && (
        <form ref={formulario} className="discordar" id={`disc-msg-${id}`} noValidate hidden={!aberto} onSubmit={(e) => disparar(enviar(e))}>
          <fieldset className="campo">
            <legend>O que não fez sentido?</legend>
            <div className="disc-ops">
              {MOTIVOS_DO_DISCORDO.map((m, i) => (
                <label className="disc-op" key={m.valor}>
                  <input ref={i === 0 ? primeiro : undefined} type="checkbox" name="motivo" value={m.valor} checked={motivos.includes(m.valor)} onChange={(e) => marcar(m.valor, e.target.checked)} />
                  {m.rotulo}
                </label>
              ))}
            </div>
          </fieldset>
          <div className="campo">
            <label htmlFor={`disc-txt-msg-${id}`}>
              Quer contar mais? <span className="campo-dica">Opcional. Não escreva nome, telefone nem outro dado de cliente.</span>
            </label>
            <textarea
              className="area"
              id={`disc-txt-msg-${id}`}
              maxLength={COMENTARIO_MAXIMO}
              value={comentario}
              onChange={(e) => {
                setErro(false);
                setComentario(e.target.value);
              }}
            />
          </div>
          <p className="campo-erro" role="alert" hidden={!erro}>
            Marque pelo menos um motivo ou escreva o que houve.
          </p>
          <div className="discordar-acoes">
            <button className="btn btn--sm btn--primary" type="submit" disabled={ocupado} aria-busy={ocupado}>
              Enviar motivo
            </button>
            <button
              className="btn btn--sm"
              type="button"
              onClick={() => {
                setAberto(false);
                setErro(false);
                discordo.current?.focus();
              }}
            >
              Cancelar
            </button>
          </div>
        </form>
      )}
    </>
  );
}
