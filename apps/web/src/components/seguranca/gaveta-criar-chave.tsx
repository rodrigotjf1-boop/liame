'use client';

import type { CreatePasskeyResponse, PasskeyAssertion, PasskeyCeremony, PasskeyRegistrationOptionsRequest } from '@liame/contracts';
import { type FormEvent, type RefObject, useEffect, useId, useRef, useState } from 'react';
import { Icone } from '@/components/ui/icone';
import { useDialogo } from '@/components/ui/use-dialogo';
import { api, chamar, mensagemDe } from '@/lib/api';
import { criarAChave, fraseDoMotivo } from '@/lib/chave-de-acesso';
import { disparar } from '@/lib/disparar';
import { AVISO_DE_CRIADA, erroDoNome, PASSOS_DE_CRIAR } from './chaves-textos';
import { ConfirmarComChave } from './confirmar-com-chave';
import { ListaCodigos } from './lista-codigos';

// "Criar uma chave de acesso" (A7, W9, parte 9c1; P28 aprovado, gaveta à direita; D-A7-54 e D-A7-57), em três passos:
// confirmar que é você (o código do app, ou uma chave que você já tem); a janela do aparelho; o nome da chave. Quem ainda
// não tem segundo fator começa no aparelho. A primeira chave de quem não tem o app traz os 10 códigos de recuperação,
// mostrados uma vez só, antes do nome.

type Props = {
  temApp: boolean;
  temChave: boolean;
  reserva: RefObject<HTMLElement | null>;
  /** A chave foi criada (a lista recarrega); o aviso sai ao fechar. */
  aoCriar: () => void;
  aoFechar: (aviso: string | null) => void;
};

type Passo = 1 | 2 | 3;

