'use client';

import type { BudgetLimitsRequest } from '@liame/contracts';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { Icone } from '@/components/ui/icone';
import type { Problema } from '@/lib/api';
import { disparar } from '@/lib/disparar';
import { abaixoDoGasto, textoDaSoma } from './divisao';
import {
  type CampoDosLimites,
  conferirLimites,
  erroAoSalvarLimites,
  type FormDaDivisao,
  type LimitesDaVerba,
  reaisDigitados,
  reaisParaOCampo,
  somaDigitada,
} from './textos';

// O formulário dos dois limites da empresa (protótipo P9): o teto do mês e o teto por campanha, sempre juntos. Com a
// função `verba_por_plataforma` ligada (A4 · X9; P36, aprovado em 04/11/2026), a chave "Dividir por plataforma": ligada,
// cada plataforma de anúncio conectada ganha uma parte, e o teto do mês é a soma delas (D-A4-36), com a sugestão do
// plano do trimestre quando há um aprovado (D-A4-38). A tela confere os valores antes de enviar; quem decide é o
// servidor (`PUT /v1/budget/limits`, de quem gerencia o orçamento).

type Props = {
  limites: LimitesDaVerba;
  /** Os limites de agora, em micros (nulos enquanto a empresa não define). */
  atuais: { mes: number | null; campanha: number | null };
  /** O que a divisão precisa; nulo com a função desligada (o formulário fica como era). */
  divisao: FormDaDivisao | null;
  /** O formulário abre já com a chave ligada (o "Dividir por plataforma" e o "Mudar a divisão"). */
  comecarDividindo?: boolean;
  /** Salva e devolve o problema, se houve; sem problema, a tela fecha o formulário. */
  aoSalvar: (corpo: BudgetLimitsRequest) => Promise<Problema | null>;
  aoCancelar: () => void;
};

const emTexto = (valores: Record<string, number>): Record<string, string> => Object.fromEntries(Object.entries(valores).map(([k, v]) => [k, reaisParaOCampo(v)]));

