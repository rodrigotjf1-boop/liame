'use client';

import Link from 'next/link';
import { type FormEvent, type InputHTMLAttributes, useRef, useState } from 'react';
import { api, chamar, type Problema } from '@/lib/api';
import { disparar } from '@/lib/disparar';
import { useTermos } from '@/lib/entrada';
import { useCena, useLia } from './lia';
import { Aviso, AvisoProblema, BotaoEnviar, CampoSenha, SENHA_MIN } from './pecas';

// Criar conta: a conta é da empresa; o dono convida quem cuida do marketing depois (ADR-017).
// A resposta é a mesma exista ou não o e-mail (não revela contas); a confirmação chega por e-mail.

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
type Campo = 'nome' | 'email' | 'senha' | 'empresa' | 'cnpj';
const CAMPO_DA_API: Record<string, Campo> = { name: 'nome', email: 'email', password: 'senha', 'company.name': 'empresa', 'company.cnpj': 'cnpj' };

export function TelaCriarConta() {
  const lia = useLia();
  const { termos, problema: problemaTermos, recarregar } = useTermos();
  const [valores, setValores] = useState({ nome: '', email: '', senha: '', empresa: '', cnpj: '' });
  const [mostrar, setMostrar] = useState(false);
  const [erros, setErros] = useState<Partial<Record<Campo, string>>>({});
  const [problema, setProblema] = useState<Problema | null>(null);
  const [enviando, setEnviando] = useState(false);
  const [enviadoPara, setEnviadoPara] = useState<string | null>(null);
  const form = useRef<HTMLFormElement>(null);
  useCena(
    enviadoPara ? 'Confira seu e-mail: o link de confirmação está chegando.' : 'Que bom ter você aqui! Eu sou a LIA, do atendimento. Vou cuidar do seu marketing com a equipe.',
    enviadoPara ? 'happy' : 'wave',
  );

  function mudar(campo: Campo, valor: string) {
    setValores((v) => ({ ...v, [campo]: valor }));
    if (campo !== 'senha') lia.reagir('listen');
  }

  function mostrarErros(novos: Partial<Record<Campo, string>>) {
    setErros(novos);
    lia.reagir('empathetic', 2800);
    const primeiro = (['nome', 'email', 'senha', 'empresa', 'cnpj'] as const).find((c) => novos[c]);
    if (primeiro) form.current?.querySelector<HTMLInputElement>(`#cc-${primeiro}`)?.focus();
  }

  async function criar(e: FormEvent) {
    e.preventDefault();
    setProblema(null);
    const email = valores.email.trim().toLowerCase();
    const cnpj = valores.cnpj.replace(/\D/g, '');
    const novos: Partial<Record<Campo, string>> = {};
    if (!valores.nome.trim()) novos.nome = 'Digite o seu nome.';
    if (!EMAIL.test(email)) novos.email = 'Digite um e-mail válido, como nome@empresa.com.br.';
    if (valores.senha.length < SENHA_MIN) novos.senha = `Use pelo menos ${SENHA_MIN} caracteres (uma frase serve).`;
    if (!valores.empresa.trim()) novos.empresa = 'Digite o nome da empresa, como aparece para os clientes.';
    if (cnpj && cnpj.length !== 14) novos.cnpj = 'O CNPJ tem 14 dígitos. Se preferir, deixe em branco.';
    if (Object.keys(novos).length) return mostrarErros(novos);
    if (!termos) return;
    setErros({});
    setEnviando(true);
    lia.reagir('think');
    const r = await chamar(() =>
      api.POST('/v1/auth/signup', {
        body: {
          name: valores.nome.trim(),
          email,
          password: valores.senha,
          company: { name: valores.empresa.trim(), ...(cnpj ? { cnpj } : {}) },
          terms_version: termos.version,
        },
      }),
    );
    setEnviando(false);
    if (!r.ok) {
      const porCampo: Partial<Record<Campo, string>> = {};
      for (const x of r.problema.errors ?? []) {
        const campo = CAMPO_DA_API[x.path];
        if (campo) porCampo[campo] = x.message;
      }
      if (Object.keys(porCampo).length) return mostrarErros(porCampo);
      if (r.problema.code === 'termos-desatualizados') recarregar();
      lia.reagir('empathetic', 2800);
      return setProblema(r.problema);
    }
    setEnviadoPara(email);
  }

  if (enviadoPara) {
    return (
      <section className="tela" aria-labelledby="t-enviado">
        <div className="tela-cab">
          <h1 id="t-enviado">Confira seu e-mail</h1>
          <p>
            Enviamos um link de confirmação para <b>{enviadoPara}</b>. Ele vale 24 horas.
          </p>
        </div>
        <Aviso tipo="info" titulo="Não chegou?" icone="mail">
          Confira o spam e as promoções. Se tentar entrar antes de confirmar, mandamos o link de novo.
        </Aviso>
        <Link className="btn" href="/entrar">
          Ir para a entrada
        </Link>
      </section>
    );
  }

  const campoTexto = (campo: Campo, rotulo: string, props: InputHTMLAttributes<HTMLInputElement>) => (
    <div className="campo">
      <label htmlFor={`cc-${campo}`}>{rotulo}</label>
      <input
        className="input"
        id={`cc-${campo}`}
        value={valores[campo]}
        onChange={(e) => mudar(campo, e.target.value)}
        aria-invalid={erros[campo] ? true : undefined}
        aria-describedby={erros[campo] ? `cc-${campo}-erro` : undefined}
        {...props}
      />
      {erros[campo] && (
        <span className="campo-erro" id={`cc-${campo}-erro`}>
          {erros[campo]}
        </span>
      )}
    </div>
  );

  return (
    <section className="tela" aria-labelledby="t-criar">
      <div className="tela-cab">
        <h1 id="t-criar">Criar conta</h1>
        <p>A conta é da sua empresa. Depois, você convida quem cuida do marketing com você.</p>
      </div>
      <AvisoProblema problema={problema ?? problemaTermos} />
      <form className="form" ref={form} onSubmit={(e) => disparar(criar(e))} noValidate>
        {campoTexto('nome', 'Seu nome', { autoComplete: 'name', required: true })}
        {campoTexto('email', 'E-mail', { type: 'email', autoComplete: 'username', inputMode: 'email', required: true })}
        <CampoSenha
          id="cc-senha"
          rotulo="Senha"
          nova
          valor={valores.senha}
          aoMudar={(v) => mudar('senha', v)}
          aoFocar={() => lia.reagir('shy')}
          mostrar={mostrar}
          aoMostrar={() => setMostrar((m) => !m)}
          erro={erros.senha}
        />
        {campoTexto('empresa', 'Nome da empresa', { autoComplete: 'organization', required: true })}
        <div className="campo">
          <label htmlFor="cc-cnpj">
            CNPJ <span className="campo-dica">(opcional)</span>
          </label>
          <input
            className="input"
            id="cc-cnpj"
            inputMode="numeric"
            autoComplete="off"
            placeholder="00.000.000/0000-00"
            value={valores.cnpj}
            onChange={(e) => mudar('cnpj', e.target.value)}
            aria-invalid={erros.cnpj ? true : undefined}
            aria-describedby={erros.cnpj ? 'cc-cnpj-erro' : undefined}
          />
          {erros.cnpj && (
            <span className="campo-erro" id="cc-cnpj-erro">
              {erros.cnpj}
            </span>
          )}
        </div>
        {termos && (
          <p className="campo-dica">
            Ao criar a conta, você concorda com os{' '}
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
        <BotaoEnviar enviando={enviando || !termos}>Criar conta</BotaoEnviar>
      </form>
      <p className="alternativa">
        Já tem conta? <Link href="/entrar">Entrar</Link>
      </p>
    </section>
  );
}
