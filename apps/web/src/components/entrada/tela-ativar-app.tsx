'use client';

import type { MeResponse } from '@liame/contracts';
import { useRouter, useSearchParams } from 'next/navigation';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { Icone } from '@/components/ui/icone';
import { api, chamar, type Problema } from '@/lib/api';
import { disparar } from '@/lib/disparar';
import { voltaSegura } from '@/lib/entrada';
import { NIVEIS } from '@/lib/niveis';
import { useCena, useLia } from './lia';
import { Aviso, AvisoProblema, BotaoEnviar, QrCode } from './pecas';

// Ativar o app autenticador (ADR-013): QR (ou a chave), um código para confirmar e os 10 códigos de
// recuperação, mostrados uma vez só.

type Passo = 1 | 2 | 3;
const FALAS: Record<Passo, string> = {
  1: 'Vamos proteger a sua conta. Eu espero aqui.',
  2: 'Agora o código que o app mostra. Assim eu sei que ficou certo.',
  3: 'Guarde esses códigos. Se o celular sumir, são eles que abrem a conta.',
};

export function TelaAtivarApp() {
  const router = useRouter();
  const volta = voltaSegura(useSearchParams().get('volta'));
  const lia = useLia();

  const [me, setMe] = useState<MeResponse | null>(null);
  const [passo, setPasso] = useState<Passo>(1);
  const [config, setConfig] = useState<{ secret: string; otpauth_uri: string } | null>(null);
  const [codigo, setCodigo] = useState('');
  const [codigos, setCodigos] = useState<string[]>([]);
  const [guardei, setGuardei] = useState(false);
  const [problema, setProblema] = useState<Problema | null>(null);
  const [enviando, setEnviando] = useState(false);
  const [copiado, setCopiado] = useState<'chave' | 'codigos' | null>(null);
  const titulo = useRef<HTMLHeadingElement>(null);
  const campo = useRef<HTMLInputElement>(null);
  const mudouPasso = useRef(false);
  useCena(FALAS[passo], passo === 1 ? 'wave' : 'idle');

  // Quem já tem o app vai para o código (ou segue); sem sessão, para a entrada.
  useEffect(() => {
    let viva = true;
    disparar(
      chamar(() => api.GET('/v1/me')).then(async (r) => {
        if (!viva) return;
        if (!r.ok) return router.replace(`/entrar?volta=${encodeURIComponent(volta)}`);
        if (r.data.mfa === 'required') return router.replace(`/segundo-fator?volta=${encodeURIComponent(volta)}`);
        if (r.data.mfa === 'verified') return router.replace(volta);
        setMe(r.data);
        const s = await chamar(() => api.POST('/v1/me/mfa/totp/setup'));
        if (!viva) return;
        if (s.ok) setConfig(s.data);
        else setProblema(s.problema);
      }),
    );
    return () => {
      viva = false;
    };
  }, [router, volta]);

  useEffect(() => {
    if (mudouPasso.current) (passo === 2 ? campo.current : titulo.current)?.focus();
    mudouPasso.current = false;
  }, [passo]);

  function irPara(p: Passo) {
    mudouPasso.current = true;
    setProblema(null);
    setPasso(p);
  }

  async function ativar(e: FormEvent) {
    e.preventDefault();
    setProblema(null);
    if (codigo.length !== 6) {
      setProblema({ status: 0, code: 'codigo', title: 'O código tem 6 dígitos', detail: 'Digite ou cole o código que o app mostra agora.' });
      return campo.current?.focus();
    }
    setEnviando(true);
    lia.reagir('think');
    const r = await chamar(() => api.POST('/v1/me/mfa/totp/confirm', { body: { code: codigo } }));
    setEnviando(false);
    if (!r.ok) {
      setCodigo('');
      setProblema(r.problema);
      lia.reagir('empathetic', 2800);
      return campo.current?.focus();
    }
    setCodigos(r.data.recovery_codes);
    lia.reagir('celebrate', 2600);
    irPara(3);
  }

  async function copiar(texto: string, qual: 'chave' | 'codigos') {
    try {
      await navigator.clipboard.writeText(texto);
      setCopiado(qual);
    } catch {
      setCopiado(null);
    }
  }

  function copiarChave() {
    // nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_secret -- é a chave que a API acabou de gerar para esta pessoa (TotpSetupResponse), mostrada para ela digitar no app; nada fixo no código
    disparar(copiar(config?.secret ?? '', 'chave'));
  }

  function baixar() {
    const txt = `Liame · códigos de recuperação (cada um vale uma vez)\n\n${codigos.join('\n')}\n`;
    const url = URL.createObjectURL(new Blob([txt], { type: 'text/plain;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'liame-codigos-de-recuperacao.txt';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const empresa = me?.organizations.find((o) => o.id === me.active_organization_id);
  const chave = config?.secret.replace(/(.{4})/g, '$1 ').trim() ?? '';
  return (
    <section className="tela" aria-labelledby="t-ativar">
      <ol className="passos" aria-label="Etapas">
        {(['Escanear', 'Confirmar', 'Guardar os códigos'] as const).map((rotulo, i) => {
          const n = (i + 1) as Passo;
          return (
            <li key={rotulo} className="passo" data-estado={n < passo ? 'feito' : n === passo ? 'atual' : undefined} aria-current={n === passo ? 'step' : undefined}>
              {n}. {rotulo}
            </li>
          );
        })}
      </ol>

      {passo === 1 && (
        <>
          <div className="tela-cab">
            <h1 id="t-ativar" ref={titulo} tabIndex={-1}>
              Proteja a sua conta com o app autenticador
            </h1>
            <p>
              {me?.mfa_enrollment_required && empresa
                ? `O seu nível na ${empresa.name} (${NIVEIS[empresa.role].nome}) aprova gastos ou cuida da conta: nele, o app é obrigatório. Leva um minuto.`
                : 'O app gera um código novo a cada 30 segundos, e só quem está com o seu celular entra. Leva um minuto.'}
            </p>
          </div>
          <AvisoProblema problema={problema} />
          {config ? (
            <div className="qr-caixa">
              <QrCode texto={config.otpauth_uri} rotulo="QR para adicionar o Liame no app autenticador" />
              <div className="chave">
                <p>Aponte a câmera do app para o QR. Não consegue ler? Digite esta chave no app:</p>
                <code>{chave}</code>
                <button className="btn btn--sm" type="button" onClick={copiarChave}>
                  <Icone nome="copy" pequeno />
                  {copiado === 'chave' ? 'Chave copiada' : 'Copiar a chave'}
                </button>
              </div>
            </div>
          ) : (
            !problema && <p className="rotulo-marca" aria-busy="true">Gerando o QR…</p>
          )}
          <p className="apps">Funciona com Google Authenticator, Microsoft Authenticator, 1Password, Bitwarden e outros apps de código.</p>
          <button className="btn btn--primary btn--largo" type="button" disabled={!config} onClick={() => irPara(2)}>
            Já adicionei no app
          </button>
        </>
      )}

      {passo === 2 && (
        <>
          <div className="tela-cab">
            <h1 id="t-ativar" ref={titulo} tabIndex={-1}>
              Digite o código que aparece no app
            </h1>
            <p>Assim confirmamos que o app ficou certo.</p>
          </div>
          <AvisoProblema problema={problema} />
          <form className="form" onSubmit={(e) => disparar(ativar(e))} noValidate>
            <div className="campo">
              <label htmlFor="c-ativar">Código de 6 dígitos</label>
              <input
                ref={campo}
                className="input codigo"
                id="c-ativar"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]*"
                maxLength={7}
                placeholder="000000"
                value={codigo}
                onChange={(e) => setCodigo(e.target.value.replace(/\D/g, '').slice(0, 6))}
                aria-invalid={problema ? true : undefined}
              />
            </div>
            <BotaoEnviar enviando={enviando}>Ativar o app</BotaoEnviar>
          </form>
          <p className="alternativa">
            <button className="link-bt" type="button" onClick={() => irPara(1)}>
              Voltar ao QR
            </button>
          </p>
        </>
      )}

      {passo === 3 && (
        <>
          <div className="tela-cab">
            <h1 id="t-ativar" ref={titulo} tabIndex={-1}>
              Guarde os códigos de recuperação
            </h1>
            <p>
              Se você perder o celular, eles abrem a sua conta. Cada código vale uma vez, e eles <b>não aparecem de novo</b>.
            </p>
          </div>
          <Aviso tipo="ok" titulo="App autenticador ativo">
            A partir de agora, entrar pede o código do app.
          </Aviso>
          <ol className="codigos" aria-label="Códigos de recuperação">
            {codigos.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ol>
          <div className="acoes-linha">
            <button className="btn btn--sm" type="button" onClick={() => disparar(copiar(codigos.join('\n'), 'codigos'))}>
              <Icone nome="copy" pequeno />
              {copiado === 'codigos' ? 'Copiados' : 'Copiar'}
            </button>
            <button className="btn btn--sm" type="button" onClick={baixar}>
              <Icone nome="download" pequeno />
              Baixar arquivo
            </button>
          </div>
          <label className="check">
            <input type="checkbox" checked={guardei} onChange={(e) => setGuardei(e.target.checked)} /> Guardei os códigos num lugar seguro
            (gerenciador de senhas ou papel guardado)
          </label>
          <button className="btn btn--primary btn--largo" type="button" disabled={!guardei} onClick={() => router.replace(volta)}>
            Continuar para o Liame
          </button>
        </>
      )}
    </section>
  );
}