export function GavetaCriarChave({ temApp, temChave, reserva, aoCriar, aoFechar }: Props) {
  const ids = useId();
  const confirmar = temApp || temChave;
  const { ref, fechar, devolverFoco } = useDialogo({ reserva });
  const [passo, setPasso] = useState<Passo>(confirmar ? 1 : 2);
  const [codigo, setCodigo] = useState('');
  const [erroCodigo, setErroCodigo] = useState('');
  const [erro, setErro] = useState('');
  const [aviso, setAviso] = useState('');
  const [ocupado, setOcupado] = useState(false);
  const [cerimonia, setCerimonia] = useState<PasskeyCeremony | null>(null);
  const [criada, setCriada] = useState<CreatePasskeyResponse | null>(null);
  const [nome, setNome] = useState('');
  const [erroNome, setErroNome] = useState('');
  const [guardei, setGuardei] = useState(false);
  const resultado = useRef<string | null>(null);
  const passos = confirmar ? PASSOS_DE_CRIAR : PASSOS_DE_CRIAR.slice(1);
  const atual = confirmar ? passo : passo - 1;

  // Cada passo começa com o foco no que se faz nele (o campo do código, o botão do aparelho, o nome).
  useEffect(() => {
    const alvo = ref.current?.querySelector<HTMLElement>('[data-foco]');
    alvo?.focus();
  }, [passo, ref]);

  /** O desafio do cadastro, com a confirmação (ou sem ela, para quem ainda não tem segundo fator). */
  async function abrirCerimonia(prova: PasskeyRegistrationOptionsRequest): Promise<boolean> {
    const r = await chamar(() => api.POST('/v1/me/passkeys/registration-options', { body: prova }));
    if (!r.ok) {
      if (r.problema.status === 401 || r.problema.errors?.some((x) => x.path === 'code')) {
        setErroCodigo(mensagemDe(r.problema));
        setCodigo('');
      } else setErro(mensagemDe(r.problema));
      return false;
    }
    setCerimonia(r.data);
    setErro('');
    setPasso(2);
    return true;
  }

  async function comCodigo(e: FormEvent) {
    e.preventDefault();
    setErroCodigo('');
    setErro('');
    if (!/^\d{6}$/.test(codigo)) {
      setErroCodigo('O código tem 6 dígitos: digite ou cole o que o app mostra agora.');
      return ref.current?.querySelector<HTMLElement>('[data-foco]')?.focus();
    }
    setOcupado(true);
    await abrirCerimonia({ code: codigo });
    setOcupado(false);
  }

  async function comChave(passkey: PasskeyAssertion) {
    setErro('');
    await abrirCerimonia({ passkey });
  }

  async function noAparelho() {
    setErro('');
    setAviso('');
    setOcupado(true);
    try {
      // Quem não confirmou antes (sem segundo fator) pede o desafio aqui.
      let c = cerimonia;
      if (!c) {
        const r = await chamar(() => api.POST('/v1/me/passkeys/registration-options', { body: {} }));
        if (!r.ok) return setErro(mensagemDe(r.problema));
        c = r.data;
        setCerimonia(c);
      }
      const aparelho = await criarAChave(c.options);
      if (!aparelho.ok) {
        if (aparelho.motivo === 'cancelou') return setAviso('Você fechou a janela do aparelho. Nada foi criado.');
        return setErro(fraseDoMotivo(aparelho.motivo, 'use outro aparelho'));
      }
      const r = await chamar(() => api.POST('/v1/me/passkeys', { body: { challenge_id: c.challenge_id, response: aparelho.resposta } }));
      if (!r.ok) {
        // O desafio venceu (a janela ficou aberta demais): recomeça do primeiro passo.
        if (r.problema.code === 'desafio-vencido') {
          setCerimonia(null);
          setPasso(confirmar ? 1 : 2);
        }
        return setErro(mensagemDe(r.problema));
      }
      setCriada(r.data);
      setNome(r.data.passkey.name);
      resultado.current = AVISO_DE_CRIADA;
      setPasso(3);
      aoCriar();
    } finally {
      setOcupado(false);
    }
  }

  async function salvarNome(e: FormEvent) {
    e.preventDefault();
    if (!criada) return;
    const problema = erroDoNome(nome);
    if (problema) {
      setErroNome(problema);
      return ref.current?.querySelector<HTMLElement>('[data-foco]')?.focus();
    }
    if (nome.trim() !== criada.passkey.name) {
      setOcupado(true);
      const r = await chamar(() => api.PATCH('/v1/me/passkeys/{id}', { params: { path: { id: criada.passkey.id } }, body: { name: nome.trim() } }));
      setOcupado(false);
      if (!r.ok) {
        setErroNome(mensagemDe(r.problema));
        return ref.current?.querySelector<HTMLElement>('[data-foco]')?.focus();
      }
      aoCriar();
    }
    fechar();
  }

  const codigosNaTela = !!criada?.recovery_codes;
  return (
    <dialog
      ref={ref}
      className="dialogo dialogo--lado"
      aria-labelledby={`${ids}-t`}
      onClose={() => {
        aoFechar(resultado.current);
        devolverFoco();
      }}
      onClick={(e) => {
        // Com os códigos na tela, clicar fora não fecha: eles não aparecem de novo.
        if (e.target === ref.current && !ocupado && !codigosNaTela) fechar();
      }}
    >
      <form className="dialogo-form" onSubmit={(e) => disparar(passo === 1 ? comCodigo(e) : salvarNome(e))} noValidate>
        <div className="dialogo-cab">
          <h2 id={`${ids}-t`}>Criar uma chave de acesso</h2>
          <button className="btn btn--ghost btn--icon" type="button" onClick={fechar} aria-label="Fechar" disabled={ocupado || (codigosNaTela && !guardei)}>
            <Icone nome="x" />
          </button>
        </div>
        <div className="dialogo-corpo">
          <ol className="chave-acesso-passos" aria-label="Passos">
            {passos.map((p, i) => (
              <li key={p} aria-current={i + 1 === atual ? 'step' : undefined}>
                <span className="chave-acesso-passo-n">{i + 1}</span>
                {p}
              </li>
            ))}
          </ol>
          {erro && (
            <p className="dialogo-erro" role="alert">
              <Icone nome="alert" pequeno />
              <span>{erro}</span>
            </p>
          )}

          {passo === 1 && temApp && (
            <>
              <p className="seg-txt">Antes de criar, confirme que é você.</p>
              <div className="campo">
                <label htmlFor={`${ids}-cod`}>Código do app autenticador</label>
                <input
                  data-foco
                  className="input mono"
                  id={`${ids}-cod`}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9]*"
                  maxLength={7}
                  placeholder="000000"
                  value={codigo}
                  onChange={(e) => setCodigo(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  aria-invalid={erroCodigo ? true : undefined}
                  aria-describedby={erroCodigo ? `${ids}-cod-erro` : undefined}
                />
                {erroCodigo && (
                  <p className="campo-erro" id={`${ids}-cod-erro`}>
                    {erroCodigo}
                  </p>
                )}
              </div>
              {temChave && (
                <ConfirmarComChave
                  primario={false}
                  rotulo="Confirmar com uma chave que você já tem"
                  impedido={ocupado}
                  aoErro={setErro}
                  aoProvar={comChave}
                />
              )}
            </>
          )}
          {passo === 1 && !temApp && (
            <>
              <p className="seg-txt">Antes de criar, confirme que é você com a chave que você já tem.</p>
              <ConfirmarComChave focoInicial alternativa="tente outro aparelho com a sua chave" aoErro={setErro} aoProvar={comChave} />
            </>
          )}

          {passo === 2 && (
            <>
              <p className="seg-txt">
                Agora o seu aparelho pergunta onde guardar a chave e pede a digital, o rosto ou o PIN. No celular, ela pode ficar sincronizada na
                conta do Google ou da Apple; numa chave física, ela fica só nela.
              </p>
              {aviso && (
                <p className="aviso-seg aviso-seg--atencao" role="status">
                  {aviso}
                </p>
              )}
            </>
          )}

          {passo === 3 && criada && (
            <>
              <p className="aviso-seg aviso-seg--ok" role="status">
                <b>Chave criada no {criada.passkey.name}.</b>
                <span>Dê um nome para reconhecer depois.</span>
              </p>
              {criada.recovery_codes && (
                <>
                  <p className="seg-txt">
                    Como você ainda não tem o app, estes são os seus <b>10 códigos de recuperação</b>: com eles você entra se perder os aparelhos
                    com chave. Eles aparecem <b>uma vez só</b>.
                  </p>
                  <div className="seg-codigos">
                    <ListaCodigos codigos={criada.recovery_codes} />
                  </div>
                  <label className="check">
                    <input type="checkbox" checked={guardei} onChange={(e) => setGuardei(e.target.checked)} /> Guardei os códigos num lugar seguro
                  </label>
                </>
              )}
              <div className="campo">
                <label htmlFor={`${ids}-nome`}>Nome da chave</label>
                <input
                  data-foco
                  className="input"
                  id={`${ids}-nome`}
                  value={nome}
                  maxLength={60}
                  onChange={(e) => setNome(e.target.value)}
                  aria-invalid={erroNome ? true : undefined}
                  aria-describedby={`${ids}-nome-dica${erroNome ? ` ${ids}-nome-erro` : ''}`}
                />
                <p className="campo-dica" id={`${ids}-nome-dica`}>
                  Veio do aparelho. Dá para trocar, como &quot;Celular do trabalho&quot;.
                </p>
                {erroNome && (
                  <p className="campo-erro" id={`${ids}-nome-erro`}>
                    {erroNome}
                  </p>
                )}
              </div>
            </>
          )}
        </div>
        <div className="dialogo-acoes">
          {passo === 1 && (
            <>
              <button className="btn" type="button" onClick={fechar} disabled={ocupado}>
                Cancelar
              </button>
              {temApp && (
                <button className="btn btn--primary" type="submit" disabled={ocupado} aria-busy={ocupado}>
                  {ocupado ? 'Conferindo…' : 'Continuar'}
                </button>
              )}
            </>
          )}
          {passo === 2 && (
            <>
              <button className="btn" type="button" onClick={fechar} disabled={ocupado}>
                Cancelar
              </button>
              <button data-foco className="btn btn--primary" type="button" onClick={() => disparar(noAparelho())} disabled={ocupado} aria-busy={ocupado}>
                <Icone nome="key" />
                {ocupado ? 'Esperando o aparelho…' : 'Criar a chave'}
              </button>
            </>
          )}
          {passo === 3 && (
            <button className="btn btn--primary" type="submit" disabled={ocupado || (codigosNaTela && !guardei)} aria-busy={ocupado}>
              {ocupado ? 'Salvando…' : 'Salvar'}
            </button>
          )}
        </div>
      </form>
    </dialog>
  );
}
