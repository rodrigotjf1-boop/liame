'use client';

import { useRouter } from 'next/navigation';
import { type FormEvent, type RefObject, useEffect, useId, useRef, useState } from 'react';
import { useAvisar } from '@/components/ui/avisos';
import { Icone } from '@/components/ui/icone';
import { useDialogo } from '@/components/ui/use-dialogo';
import { api, chamar, mensagemDe, novaChave } from '@/lib/api';
import { disparar } from '@/lib/disparar';
import { useSessao } from '@/lib/sessao';

// "Abrir a conta da agência" em Sua conta (A7, W6, parte 6; D-A7-45 e D-A7-79): quem já tem login abre a agência e
// passa a trocar entre a empresa e a agência no seletor do alto do menu. Aparece só com os parceiros ligados na empresa
// ativa (a função `parceiros`, lida pelo `enabled` de Pessoas e acessos) e para quem ainda não é dona de uma agência.

export function CartaoAgencia({ reserva }: { reserva: RefObject<HTMLElement | null> }) {
  const { me, pode } = useSessao();
  const [ligada, setLigada] = useState(false);
  const [abrindo, setAbrindo] = useState(false);
  const jaTem = me.organizations.some((o) => o.role === 'agencia_dona');

  useEffect(() => {
    if (jaTem || !pode('pessoas.ver')) return;
    let vivo = true;
    disparar(
      (async () => {
        const r = await chamar(() => api.GET('/v1/partners'));
        if (vivo && r.ok) setLigada(r.data.enabled);
      })(),
    );
    return () => {
      vivo = false;
    };
  }, [jaTem, pode]);

  if (jaTem || !ligada) return null;
  return (
    <article className="card seg-largo anima" style={{ ['--i' as string]: 6 }} aria-labelledby="t-agencia">
      <div className="card-cab">
        <div>
          <h2 id="t-agencia">Agência ou consultor com time</h2>
          <p className="card-sub">Para quem também cuida de outras empresas, com um time.</p>
        </div>
      </div>
      <p className="seg-txt">
        Abra a conta da agência para pedir acesso aos clientes pelo e-mail do dono de cada empresa e convidar o seu time. O seu login
        continua o mesmo: você troca entre a empresa e a agência no seletor do alto do menu. A conta da agência não tem marca nem assinatura.
      </p>
      <div className="seg-acoes">
        <button className="btn" type="button" aria-haspopup="dialog" onClick={() => setAbrindo(true)}>
          Abrir a conta da agência
        </button>
      </div>
      {abrindo && <DialogoAbrir reserva={reserva} aoFechar={() => setAbrindo(false)} />}
    </article>
  );
}

function DialogoAbrir({ reserva, aoFechar }: { reserva: RefObject<HTMLElement | null>; aoFechar: () => void }) {
  const ids = useId();
  const campoNome = useRef<HTMLInputElement>(null);
  const { ref, fechar, devolverFoco } = useDialogo({ focoInicial: campoNome, reserva });
  const { trocarEmpresa } = useSessao();
  const avisar = useAvisar();
  const router = useRouter();
  const chave = useRef(novaChave());
  const [nome, setNome] = useState('');
  const [cnpj, setCnpj] = useState('');
  const [erroNome, setErroNome] = useState('');
  const [erroCnpj, setErroCnpj] = useState('');
  const [erroGeral, setErroGeral] = useState('');
  const [enviando, setEnviando] = useState(false);

  async function abrir(e: FormEvent) {
    e.preventDefault();
    setErroNome('');
    setErroCnpj('');
    setErroGeral('');
    const digitos = cnpj.replace(/\D/g, '');
    if (!nome.trim()) {
      setErroNome('Digite o nome da agência.');
      return campoNome.current?.focus();
    }
    if (digitos && digitos.length !== 14) {
      setErroCnpj('O CNPJ tem 14 dígitos. Se preferir, deixe em branco.');
      return;
    }
    setEnviando(true);
    const r = await chamar(() =>
      api.POST('/v1/agencies', { headers: { 'Idempotency-Key': chave.current }, body: { name: nome.trim(), ...(digitos ? { cnpj: digitos } : {}) } }),
    );
    if (!r.ok) {
      setEnviando(false);
      chave.current = novaChave();
      return setErroGeral(mensagemDe(r.problema));
    }
    // A agência nova já é a organização ativa da sessão: a troca só relê o "quem sou" com ela.
    const problema = r.data.active_organization_id ? await trocarEmpresa(r.data.active_organization_id) : null;
    setEnviando(false);
    if (problema) return setErroGeral(mensagemDe(problema));
    avisar(`A conta da agência ${nome.trim()} está aberta. Agora você está nela.`);
    fechar();
    router.push('/');
  }

  return (
    <dialog
      ref={ref}
      className="dialogo"
      aria-labelledby={`${ids}-t`}
      onClose={() => {
        aoFechar();
        devolverFoco();
      }}
    >
      <form className="dialogo-form" onSubmit={(e) => disparar(abrir(e))} noValidate>
        <div className="dialogo-cab">
          <h2 id={`${ids}-t`}>Abrir a conta da agência</h2>
          <button className="btn btn--ghost btn--icon" type="button" onClick={fechar} aria-label="Fechar" disabled={enviando}>
            <Icone nome="x" />
          </button>
        </div>
        <div className="dialogo-corpo">
          {erroGeral && (
            <p className="dialogo-erro" role="alert">
              <Icone nome="alert" pequeno />
              <span>{erroGeral}</span>
            </p>
          )}
          <div className="campo">
            <label htmlFor={`${ids}-nome`}>Nome da agência</label>
            <input
              ref={campoNome}
              className="input"
              id={`${ids}-nome`}
              autoComplete="organization"
              value={nome}
              onChange={(e) => setNome(e.target.value)}
              aria-invalid={erroNome ? true : undefined}
              aria-describedby={erroNome ? `${ids}-nome-erro` : undefined}
            />
            {erroNome && (
              <p className="campo-erro" id={`${ids}-nome-erro`}>
                {erroNome}
              </p>
            )}
          </div>
          <div className="campo">
            <label htmlFor={`${ids}-cnpj`}>
              CNPJ <span className="campo-dica">(opcional)</span>
            </label>
            <input
              className="input"
              id={`${ids}-cnpj`}
              inputMode="numeric"
              autoComplete="off"
              placeholder="00.000.000/0000-00"
              value={cnpj}
              onChange={(e) => setCnpj(e.target.value)}
              aria-invalid={erroCnpj ? true : undefined}
              aria-describedby={erroCnpj ? `${ids}-cnpj-erro` : undefined}
            />
            {erroCnpj && (
              <p className="campo-erro" id={`${ids}-cnpj-erro`}>
                {erroCnpj}
              </p>
            )}
          </div>
          <p className="dialogo-nota">
            <Icone nome="info" pequeno />
            <span>Você fica com o papel "Dona da agência". O dono de cada empresa decide se a agência entra e até onde o time vai.</span>
          </p>
        </div>
        <div className="dialogo-acoes">
          <button className="btn" type="button" onClick={fechar} disabled={enviando}>
            Cancelar
          </button>
          <button className="btn btn--primary" type="submit" disabled={enviando} aria-busy={enviando}>
            {enviando ? 'Abrindo…' : 'Abrir a conta da agência'}
          </button>
        </div>
      </form>
    </dialog>
  );
}
