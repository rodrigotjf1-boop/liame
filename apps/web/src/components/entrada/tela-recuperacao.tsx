'use client';

import type { AccountRecoveryReason, MyAccountRecoveryResponse } from '@liame/contracts';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { type FormEvent, useEffect, useId, useRef, useState } from 'react';
import { cnpjTxt } from '@/components/pessoas/parceiros';
import { ConfirmaNaLinha } from '@/components/ui/confirma-na-linha';
import { Icone } from '@/components/ui/icone';
import { api, chamar, type Problema } from '@/lib/api';
import { disparar } from '@/lib/disparar';
import { voltaSegura } from '@/lib/entrada';
import { pedirRecuperacao } from './enviar-documento';
import { useCena, useLia } from './lia';
import { Aviso, AvisoProblema, BotaoEnviar } from './pecas';
import { emAndamento, etapas, MOTIVOS, porQueNaoPode, problemaDoDocumento } from './recuperacao-textos';

// A recuperação da conta do Dono na entrada (P34 aprovado; A7, W8, parte 5; D-A7-62, D-A7-64): depois da senha, sem o
// celular e sem os códigos, o Dono pede com o documento com foto; depois, acompanha o andamento aqui (a conferência da
// DMS, a espera de 7 dias e o app novo) e pode cancelar. Entrar com o app ou com um código derruba o pedido sozinho.

type Estado = { tipo: 'carregando' } | { tipo: 'pronto'; dados: MyAccountRecoveryResponse; email: string };