export function FormLimites({ limites, atuais, divisao, comecarDividindo = false, aoSalvar, aoCancelar }: Props) {
  const [mes, setMes] = useState(() => reaisParaOCampo(atuais.mes));
  const [campanha, setCampanha] = useState(() => reaisParaOCampo(atuais.campanha));
  const [dividir, setDividir] = useState(() => divisao !== null && (divisao.dividida || comecarDividindo));
  const [partes, setPartes] = useState<Record<string, string>>(() => (divisao ? emTexto(divisao.inicial) : {}));
  const [erro, setErro] = useState<{ texto: string; campo: CampoDosLimites | null } | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const campoMes = useRef<HTMLInputElement>(null);
  const campoCampanha = useRef<HTMLInputElement>(null);
  const camposDasPartes = useRef(new Map<string, HTMLInputElement>());
  /** O envio foi recusado: depois do desenho, o foco vai para o campo marcado. */
  const focarOErro = useRef(false);
  /** Na abertura, a chave já vinha ligada: o foco vai para a primeira parte (o teto do mês é só leitura). */
  const abriuDividindo = useRef(dividir);
  const plataformas = divisao?.plataformas ?? [];
  const primeira = plataformas[0]?.provider ?? '';

  // Ao abrir, o foco vai para o primeiro campo que se digita.
  useEffect(() => {
    const alvo = abriuDividindo.current ? (camposDasPartes.current.get(primeira) ?? campoCampanha.current) : campoMes.current;
    alvo?.focus({ preventScroll: true });
  }, [primeira]);

  useEffect(() => {
    if (!erro || !focarOErro.current) return;
    focarOErro.current = false;
    const c = erro.campo;
    let alvo: HTMLInputElement | null | undefined = campoMes.current;
    if (c === 'campanha') alvo = campoCampanha.current;
    else if (c === 'partes') alvo = camposDasPartes.current.get(primeira);
    else if (c?.startsWith('parte:')) alvo = camposDasPartes.current.get(c.slice('parte:'.length));
    alvo?.focus({ preventScroll: true });
  }, [erro, primeira]);

  function recusar(texto: string, campo: CampoDosLimites | null) {
    focarOErro.current = campo !== null;
    setErro({ texto, campo });
  }

  async function salvar(e: FormEvent) {
    e.preventDefault();
    if (ocupado) return;
    const conferido = conferirLimites({
      mes,
      campanha,
      divisao: divisao ? { dividir, partes: plataformas.map((p) => ({ provider: p.provider, texto: partes[p.provider] ?? '' })), tinha: divisao.dividida } : null,
    });
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
  const soma = dividir ? somaDigitada(plataformas.map((p) => ({ texto: partes[p.provider] ?? '' }))) : null;
  const frase = textoDaSoma(soma, divisao?.tetoDeHoje ?? null);
  const invalida = (provider: string) => erro?.campo === `parte:${provider}` || (erro?.campo === 'partes' && provider === primeira);

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
            value={dividir ? (soma === null ? '' : reaisParaOCampo(soma)) : mes}
            readOnly={dividir}
            aria-invalid={erro?.campo === 'mes' ? true : undefined}
            aria-describedby={descricao('mes', 'lm-mes-dica')}
            onChange={(e) => {
              setMes(e.target.value);
              setErro(null);
            }}
          />
        </div>
        <p className="campo-dica" id="lm-mes-dica">
          {dividir ? 'A soma das partes. Para mudar, mude as partes abaixo.' : limites.dicaDoMes}
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
      {divisao && (
        <div className="limites-chave-linha">
          <button
            className="btn btn--sm"
            type="button"
            aria-pressed={dividir}
            onClick={() => {
              setErro(null);
              // Ligar sem nada digitado começa pela divisão proposta; desligar leva a soma para o teto do mês.
              if (!dividir && plataformas.every((p) => !(partes[p.provider] ?? '').trim())) setPartes(emTexto(divisao.inicial));
              if (dividir && soma !== null) setMes(reaisParaOCampo(soma));
              setDividir(!dividir);
            }}
          >
            <Icone nome={dividir ? 'check' : 'sliders'} pequeno />
            Dividir por plataforma
          </button>
          <span className="campo-dica">{dividir ? 'Ligado: o teto do mês é a soma das partes.' : 'Desligado: o teto do mês vale para todas as plataformas juntas.'}</span>
        </div>
      )}
      {divisao && dividir && (
        <fieldset className="limites-partes">
          <legend>Quanto vai para cada plataforma, por mês</legend>
          {plataformas.map((p) => {
            const aviso = abaixoDoGasto(p, reaisDigitados(partes[p.provider] ?? ''), divisao.nomeDoMes);
            const id = `lm-p-${p.provider}`;
            return (
              <div className="campo" key={p.provider}>
                <label htmlFor={id}>{p.nome}</label>
                <div className="pd-valor">
                  <span aria-hidden="true">R$</span>
                  <input
                    ref={(el) => {
                      if (el) camposDasPartes.current.set(p.provider, el);
                      else camposDasPartes.current.delete(p.provider);
                    }}
                    id={id}
                    inputMode="decimal"
                    autoComplete="off"
                    maxLength={14}
                    value={partes[p.provider] ?? ''}
                    aria-invalid={invalida(p.provider) ? true : undefined}
                    aria-describedby={[`${id}-dica`, aviso ? `${id}-aviso` : null, invalida(p.provider) ? 'lm-erro' : null].filter(Boolean).join(' ')}
                    onChange={(e) => {
                      const texto = e.target.value;
                      setPartes((antes) => ({ ...antes, [p.provider]: texto }));
                      setErro(null);
                    }}
                  />
                </div>
                <p className="campo-dica" id={`${id}-dica`}>
                  {p.dica}
                </p>
                {aviso && (
                  <p className="limites-abaixo" id={`${id}-aviso`}>
                    <Icone nome="alert" />
                    <span>{aviso}</span>
                  </p>
                )}
              </div>
            );
          })}
          <p className="limites-soma" aria-live="polite">
            {frase.valor === null ? (
              frase.resto
            ) : (
              <>
                Soma: <b>{frase.valor}</b>. {frase.resto}
              </>
            )}
          </p>
          {divisao.sugestao && (
            <div className="limites-sugestao">
              <Icone nome="compass" />
              <p>{divisao.sugestao.texto}</p>
              <button
                className="btn btn--sm"
                type="button"
                onClick={() => {
                  const sugerida = divisao.sugestao;
                  if (!sugerida) return;
                  setErro(null);
                  setPartes((antes) => ({ ...antes, ...emTexto(sugerida.valores) }));
                }}
              >
                Usar a divisão do plano
              </button>
            </div>
          )}
          <p className="campo-dica">As plataformas que você conectar depois, como o TikTok Ads, entram aqui quando o Liame passar a ler o gasto delas.</p>
        </fieldset>
      )}
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
