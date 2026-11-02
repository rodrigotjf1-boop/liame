'use client';

import type { AgencyBrandResponse, AgencyReportMode } from '@liame/contracts';
import { type FormEvent, useCallback, useEffect, useId, useRef, useState } from 'react';
import { useAvisar } from '@/components/ui/avisos';
import { Estado } from '@/components/ui/estado';
import { Icone } from '@/components/ui/icone';
import { api, chamar, mensagemDe, type Problema } from '@/lib/api';
import { disparar } from '@/lib/disparar';
import { useSessao } from '@/lib/sessao';
import { enviarLogo } from './enviar-logo';
import { avisoDeSalvo, emailValido, iniciaisDaAgencia, mudancasDaMarca, problemaDoArquivo, situacaoDaResposta } from './marca-textos';

// A marca da agência (P29 aprovado; A7, W7, parte 5a; D-A7-69): o nome e o logo que os clientes veem no relatório do mês
// e no e-mail dele, o e-mail de resposta (que só vale depois do link de confirmação) e como o relatório sai. O logo
// escolhido só sobe ao salvar, junto com o resto. Quem cuida dos clientes (a dona e o administrador) muda.

type Estado = { tipo: 'carregando' } | { tipo: 'ok'; marca: AgencyBrandResponse } | { tipo: 'erro'; problema: Problema };
type Logo = { tipo: 'como-esta' } | { tipo: 'novo'; arquivo: File; previa: string } | { tipo: 'tirar' };