export function TelaRecuperacao() {
  const router = useRouter();
  const volta = voltaSegura(useSearchParams().get('volta'));
  const lia = useLia();
  useCena('A DMS confere quem você é antes de trocar o app.');
  const ids = useId();
  const titulo = useRef<HTMLHeadingElement>(null);
  const campoMotivo = useRef<HTMLSelectElement>(null);
  const campoDocumento = useRef<HTMLInputElement>(null);

  const [estado, setEstado] = useState<Estado>({ tipo: 'carregando' });
  const [pedindo, setPedindo] = useState(false);
  const [motivo, setMotivo] = useState<AccountRecoveryReason | ''>('');
  const [documento, setDocumento] = useState<File | null>(null);
  const [erros, setErros] = useState<{ motivo?: string; documento?: string }>({});
  const [problema, setProblema] = useState<Problema | null>(null);
  const [enviando, setEnviando] = useState(false);
  const [cancelando, setCancelando] = useState(false);
  const [ocupado, setOcupado] = useState(false);
  const [resultado, setResultado] = useState<string | null>(null);

  // Só fica aqui quem entrou com a senha; sem sessão, volta para a entrada.
  useEffect(() => {
    let viva = true;
    disparar(
      Promise.all([chamar(() => api.GET('/v1/me')), chamar(() => api.GET('/v1/me/account-recovery'))]).then(([me, r]) => {
        if (!viva) return;
        if (!me.ok || !r.ok) return router.replace(`/entrar?volta=${encodeURIComponent(volta)}`);
        setEstado({ tipo: 'pronto', dados: r.data, email: me.data.user.email });
      }),
    );
    return () => {
      viva = false;
    };
  }, [router, volta]);

  function mostrar(dados: MyAccountRecoveryResponse, aviso: string) {
    setEstado((e) => (e.tipo === 'pronto' ? { ...e, dados } : e));
    setPedindo(false);
    setResultado(aviso);
    setTimeout(() => titulo.current?.focus(), 0);
  }

  async function enviar(e: FormEvent) {
    e.preventDefault();
    setProblema(null);
    const novos = { motivo: motivo ? undefined : 'Escolha o que aconteceu.', documento: problemaDoDocumento(documento) ?? undefined };
    setErros(novos);
    if (novos.motivo) return campoMotivo.current?.focus();
    if (novos.documento || !documento || !motivo) return campoDocumento.current?.focus();
    setEnviando(true);
    lia.reagir('think');
    const r = await pedirRecuperacao(motivo, documento);
    setEnviando(false);
    if (!r.ok) {
      setProblema(r.problema);
      lia.reagir('empathetic', 2800);
      return;
    }
    lia.reagir('happy', 1500);
    mostrar(r.data, 'Pedido enviado. Mandamos o protocolo para o seu e-mail.');
  }

  async function cancelar(id: string) {
    setOcupado(true);
    const r = await chamar(() => api.DELETE('/v1/me/account-recovery/{id}', { params: { path: { id } } }));
    setOcupado(false);
    setCancelando(false);
    if (!r.ok) return setProblema(r.problema);
    mostrar(r.data, 'Pedido cancelado. O app de antes continua valendo.');
  }

  if (estado.tipo === 'carregando') return <p className="rotulo-marca" aria-busy="true">Conferindo a sua sessão…</p>;
  const { dados, email } = estado;
  const r = dados.recovery;
  const voltar = `/segundo-fator?volta=${encodeURIComponent(volta)}`;

  // O andamento: o pedido que anda, ou o último que terminou (com "Fazer outro pedido" quando dá).
  if (r && !pedindo) {
    const anda = emAndamento(r);
    return (
      <section className="tela" aria-labelledby="t-rec">
        <div className="tela-cab">
          <h1 id="t-rec" ref={titulo} tabIndex={-1}>
            A recuperação da sua conta
          </h1>
          <p>
            Protocolo <span className="num">{r.protocol}</span> · {r.companies.map((c) => c.name).join(', ')} · {email}
          </p>
        </div>
        {resultado && <Aviso tipo="ok" titulo={resultado} />}
        <AvisoProblema problema={problema} />
        <ol className="rec-andamento" aria-label="Andamento do pedido">
          {etapas(r).map((e) => (
            <li key={e.titulo} data-st={e.situacao}>
              <span className="marca" aria-hidden="true">
                {e.situacao === 'feito' ? <Icone nome="check" pequeno /> : e.situacao === 'parado' ? '!' : ''}
              </span>
              <div className="txt">
                <b>
                  {e.titulo}
                  <span className="sr-only">{{ feito: ' (feito)', agora: ' (agora)', parado: ' (parado)', depois: ' (depois)' }[e.situacao]}</span>
                </b>
                <span>{e.texto}</span>
              </div>
            </li>
          ))}
        </ol>
        {anda && (
          <>
            <Aviso tipo="info" titulo="Achou o celular ou os códigos?">
              Entre normalmente: o pedido cai sozinho.{' '}
              <Link className="link-bt" href={voltar}>
                Digitar o código do app
              </Link>
            </Aviso>
            <div className="rec-acoes">
              {cancelando ? (
                <ConfirmaNaLinha
                  texto="Cancelar o pedido? O app de antes continua valendo."
                  rotulo="Cancelar o pedido"
                  rotuloOcupado="Cancelando…"
                  voltar="Manter"
                  ocupado={ocupado}
                  aoConfirmar={() => disparar(cancelar(r.id))}
                  aoCancelar={() => setCancelando(false)}
                />
              ) : (
                <button className="btn btn--perigo" type="button" onClick={() => setCancelando(true)}>
                  Cancelar o pedido
                </button>
              )}
            </div>
          </>
        )}
        {r.status === 'aplicado' && (
          <div className="rec-acoes">
            <Link className="btn btn--primary" href={`/segundo-fator/ativar?volta=${encodeURIComponent(volta)}`}>
              Cadastrar o app novo
            </Link>
          </div>
        )}
        {!anda && r.status !== 'aplicado' && dados.cannot_request === null && (
          <div className="rec-acoes">
            <button
              className="btn"
              type="button"
              onClick={() => {
                setPedindo(true);
                setResultado(null);
                setProblema(null);
              }}
            >
              Fazer outro pedido
            </button>
          </div>
        )}
        <p className="rec-nota">Avisamos cada passo no seu e-mail, {email}. O andamento também aparece aqui sempre que você entrar com a senha.</p>
      </section>
    );
  }

  const naoPode = porQueNaoPode(dados.cannot_request, dados.support.email);
  if (naoPode) {
    return (
      <section className="tela" aria-labelledby="t-rec">
        <div className="tela-cab">
          <h1 id="t-rec">{naoPode.titulo}</h1>
          <p>{naoPode.texto}</p>
        </div>
        <p className="alternativa">
          <Link className="link-bt" href={voltar}>
            Voltar
          </Link>
        </p>
      </section>
    );
  }

  // O pedido.
  return (
    <section className="tela" aria-labelledby="t-rec">
      <div className="tela-cab">
        <h1 id="t-rec" ref={titulo} tabIndex={-1}>
          Pedir a recuperação da conta
        </h1>
        <p>
          Você entrou com a senha de <b>{email}</b>. A DMS confere que é você antes de trocar o app.
        </p>
      </div>
      <AvisoProblema problema={problema} />
      <ul className="rec-empresas" aria-label="As suas empresas">
        {dados.owner_of.map((c) => (
          <li className="rec-empresa" key={`${c.name}-${c.cnpj ?? ''}`}>
            <b>{c.name}</b>
            <small>{c.cnpj ? <>CNPJ <span className="num">{cnpjTxt(c.cnpj)}</span> · você é o dono</> : 'Sem CNPJ cadastrado · você é o dono'}</small>
          </li>
        ))}
      </ul>
      <form className="form" onSubmit={(e) => disparar(enviar(e))} noValidate>
        <div className="campo">
          <label htmlFor={`${ids}-motivo`}>O que aconteceu</label>
          <select
            ref={campoMotivo}
            className="input"
            id={`${ids}-motivo`}
            value={motivo}
            onChange={(e) => setMotivo(e.target.value as AccountRecoveryReason | '')}
            aria-invalid={erros.motivo ? true : undefined}
            aria-describedby={erros.motivo ? `${ids}-motivo-erro` : undefined}
          >
            <option value="">Escolha</option>
            {MOTIVOS.map((m) => (
              <option key={m.valor} value={m.valor}>
                {m.rotulo}
              </option>
            ))}
          </select>
          {erros.motivo && (
            <span className="campo-erro" id={`${ids}-motivo-erro`}>
              {erros.motivo}
            </span>
          )}
        </div>
        <div className="campo">
          <label htmlFor={`${ids}-doc`}>O seu documento com foto</label>
          <input
            ref={campoDocumento}
            className="input input-arquivo"
            id={`${ids}-doc`}
            type="file"
            accept="image/jpeg,image/png,application/pdf"
            onChange={(e) => setDocumento(e.target.files?.[0] ?? null)}
            aria-invalid={erros.documento ? true : undefined}
            aria-describedby={`${ids}-doc-dica${erros.documento ? ` ${ids}-doc-erro` : ''}`}
          />
          <span className="campo-dica" id={`${ids}-doc-dica`}>
            RG ou CNH, frente e verso. JPG, PNG ou PDF, até 10 MB. O nome tem de ser o do quadro de sócios na Receita.
          </span>
          {erros.documento && (
            <span className="campo-erro" id={`${ids}-doc-erro`}>
              {erros.documento}
            </span>
          )}
        </div>
        <div className="rec-depois">
          <h2>O que acontece depois</h2>
          <ol>
            <li>A DMS confere o documento e o seu nome no quadro de sócios, e marca uma videochamada curta pelo seu e-mail, em até 2 dias úteis.</li>
            <li>Depois, 7 dias de espera, com aviso ao seu e-mail e aos Administradores das suas empresas. Se você entrar com o app ou com um código nesse tempo, o pedido cai sozinho.</li>
            <li>No fim, o app antigo deixa de valer, todas as sessões fecham, e você cadastra o app novo e gera códigos novos ao entrar.</li>
          </ol>
          <p className="campo-dica">
            O documento fica guardado à parte e é apagado 30 dias depois da decisão. Mande só por aqui: a DMS nunca pede documento por e-mail, por WhatsApp ou pela LIA.
          </p>
        </div>
        <BotaoEnviar enviando={enviando}>Enviar o pedido</BotaoEnviar>
      </form>
      <p className="alternativa">
        {r ? (
          <button className="link-bt" type="button" onClick={() => setPedindo(false)}>
            Voltar ao andamento
          </button>
        ) : (
          <Link className="link-bt" href={voltar}>
            Voltar
          </Link>
        )}
      </p>
    </section>
  );
}
