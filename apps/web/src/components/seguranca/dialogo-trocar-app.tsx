'use client';

import { type FormEvent, type RefObject, useEffect, useId, useRef, useState } from 'react';
import { QrCode } from '@/components/entrada/pecas';
import { Icone } from '@/components/ui/icone';
import { useDialogo } from '@/components/ui/use-dialogo';
import { api, chamar, mensagemDe, type Problema } from '@/lib/api';
import { disparar } from '@/lib/disparar';
import { ListaCodigos } from './lista-codigos';

// Trocar de celular (com o app antigo em mãos ou depois do pedido de 24 h) e ativar o app para quem não
// tem: o mesmo passo a passo da entrada (QR ou chave → código → 10 códigos de recuperação novos),
// dentro de um diálogo. A API decide se a troca pode (sessão confirmada pelo app ou pedido liberado).

type Passo = 1 | 2 | 3;
const PASSOS = ['Escanear', 'Confirmar', 'Guardar os códigos'] as const;

function gerarQr() {
  return chamar(() => api.POST('/v1/me/mfa/totp/setup'));
}

type Props = {
  modo: 'trocar' | 'ativar';
  reserva: RefObject<HTMLElement | null>;
  aoConcluir: () => void;
  aoFechar: () => void;
};

export function DialogoTrocarApp({ modo, reserva, aoConcluir, aoFechar }: Props) {
  const titulo = useRef<HTMLHeadingElement>(null);
  const campo = useRef<HTMLInputElement>(null);
  const { ref, fechar, devolverFoco } = useDialogo({ focoInicial: titulo, reserva });
  const ids = useId();
  const [passo, setPasso] = useState<Passo>(1);
  const [config, setConfig] = useState<{ secret: string; otpauth_uri: string } | null>(null);
  const [problema, setProblema] = useState<Problema | null>(null);
  const [codigo, setCodigo] = useState('');
  const [erroCampo, setErroCampo] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [codigos, setCodigos] = useState<string[]>([]);
  const [guardei, setGuardei] = useState(false);
  const [chaveCopiada, setChaveCopiada] = useState(false);
  const mudouPasso = useRef(false);
  const pedidoDoQr = useRef<ReturnType<typeof gerarQr> | null>(null);

  // QR novo ao abrir (segredo pendente até confirmar; o app atual continua valendo até lá). Um pedido só
  // por diálogo: o modo estrito roda o efeito duas vezes, e dois pedidos ao mesmo tempo colidem na API.
  useEffect(() => {
    let vivo = true;
    pedidoDoQr.current ??= gerarQr();
    disparar(
      pedidoDoQr.current.then((r) => {
        if (!vivo) return;
        if (r.ok) setConfig(r.data);
        else setProblema(r.problema);
      }),
    );
    return () => {
      vivo = false;
    };
  }, []);

  useEffect(() => {
    if (!mudouPasso.current) return;
    mudouPasso.current = false;
    (passo === 2 ? campo.current : titulo.current)?.focus();
  }, [passo]);

  function irPara(p: Passo) {
    mudouPasso.current = true;
    setErroCampo('');
    setPasso(p);
  }

  async function confirmar(e: FormEvent) {
    e.preventDefault();
    setErroCampo('');
    setProblema(null);
    if (!/^\d{6}$/.test(codigo)) {
      setErroCampo('O código tem 6 dígitos: digite ou cole o que o app novo mostra agora.');
      return campo.current?.focus();
    }
    setEnviando(true);
    const r = await chamar(() => api.POST('/v1/me/mfa/totp/confirm', { body: { code: codigo } }));
    setEnviando(false);
    if (!r.ok) {
      setCodigo('');
      if (r.problema.status === 401 || r.problema.errors?.some((x) => x.path === 'code')) {
        setErroCampo(mensagemDe(r.problema));
        return campo.current?.focus();
      }
      return setProblema(r.problema);
    }
    setCodigos(r.data.recovery_codes);
    aoConcluir();
    irPara(3);
  }

  async function copiarChave() {
    try {
      // nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_secret -- é a chave que a API acabou de gerar para esta pessoa (TotpSetupResponse), mostrada para ela digitar no app; nada fixo no código
      await navigator.clipboard.writeText(config?.secret ?? '');
      setChaveCopiada(true);
    } catch {
      setChaveCopiada(false);
    }
  }

  const chave = config?.secret.replace(/(.{4})/g, '$1 ').trim() ?? '';
  const nomeTitulo =
    passo === 3 ? 'Guarde os códigos de recuperação' : modo === 'trocar' ? 'Trocar o app autenticador' : 'Ativar o app autenticador';
  return (
    <dialog
      ref={ref}
      className="dialogo"
      aria-labelledby={`${ids}-t`}
      onClose={() => {
        aoFechar();
        devolverFoco();
      }}
      onClick={(e) => {
        // Clicar fora só fecha antes de confirmar: depois, os códigos não aparecem de novo.
        if (e.target === ref.current && !enviando && passo !== 3) fechar();
      }}
    >
      <form className="dialogo-form" onSubmit={(e) => disparar(confirmar(e))} noValidate>
        <div className="dialogo-cab">
          <h2 id={`${ids}-t`} ref={titulo} tabIndex={-1}>
            {nomeTitulo}
          </h2>
          <button className="btn btn--ghost btn--icon" type="button" onClick={fechar} aria-label="Fechar" disabled={enviando}>
            <Icone nome="x" />
          </button>
        </div>
        <div className="dialogo-corpo">
          <ol className="passos" aria-label="Etapas">
            {PASSOS.map((rotulo, i) => {
              const n = (i + 1) as Passo;
              return (
                <li
                  key={rotulo}
                  className="passo"
                  data-estado={n < passo ? 'feito' : n === passo ? 'atual' : undefined}
                  aria-current={n === passo ? 'step' : undefined}
                >
                  {n}. {rotulo}
                </li>
              );
            })}
          </ol>
          {problema && (
            <p className="dialogo-erro" role="alert">
              <Icone nome="alert" pequeno />
              <span>
                <b>{problema.title}.</b> {problema.detail}
              </span>
            </p>
          )}

          {passo === 1 && (
            <>
              <p>
                {modo === 'trocar'
                  ? 'Adicione o Liame no app do celular novo. O app antigo continua valendo até você confirmar o código do novo.'
                  : 'O app gera um código novo a cada 30 segundos, e só quem está com o seu celular entra. Leva um minuto.'}
              </p>
              {config ? (
                <div className="qr-caixa">
                  <QrCode texto={config.otpauth_uri} rotulo="QR para adicionar o Liame no app autenticador" />
                  <div className="chave">
                    <p>Aponte a câmera do app para o QR. Não consegue ler? Digite esta chave no app:</p>
                    <code>{chave}</code>
                    <button className="btn btn--sm" type="button" onClick={() => disparar(copiarChave())}>
                      <Icone nome="copy" pequeno />
                      {chaveCopiada ? 'Chave copiada' : 'Copiar a chave'}
                    </button>
                  </div>
                </div>
              ) : (
                !problema && (
                  <p className="rotulo-marca" aria-busy="true">
                    Gerando o QR…
                  </p>
                )
              )}
              <p className="apps">Funciona com Google Authenticator, Microsoft Authenticator, 1Password, Bitwarden e outros apps de código.</p>
            </>
          )}

          {passo === 2 && (
            <>
              <p>Digite o código que aparece no app{modo === 'trocar' ? ' novo' : ''} agora. Assim confirmamos que ficou certo.</p>
              <div className="campo">
                <label htmlFor={`${ids}-cod`}>Código de 6 dígitos</label>
                <input
                  ref={campo}
                  className="input mono"
                  id={`${ids}-cod`}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9]*"
                  maxLength={7}
                  placeholder="000000"
                  value={codigo}
                  onChange={(e) => setCodigo(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  aria-invalid={erroCampo ? true : undefined}
                  aria-describedby={erroCampo ? `${ids}-cod-erro` : undefined}
                />
                {erroCampo && (
                  <p className="campo-erro" id={`${ids}-cod-erro`}>
                    {erroCampo}
                  </p>
                )}
              </div>
            </>
          )}

          {passo === 3 && (
            <>
              <p className="seg-ok" role="status">
                <Icone nome="check" pequeno />
                <span>
                  {modo === 'trocar' ? 'App trocado. O app antigo deixou de valer.' : 'App autenticador ativo. Entrar passa a pedir o código dele.'}
                </span>
              </p>
              <p>
                Os códigos de recuperação também são novos (os antigos deixaram de valer). Eles aparecem <b>uma vez só</b>.
              </p>
              <div className="seg-codigos">
                <ListaCodigos codigos={codigos} />
              </div>
              <label className="check">
                <input type="checkbox" checked={guardei} onChange={(e) => setGuardei(e.target.checked)} /> Guardei os códigos num lugar seguro
              </label>
            </>
          )}
        </div>
        <div className="dialogo-acoes">
          {passo === 1 && (
            <>
              <button className="btn" type="button" onClick={fechar}>
                Cancelar
              </button>
              <button className="btn btn--primary" type="button" disabled={!config} onClick={() => irPara(2)}>
                Já adicionei no app
              </button>
            </>
          )}
          {passo === 2 && (
            <>
              <button className="btn" type="button" onClick={() => irPara(1)} disabled={enviando}>
                Voltar ao QR
              </button>
              <button className="btn btn--primary" type="submit" disabled={enviando} aria-busy={enviando}>
                {enviando ? 'Confirmando…' : modo === 'trocar' ? 'Trocar o app' : 'Ativar o app'}
              </button>
            </>
          )}
          {passo === 3 && (
            <button className="btn btn--primary" type="button" disabled={!guardei} onClick={fechar}>
              Concluir
            </button>
          )}
        </div>
      </form>
    </dialog>
  );
}
