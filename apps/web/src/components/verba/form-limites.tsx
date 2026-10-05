'use client';

import type { BudgetLimitsRequest } from '@liame/contracts';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { Icone } from '@/components/ui/icone';
import type { Problema } from '@/lib/api';
import { disparar } from '@/lib/disparar';
import { type CampoDosLimites, conferirLimites, erroAoSalvarLimites, type LimitesDaVerba, reaisParaOCampo } from './textos';

// O formulário dos dois limites da empresa (protótipo P9): o teto do mês e o teto por campanha, sempre juntos. A tela
// confere os valores antes de enviar; quem decide é o servidor (`PUT /v1/budget/limits`, de quem gerencia o orçamento).

type Props = {
  limites: LimitesDaVerba;
  /** Os limites de agora, em micros (nulos enquanto a empresa não define). */
  atuais: { mes: number | null; campanha: number | null };
  /** Salva e devolve o problema, se houve; sem problema, a tela fecha o formulário. */
  aoSalvar: (corpo: BudgetLimitsRequest) => Promise<Problema | null>;
  aoCancelar: () => void;
};

export function FormLimites({ limites, atuais, aoSalvar, aoCancelar }: Props) {
  const [mes, setMes] = useState(() => reaisParaOCampo(atuais.mes));
  const [campanha, setCampanha] = useState(() => reaisParaOCampo(atuais.campanha));
  const [erro, setErro] = useState<{ texto: string; campo: CampoDosLimites | null } | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const campoMes = useRef<HTMLInputElement>(null);
  const campoCampanha = useRef<HTMLInputElement>(null);
  /** O envio foi recusado: depois do desenho, o foco vai para o campo marcado. */
  const focarOErro = useRef(false);

  // Ao abrir, o foco vai para o primeiro campo.
  useEffect(() => {
    campoMes.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    if (!erro || !focarOErro.current) return;
    focarOErro.current = false;
    (erro.campo === 'campanha' ? campoCampanha : campoMes).current?.focus({ preventScroll: true });
  }, [erro]);

  function recusar(texto: string, campo: CampoDosLimites | null) {
    focarOErro.current = campo !== null;
    setErro({ texto, campo });
  }

  async function salvar(e: FormEvent) {
    e.preventDefault();
    if (ocupado) return;
    const conferido = conferirLimites({ mes, campanha });
    if (!conferido.ok) return recusar(conferido.erro, conferido.campo);
    setErro(null);
    setOcupado(true);
    const problema = await aoSalvar(conferido.corpo);
    setOcupado(false);
    if (problema) {
      const r = erroAoSalvarLimites(problema);
      recusar(r.erro, r.campo);
    }
  }

  const descricao = (campo: CampoDosLimites, dica: string) => (erro?.campo === campo ? `${dica} lm-erro` : dica);

  return (
    <form className="limites-form" noValidate onSubmit={(e) => disparar(salvar(e))}>
      <div className="campo">
        <label htmlFor="lm-mes">Teto do mês</label>
        <div className="pd-valor">
          <span aria-hidden="true">R$</span>
          <input
            ref={campoMes}
            id="lm-mes"
            inputMode="decimal"
            autoComplete="off"
            maxLength={14}
            value={mes}
            aria-invalid={erro?.campo === 'mes' ? true : undefined}
            aria-describedby={descricao('mes', 'lm-mes-dica')}
            onChange={(e) => {
              setMes(e.target.value);
              setErro(null);
            }}
          />
        </div>
        <p className="campo-dica" id="lm-mes-dica">
          {limites.dicaDoMes}
        </p>
      </div>
      <div className="campo">
        <label htmlFor="lm-camp">Teto por campanha</label>
        <div className="pd-valor">
          <span aria-hidden="true">R$</span>
          <input
            ref={campoCampanha}
            id="lm-camp"
            inputMode="decimal"
            autoComplete="off"
            maxLength={14}
            value={campanha}
            aria-invalid={erro?.campo === 'campanha' ? true : undefined}
            aria-describedby={descricao('campanha', 'lm-camp-dica')}
            onChange={(e) => {
              setCampanha(e.target.value);
              setErro(null);
            }}
          />
        </div>
        <p className="campo-dica" id="lm-camp-dica">
          {limites.dicaDaCampanha}
        </p>
      </div>
      {erro && (
        <p className="campo-erro" id="lm-erro" role="alert">
          {erro.texto}
        </p>
      )}
      <div className="limites-acoes">
        <button className="btn btn--primary btn--sm" type="submit" disabled={ocupado} aria-busy={ocupado}>
          {ocupado ? 'Salvando…' : 'Salvar os limites'}
        </button>
        <button className="btn btn--sm" type="button" onClick={aoCancelar} disabled={ocupado}>
          Cancelar
        </button>
      </div>
      <p className="nota">
        <Icone nome="info" />
        <span>Os limites valem na hora, para os próximos pedidos. A mudança fica na auditoria, com o seu nome.</span>
      </p>
    </form>
  );
}
