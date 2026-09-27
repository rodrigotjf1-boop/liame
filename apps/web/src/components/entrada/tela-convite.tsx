'use client';

import type { InvitationPreviewResponse, MeResponse } from '@liame/contracts';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { type FormEvent, useEffect, useState } from 'react';
import { api, chamar, type Problema } from '@/lib/api';
import { disparar } from '@/lib/disparar';
import { destinoDepoisDeEntrar, useTermos } from '@/lib/entrada';
import { iniciais } from '@/lib/formato';
import { EXIGEM_APP, NIVEIS } from '@/lib/niveis';
import { useCena, useLia } from './lia';
import { Aviso, AvisoProblema, BotaoEnviar, CampoSenha, SENHA_MIN } from './pecas';

// Aceite de convite (ADR-017): quem não tem conta cria o login pelo próprio link (o link prova o e-mail);
// quem já tem entra e aceita. O convite só vale para o e-mail convidado.

type Estado =
  | { tipo: 'carregando' }
  | { tipo: 'vencido' }
  | { tipo: 'ok'; convite: InvitationPreviewResponse; me: MeResponse | null };

export function TelaConvite() {
  const router = useRouter();
  const token = useSearchParams().get('token') ?? '';
  const lia = useLia();
  const { termos, problema: problemaTermos, recarregar } = useTermos();
  const [estado, setEstado] = useState<Estado>({ tipo: 'carregando' });
  const [nome, setNome] = useState('');
  const [senha, setSenha] = useState('');
  const [mostrar, setMostrar] = useState(false);
  const [problema, setProblema] = useState<Problema | null>(null);
  const [erroNome, setErroNome] = useState('');
  const [erroSenha, setErroSenha] = useState('');
  const [enviando, setEnviando] = useState(false);

  const convite = estado.tipo === 'ok' ? estado.convite : null;
  useCena(
    estado.tipo === 'vencido'
      ? 'Esse convite não vale mais. Peça um novo a quem convidou você.'
      : convite
        ? `Oi! ${convite.invited_by_name} chamou você para cuidar da ${convite.organization_name} com a gente.`
        : 'Oi! Deixa eu ver o seu convite…',
    estado.tipo === 'vencido' ? 'empathetic' : 'wave',
  );

  useEffect(() => {
    let viva = true;
    if (token.length < 20) {
      setEstado({ tipo: 'vencido' });
      return;
    }
    disparar(
      Promise.all([chamar(() => api.POST('/v1/invitations/preview', { body: { token } })), chamar(() => api.GET('/v1/me'))]).then(([p, m]) => {
        if (!viva) return;
        if (!p.ok) return setEstado({ tipo: 'vencido' });
        setEstado({ tipo: 'ok', convite: p.data, me: m.ok ? m.data : null });
      }),
    );
    return () => {
      viva = false;
    };
  }, [token]);

  async function criarLogin(e: FormEvent) {
    e.preventDefault();
    setProblema(null);
    setErroNome('');
    setErroSenha('');
    if (!nome.trim()) return setErroNome('Digite o seu nome, como você quer aparecer para a empresa.');
    if (senha.length < SENHA_MIN) return setErroSenha(`Use pelo menos ${SENHA_MIN} caracteres (uma frase serve).`);
    if (!termos) return;
    setEnviando(true);
    lia.reagir('think');
    const r = await chamar(() =>
      api.POST('/v1/invitations/signup', { body: { token, name: nome.trim(), password: senha, terms_version: termos.version } }),
    );
    setEnviando(false);
    if (!r.ok) {
      lia.reagir('empathetic', 2800);
      const doCampo = r.problema.errors?.find((x) => x.path === 'password');
      if (doCampo) return setErroSenha(doCampo.message);
      if (r.problema.code === 'termos-desatualizados') recarregar();
      return setProblema(r.problema);
    }
    lia.reagir('celebrate', 2600);
    router.replace(destinoDepoisDeEntrar(r.data, '/'));
  }

  async function aceitar() {
    setProblema(null);
    setEnviando(true);
    lia.reagir('think');
    const r = await chamar(() => api.POST('/v1/invitations/accept', { body: { token } }));
    setEnviando(false);
    if (!r.ok) {
      lia.reagir('empathetic', 2800);
      return setProblema(r.problema);
    }
    lia.reagir('celebrate', 2600);
    router.replace(destinoDepoisDeEntrar(r.data, '/'));
  }

  async function sair() {
    await chamar(() => api.POST('/v1/auth/logout'));
    setEstado((e) => (e.tipo === 'ok' ? { ...e, me: null } : e));
  }

  if (estado.tipo === 'carregando') return <p className="rotulo-marca" aria-busy="true">Abrindo o convite…</p>;
  if (estado.tipo === 'vencido') {
    return (
      <section className="tela" aria-labelledby="t-convite">
        <div className="tela-cab">
          <h1 id="t-convite">Este convite não vale mais</h1>
          <p>O link venceu (vale 7 dias), foi cancelado ou já foi usado. Peça um convite novo a quem convidou você.</p>
        </div>
        <Link className="btn" href="/entrar">
          Ir para a entrada
        </Link>
      </section>
    );
  }

  const { convite: c, me } = estado;
  const logadoComOEmail = me?.user.email === c.email;
  const volta = `/convite?token=${encodeURIComponent(token)}`;
  return (
    <section className="tela" aria-labelledby="t-convite">
      <div className="tela-cab">
        <h1 id="t-convite">Você recebeu um convite da {c.organization_name}</h1>
      </div>
      <div className="convite-card">
        <span className="convite-av" aria-hidden="true">
          {iniciais(c.organization_name)}
        </span>
        <div>
          <p>
            <b>{c.invited_by_name}</b> convidou <b>{c.email}</b> para cuidar da conta da <b>{c.organization_name}</b> no Liame.
          </p>
          <span className={`nivel-chip nivel-chip--${NIVEIS[c.role].chip}`}>{NIVEIS[c.role].nome}</span>
        </div>
      </div>
      <p className="campo-dica">{NIVEIS[c.role].desc}</p>
      <AvisoProblema problema={problema ?? problemaTermos} />

      {!c.account_exists && (
        <form className="form" onSubmit={(e) => disparar(criarLogin(e))} noValidate>
          <div className="campo">
            <label htmlFor="cv-nome">Seu nome</label>
            <input
              className="input"
              id="cv-nome"
              autoComplete="name"
              required
              value={nome}
              onChange={(e) => {
                setNome(e.target.value);
                lia.reagir('listen');
              }}
              aria-invalid={erroNome ? true : undefined}
              aria-describedby={erroNome ? 'cv-nome-erro' : undefined}
            />
            {erroNome && (
              <span className="campo-erro" id="cv-nome-erro">
                {erroNome}
              </span>
            )}
          </div>
          <div className="campo">
            <label htmlFor="cv-email">E-mail</label>
            <input className="input" id="cv-email" type="email" autoComplete="username" value={c.email} readOnly aria-describedby="cv-email-d" />
            <span className="campo-dica" id="cv-email-d">
              O convite só vale para este e-mail.
            </span>
          </div>
          <CampoSenha
            id="cv-senha"
            rotulo="Crie uma senha"
            nova
            valor={senha}
            aoMudar={setSenha}
            aoFocar={() => lia.reagir('shy')}
            mostrar={mostrar}
            aoMostrar={() => setMostrar((m) => !m)}
            erro={erroSenha || undefined}
          />
          {termos && (
            <p className="campo-dica">
              Ao criar o login, você concorda com os{' '}
              <a href={termos.terms_url} target="_blank" rel="noopener noreferrer">
                Termos de Uso
              </a>{' '}
              e a{' '}
              <a href={termos.privacy_url} target="_blank" rel="noopener noreferrer">
                Política de Privacidade
              </a>
              .
            </p>
          )}
          <BotaoEnviar enviando={enviando || !termos}>Criar login e entrar</BotaoEnviar>
          {EXIGEM_APP.has(c.role) && (
            <p className="campo-dica">Em seguida, você ativa o app autenticador (obrigatório para {NIVEIS[c.role].nome}).</p>
          )}
        </form>
      )}

      {c.account_exists && !me && (
        <div className="form">
          <Aviso tipo="info" titulo="Você já tem conta no Liame" icone="users">
            Entre com ela para aceitar. A {c.organization_name} aparece junto das outras empresas, no seletor do alto do menu.
          </Aviso>
          <Link className="btn btn--primary btn--largo" href={`/entrar?volta=${encodeURIComponent(volta)}`}>
            Entrar para aceitar o convite
          </Link>
        </div>
      )}

      {c.account_exists && me && logadoComOEmail && (
        <div className="form">
          <p className="campo-dica">
            Você está como <b>{me.user.email}</b>.
          </p>
          <button className="btn btn--primary btn--largo" type="button" disabled={enviando} aria-busy={enviando} onClick={() => disparar(aceitar())}>
            Aceitar convite
          </button>
        </div>
      )}

      {c.account_exists && me && !logadoComOEmail && (
        <div className="form">
          <Aviso tipo="info" titulo="Convite para outro e-mail">
            Você está como {me.user.email}, mas o convite é para {c.email}. Saia e entre com a conta certa.
          </Aviso>
          <button className="btn btn--largo" type="button" onClick={() => disparar(sair())}>
            Sair e entrar com {c.email}
          </button>
        </div>
      )}
    </section>
  );
}