export function MarcaTela() {
  const { pode } = useSessao();
  const avisar = useAvisar();
  const ids = useId();
  const [estado, setEstado] = useState<Estado>({ tipo: 'carregando' });
  const [nome, setNome] = useState('');
  const [resposta, setResposta] = useState('');
  const [modo, setModo] = useState<AgencyReportMode>('revisar');
  const [logo, setLogo] = useState<Logo>({ tipo: 'como-esta' });
  const [erros, setErros] = useState<{ nome?: string; resposta?: string; arquivo?: string }>({});
  const [salvando, setSalvando] = useState(false);
  const arquivo = useRef<HTMLInputElement>(null);
  const campoNome = useRef<HTMLInputElement>(null);
  const campoResposta = useRef<HTMLInputElement>(null);

  const preencher = useCallback((m: AgencyBrandResponse) => {
    setEstado({ tipo: 'ok', marca: m });
    setNome(m.name);
    setResposta(m.pending_reply_to?.email ?? m.reply_to?.email ?? '');
    setModo(m.report_mode);
    setLogo((l) => {
      if (l.tipo === 'novo') URL.revokeObjectURL(l.previa);
      return { tipo: 'como-esta' };
    });
  }, []);

  const carregar = useCallback(async () => {
    const r = await chamar(() => api.GET('/v1/agency/brand'));
    if (r.ok) preencher(r.data);
    else setEstado({ tipo: 'erro', problema: r.problema });
  }, [preencher]);

  useEffect(() => {
    if (pode('agencia.clientes')) disparar(carregar());
  }, [carregar, pode]);

  if (!pode('agencia.clientes')) {
    return (
      <Estado icone="lock" titulo="Esta tela é de quem cuida dos clientes da agência">
        Quem muda a marca da agência é a dona ou um administrador.
      </Estado>
    );
  }
  if (estado.tipo === 'carregando') {
    return (
      <p className="sr-only" role="status">
        Carregando a marca da agência…
      </p>
    );
  }
  if (estado.tipo === 'erro') {
    return (
      <Estado
        icone="alert"
        perigo
        titulo="Não deu para carregar a marca"
        acao={
          <button className="btn" type="button" onClick={() => disparar(carregar())}>
            <Icone nome="refresh" />
            Tentar de novo
          </button>
        }
      >
        {mensagemDe(estado.problema)}
      </Estado>
    );
  }

  const marca = estado.marca;
  const imagem = logo.tipo === 'novo' ? logo.previa : logo.tipo === 'tirar' ? null : (marca.logo?.url ?? null);
  const temLogo = imagem !== null || (logo.tipo === 'como-esta' && marca.logo !== null);
  const situacoes = situacaoDaResposta(marca);

  function escolher(f: File | undefined) {
    if (!f) return;
    const problema = problemaDoArquivo(f);
    if (problema) {
      setErros((e) => ({ ...e, arquivo: problema }));
      arquivo.current?.focus();
      return;
    }
    setErros((e) => ({ ...e, arquivo: undefined }));
    setLogo((l) => {
      if (l.tipo === 'novo') URL.revokeObjectURL(l.previa);
      return { tipo: 'novo', arquivo: f, previa: URL.createObjectURL(f) };
    });
    avisar('Logo pronto. Salve para valer nos próximos relatórios.');
  }

  async function salvar(ev: FormEvent) {
    ev.preventDefault();
    const novosErros: typeof erros = {};
    if (!nome.trim()) novosErros.nome = 'Dê o nome da agência, como os clientes conhecem.';
    if (resposta.trim() && !emailValido(resposta)) novosErros.resposta = 'Digite um e-mail, como contato@suaagencia.com.br.';
    setErros(novosErros);
    if (novosErros.nome) return campoNome.current?.focus();
    if (novosErros.resposta) return campoResposta.current?.focus();
    const mudancas = mudancasDaMarca(marca, { nome, resposta, modo });
    if (!Object.keys(mudancas).length && logo.tipo === 'como-esta') return avisar('Nada mudou na marca.');
    setSalvando(true);
    if (logo.tipo === 'novo') {
      const r = await enviarLogo(logo.arquivo);
      if (!r.ok) {
        setSalvando(false);
        setErros((e) => ({ ...e, arquivo: mensagemDe(r.problema) }));
        return arquivo.current?.focus();
      }
    } else if (logo.tipo === 'tirar') {
      const r = await chamar(() => api.DELETE('/v1/agency/brand/logo'));
      if (!r.ok) {
        setSalvando(false);
        return avisar(mensagemDe(r.problema), { tipo: 'perigo' });
      }
    }
    if (Object.keys(mudancas).length) {
      const r = await chamar(() => api.PATCH('/v1/agency/brand', { body: mudancas }));
      setSalvando(false);
      if (!r.ok) return avisar(mensagemDe(r.problema), { tipo: 'perigo' });
      preencher(r.data);
      return avisar(avisoDeSalvo(mudancas));
    }
    setSalvando(false);
    avisar(avisoDeSalvo(mudancas));
    disparar(carregar());
  }

  const logoVisual = imagem ? (
    <img className="logo-ag-img" src={imagem} alt={`Logo da ${nome || marca.name}`} />
  ) : (
    <span className="logo-ag logo-ag--vazio" aria-hidden="true">
      {iniciaisDaAgencia(nome || marca.name)}
    </span>
  );

  return (
    <section aria-labelledby="h-marca">
      <div className="view-cab anima" style={{ ['--i' as string]: 0 }}>
        <div>
          <h1 id="h-marca" tabIndex={-1}>
            A marca da agência
          </h1>
          <p>O nome e o logo que os seus clientes veem no relatório do mês e no e-mail dele. O Liame continua aparecendo: "preparado por {nome.trim() || marca.name}, com o Liame".</p>
        </div>
      </div>
      <form className="marca-grid" onSubmit={(ev) => disparar(salvar(ev))} noValidate>
        <article className="card marca-card" aria-labelledby={`${ids}-nl`}>
          <h2 className="card-titulo" id={`${ids}-nl`}>
            Nome e logo
          </h2>
          <div className="campo">
            <label htmlFor={`${ids}-nome`}>Nome da agência</label>
            <input
              ref={campoNome}
              className="input"
              id={`${ids}-nome`}
              value={nome}
              maxLength={60}
              onChange={(e) => setNome(e.target.value)}
              aria-invalid={erros.nome ? true : undefined}
              aria-describedby={erros.nome ? `${ids}-nome-erro` : undefined}
            />
            {erros.nome && (
              <span className="campo-erro" id={`${ids}-nome-erro`}>
                {erros.nome}
              </span>
            )}
          </div>
          <div className="campo">
            <label htmlFor={`${ids}-arquivo`}>Logo</label>
            <div className="logo-linha">
              {logoVisual}
              {temLogo && imagem ? (
                <div className="logo-previas" aria-label="Como o logo aparece">
                  <span className="logo-previa logo-previa--claro">
                    <img className="logo-ag-img" src={imagem} alt="" />
                    No e-mail
                  </span>
                  <span className="logo-previa logo-previa--escuro">
                    <img className="logo-ag-img" src={imagem} alt="" />
                    No tema escuro
                  </span>
                </div>
              ) : (
                <span className="lite-frase">Ainda sem logo: o relatório mostra as iniciais, e o e-mail, só o nome.</span>
              )}
              {temLogo && (
                <button
                  className="btn btn--ghost btn--sm"
                  type="button"
                  onClick={() => {
                    setLogo((l) => {
                      if (l.tipo === 'novo') URL.revokeObjectURL(l.previa);
                      return marca.logo ? { tipo: 'tirar' } : { tipo: 'como-esta' };
                    });
                    avisar('Logo tirado. Salve para valer.');
                    arquivo.current?.focus();
                  }}
                >
                  Tirar o logo
                </button>
              )}
            </div>
            <input
              ref={arquivo}
              className="input input-arquivo"
              id={`${ids}-arquivo`}
              type="file"
              accept="image/png,image/jpeg"
              disabled={!marca.logo_available}
              onChange={(e) => {
                escolher(e.target.files?.[0]);
                e.target.value = '';
              }}
              aria-invalid={erros.arquivo ? true : undefined}
              aria-describedby={`${ids}-arquivo-dica${erros.arquivo ? ` ${ids}-arquivo-erro` : ''}`}
            />
            <span className="campo-dica" id={`${ids}-arquivo-dica`}>
              {marca.logo_available
                ? 'PNG ou JPG, até 1 MB. SVG não: ele pode levar código. O logo aparece até 48 px de altura, sobre fundo branco.'
                : 'O envio de logo não está disponível agora. Tente mais tarde.'}
            </span>
            {erros.arquivo && (
              <span className="campo-erro" id={`${ids}-arquivo-erro`}>
                {erros.arquivo}
              </span>
            )}
          </div>
        </article>
        <article className="card marca-card" aria-labelledby={`${ids}-em`}>
          <h2 className="card-titulo" id={`${ids}-em`}>
            O e-mail do relatório
          </h2>
          <div className="campo">
            <label htmlFor={`${ids}-resp`}>E-mail de resposta</label>
            <input
              ref={campoResposta}
              className="input"
              id={`${ids}-resp`}
              type="email"
              autoComplete="off"
              value={resposta}
              onChange={(e) => setResposta(e.target.value)}
              aria-invalid={erros.resposta ? true : undefined}
              aria-describedby={`${ids}-resp-dica${erros.resposta ? ` ${ids}-resp-erro` : ''}`}
            />
            <span className="campo-dica" id={`${ids}-resp-dica`}>
              Quando o cliente responde ao e-mail do relatório, a resposta vai para cá. Um e-mail novo só vale depois do link de confirmação. Sem
              e-mail, a resposta volta para o Liame.
            </span>
            {erros.resposta && (
              <span className="campo-erro" id={`${ids}-resp-erro`}>
                {erros.resposta}
              </span>
            )}
            {situacoes.map((s) => (
              <span className={`st st--${s.tom} marca-st`} key={s.texto}>
                <span className="dot" aria-hidden="true" />
                {s.texto}
              </span>
            ))}
          </div>
          <fieldset className="campo">
            <legend>Como o relatório do mês sai</legend>
            <div className="opcoes">
              <label className="opcao">
                <input type="radio" name={`${ids}-modo`} value="revisar" checked={modo === 'revisar'} onChange={() => setModo('revisar')} />
                <span className="opcao-txt">
                  <b>Eu reviso e mando (recomendado)</b>
                  <span>
                    O relatório fica pronto no dia 1º e espera você. No dia 3, um lembrete. Até você mandar, o e-mail do próprio Liame do mês também espera,
                    até o dia 3, às 9h.
                  </span>
                </span>
              </label>
              <label className="opcao">
                <input type="radio" name={`${ids}-modo`} value="sozinho" checked={modo === 'sozinho'} onChange={() => setModo('sozinho')} />
                <span className="opcao-txt">
                  <b>Sai sozinho no dia 2, às 9h</b>
                  <span>Sem o seu comentário, para todos que podem receber em cada cliente. Dá para mandar de novo depois, com o comentário.</span>
                </span>
              </label>
            </div>
          </fieldset>
        </article>
        <div className="marca-acoes">
          <button className="btn btn--primary" type="submit" disabled={salvando}>
            {salvando ? 'Salvando…' : 'Salvar a marca'}
          </button>
        </div>
      </form>
    </section>
  );
}
