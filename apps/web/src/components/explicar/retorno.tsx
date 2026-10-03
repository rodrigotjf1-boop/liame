'use client';

import { type FormEvent, useEffect, useRef, useState } from 'react';
import { useAvisar } from '@/components/ui/avisos';
import { Icone } from '@/components/ui/icone';
import { mensagemDe } from '@/lib/api';
import { disparar } from '@/lib/disparar';
import { SUPORTE_EMAIL } from '@/lib/suporte';
import { mandarRetorno } from './pedir';
import { COMENTARIO_MAXIMO, discordoValido, type MotivoDoDiscordo, MOTIVOS_DO_DISCORDO } from './textos';

// O rodapé de uma explicação da LIA (protótipo P4): a nota de que ela é uma IA, o caminho para uma pessoa
// e o retorno de quem leu. "Fez sentido" grava na hora; "Discordo" abre os motivos e um campo livre, logo
// abaixo do botão. O retorno fica guardado no Liame, com a explicação; não vai ao fornecedor do modelo.

export function Retorno({ id, usageId }: { id: string; usageId: string }) {
  const avisar = useAvisar();
  const [fase, setFase] = useState<'nenhuma' | 'fez_sentido' | 'registrado'>('nenhuma');
  const [aberto, setAberto] = useState(false);
  const [motivos, setMotivos] = useState<MotivoDoDiscordo[]>([]);
  const [comentario, setComentario] = useState('');
  const [erro, setErro] = useState(false);
  const [ocupado, setOcupado] = useState(false);
  const discordo = useRef<HTMLButtonElement>(null);
  const primeiro = useRef<HTMLInputElement>(null);
  const registrado = useRef<HTMLParagraphElement>(null);

  // O formulário abre com o foco no primeiro motivo; registrado, o foco fica no aviso de que foi guardado.
  useEffect(() => {
    if (aberto) primeiro.current?.focus();
  }, [aberto]);
  useEffect(() => {
    if (fase === 'registrado') registrado.current?.focus();
  }, [fase]);

  async function fezSentido() {
    if (ocupado || fase === 'fez_sentido') return;
    setOcupado(true);
    const r = await mandarRetorno(usageId, { veredito: 'fez_sentido' });
    setOcupado(false);
    if (!r.ok) return avisar(mensagemDe(r.problema), { tipo: 'perigo' });
    setAberto(false);
    setFase('fez_sentido');
    avisar('Obrigado pelo retorno.');
  }

  function alternarDiscordo() {
    setErro(false);
    setAberto((a) => !a);
  }

  function cancelar() {
    setAberto(false);
    setErro(false);
    discordo.current?.focus();
  }

  async function enviar(evento: FormEvent) {
    evento.preventDefault();
    if (ocupado) return;
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
    avisar('Motivo registrado. Obrigado: ele fica guardado com esta explicação.');
  }

  function marcar(valor: MotivoDoDiscordo, marcado: boolean) {
    setErro(false);
    setMotivos((atuais) => (marcado ? [...atuais.filter((m) => m !== valor), valor] : atuais.filter((m) => m !== valor)));
  }

  return (
    <>
      <div className="explica-rodape">
        <p className="explica-nota">
          A LIA é uma assistente de IA: ela só escreve. Os números são do sistema, conferidos antes de aparecer, e a decisão é sua.{' '}
          <a className="link-bt" href={`mailto:${SUPORTE_EMAIL}?subject=${encodeURIComponent('Quero falar com uma pessoa sobre uma explicação da LIA')}`}>
            Falar com uma pessoa
          </a>
        </p>
        {fase === 'registrado' ? (
          <p className="explica-opiniao" ref={registrado} tabIndex={-1}>
            <span className="st st--concluido">
              <Icone nome="check" pequeno />
              Motivo registrado
            </span>
          </p>
        ) : (
          <div className="explica-opiniao" role="group" aria-label="Esta explicação fez sentido?">
            <button className="btn btn--sm" type="button" aria-pressed={fase === 'fez_sentido'} aria-busy={ocupado && !aberto} onClick={() => disparar(fezSentido())}>
              <Icone nome="thumb-up" />
              Fez sentido
            </button>
            <button ref={discordo} className="btn btn--sm" type="button" aria-expanded={aberto} aria-controls={`disc-${id}`} onClick={alternarDiscordo}>
              <Icone nome="thumb-down" />
              Discordo
            </button>
          </div>
        )}
      </div>
      {fase !== 'registrado' && (
        <form className="discordar" id={`disc-${id}`} noValidate hidden={!aberto} onSubmit={(e) => disparar(enviar(e))}>
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
            <label htmlFor={`disc-txt-${id}`}>
              Quer contar mais? <span className="campo-dica">Opcional. Não escreva nome, telefone nem outro dado de cliente.</span>
            </label>
            <textarea
              className="area"
              id={`disc-txt-${id}`}
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
            <button className="btn btn--sm" type="button" onClick={cancelar}>
              Cancelar
            </button>
          </div>
        </form>
      )}
    </>
  );
}
