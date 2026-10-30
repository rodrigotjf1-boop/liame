'use client';

import { type FormEvent, useEffect, useId, useRef, useState } from 'react';
import { instanteNoFuso, noFuso } from '@/components/agenda/textos';
import { Icone } from '@/components/ui/icone';
import { disparar } from '@/lib/disparar';
import type { Feito } from './detalhe-mensagem';
import { erroDaHoraNova } from './post-textos';

// "Mudar a hora" do post aprovado que espera a hora (P19, aprovado pelo dono em 21/10/2026; A6, Z5d, parte 4; D-A6-23 e
// D-A6-55): o dia, a hora (das 8h às 22h, no fuso da empresa) e o código do app, porque a hora muda quem vê o post e a
// aprovação vale de novo. Abre com o foco no dia; a recusa (o código que não confere, a hora fora) fica embaixo, com o
// foco no campo dela.

type Props = {
  /** O id do formulário (o botão "Mudar a hora" aponta para ele em `aria-controls`). */
  id: string;
  post: { publish_at: string; timezone: string };
  agora: Date;
  aoMudar: (publishAt: string, codigo: string) => Promise<Feito>;
};

export function MudarAHora({ id, post, agora, aoMudar }: Props) {
  const ids = useId();
  const atual = noFuso(new Date(post.publish_at), post.timezone);
  const hoje = noFuso(agora, post.timezone).dia;
  const [dia, setDia] = useState(atual.dia);
  const [hora, setHora] = useState(atual.hora);
  const [codigo, setCodigo] = useState('');
  const [erro, setErro] = useState<{ campo: 'dia' | 'hora' | 'codigo'; texto: string } | null>(null);
  const [enviando, setEnviando] = useState(false);
  const campos = { dia: useRef<HTMLInputElement>(null), hora: useRef<HTMLInputElement>(null), codigo: useRef<HTMLInputElement>(null) };
  // O foco vai para o campo depois do commit (V27, ERR-185).
  const [focar, setFocar] = useState<{ campo: 'dia' | 'hora' | 'codigo'; n: number }>({ campo: 'dia', n: 1 });
  useEffect(() => {
    campos[focar.campo].current?.focus();
  }, [focar]);

  async function enviar() {
    const local = erroDaHoraNova({ dia, hora, codigo }, post, new Date());
    if (local) {
      setErro(local);
      setFocar((f) => ({ campo: local.campo, n: f.n + 1 }));
      return;
    }
    setEnviando(true);
    setErro(null);
    const r = await aoMudar(instanteNoFuso(dia, hora, post.timezone).toISOString(), codigo);
    setEnviando(false);
    if (!r.ok) {
      setErro({ campo: 'codigo', texto: r.texto });
      setCodigo('');
      setFocar((f) => ({ campo: 'codigo', n: f.n + 1 }));
    }
  }

  const descrito = (campo: 'dia' | 'hora' | 'codigo') => (erro?.campo === campo ? { 'aria-invalid': true as const, 'aria-describedby': `${ids}-erro` } : {});
  return (
    <form
      className="po-hora po-mudar"
      id={id}
      noValidate
      aria-label="Mudar a hora do post"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        disparar(enviar());
      }}
    >
      <div className="campo">
        <label htmlFor={`${ids}-dia`}>Dia</label>
        <input ref={campos.dia} className="input" type="date" id={`${ids}-dia`} value={dia} min={hoje} onChange={(e) => setDia(e.target.value)} disabled={enviando} {...descrito('dia')} />
      </div>
      <div className="campo">
        <label htmlFor={`${ids}-hora`}>Hora</label>
        <input
          ref={campos.hora}
          className="input"
          type="time"
          id={`${ids}-hora`}
          value={hora}
          min="08:00"
          max="22:00"
          step={900}
          onChange={(e) => setHora(e.target.value)}
          disabled={enviando}
          {...descrito('hora')}
        />
      </div>
      <div className="campo">
        <label htmlFor={`${ids}-codigo`}>Código do app</label>
        <input
          ref={campos.codigo}
          className="input mono"
          id={`${ids}-codigo`}
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          placeholder="000000"
          value={codigo}
          onChange={(e) => setCodigo(e.target.value.replace(/\D/g, ''))}
          disabled={enviando}
          {...descrito('codigo')}
        />
      </div>
      {erro && (
        <span className="campo-erro" id={`${ids}-erro`} role="alert">
          {erro.texto}
        </span>
      )}
      <button className="btn btn--primary" type="submit" disabled={enviando}>
        <Icone nome="check" pequeno />
        {enviando ? 'Mudando…' : 'Mudar a hora'}
      </button>
    </form>
  );
}
