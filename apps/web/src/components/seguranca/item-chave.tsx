'use client';

import type { Passkey, PasskeysResponse } from '@liame/contracts';
import { type FormEvent, useEffect, useId, useRef, useState } from 'react';
import { ConfirmaNaLinha } from '@/components/ui/confirma-na-linha';
import { Icone } from '@/components/ui/icone';
import { api, chamar, mensagemDe } from '@/lib/api';
import { disparar } from '@/lib/disparar';
import { AVISO_DE_TIRADA, BLOQUEIO_DA_ULTIMA, detalheDaChave, erroDoNome, seloDaCopia, sobreACopia, textoDeTirar } from './chaves-textos';

// Uma chave de acesso na lista de Segurança da conta (A7, W9, parte 9c1; P28; D-A7-58): o nome, se sincroniza, quando foi
// criada e o último uso. Renomear na própria linha; tirar com a confirmação na linha. A última chave sem o app não sai
// (D-A7-57): a linha diz por quê, sem chamar o servidor (que também recusa).

type Props = {
  chave: Passkey;
  agora: Date;
  /** É a única chave da pessoa. */
  ultima: boolean;
  temApp: boolean;
  /** A lista nova (o servidor devolve a lista inteira) e o aviso; `tirada` = a linha some, o foco vai para o título. */
  aoMudar: (dados: PasskeysResponse, aviso: string, tirada: boolean) => void;
  aoErro: (texto: string) => void;
};

type Modo = 'ver' | 'renomear' | 'tirar';

export function ItemChave({ chave, agora, ultima, temApp, aoMudar, aoErro }: Props) {
  const ids = useId();
  const [modo, setModo] = useState<Modo>('ver');
  const [nome, setNome] = useState(chave.name);
  const [erroNome, setErroNome] = useState('');
  const [bloqueada, setBloqueada] = useState(false);
  const [ocupado, setOcupado] = useState(false);
  const campo = useRef<HTMLInputElement>(null);
  const btRenomear = useRef<HTMLButtonElement>(null);
  const btTirar = useRef<HTMLButtonElement>(null);
  // Para onde o foco volta quando a linha sai de um modo (o botão que abriu o modo).
  const voltar = useRef<'renomear' | 'tirar' | null>(null);
  const selo = seloDaCopia(chave);

  useEffect(() => {
    if (modo === 'renomear') campo.current?.focus();
    if (modo === 'ver' && voltar.current) {
      (voltar.current === 'renomear' ? btRenomear : btTirar).current?.focus();
      voltar.current = null;
    }
  }, [modo]);

  function sair(de: 'renomear' | 'tirar') {
    voltar.current = de;
    setModo('ver');
  }

  async function salvar(e: FormEvent) {
    e.preventDefault();
    const erro = erroDoNome(nome);
    if (erro) {
      setErroNome(erro);
      return campo.current?.focus();
    }
    if (nome.trim() === chave.name) return sair('renomear');
    setOcupado(true);
    const r = await chamar(() => api.PATCH('/v1/me/passkeys/{id}', { params: { path: { id: chave.id } }, body: { name: nome.trim() } }));
    setOcupado(false);
    if (!r.ok) {
      setErroNome(mensagemDe(r.problema));
      return campo.current?.focus();
    }
    sair('renomear');
    aoMudar(r.data, 'Nome salvo.', false);
  }

  async function tirar() {
    setOcupado(true);
    const r = await chamar(() => api.DELETE('/v1/me/passkeys/{id}', { params: { path: { id: chave.id } } }));
    setOcupado(false);
    if (!r.ok) {
      sair('tirar');
      return aoErro(mensagemDe(r.problema));
    }
    aoMudar(r.data, AVISO_DE_TIRADA, true);
  }

  return (
    <li className="chave-acesso">
      <span className="ap-ic" aria-hidden="true">
        <Icone nome="key" />
      </span>
      <div className="ap-txt">
        <p className="ap-nome">
          {chave.name}
          <span className={`st st--${selo.tom}`}>
            <span className="dot" aria-hidden="true" />
            {selo.texto}
          </span>
        </p>
        <p className="ap-meta">{detalheDaChave(chave, agora)}</p>
        <p className="ap-meta">{sobreACopia(chave)}</p>
      </div>
      <div className="chave-acesso-acoes">
        {modo === 'renomear' && (
          <form className="chave-acesso-renomear" onSubmit={(e) => disparar(salvar(e))} noValidate>
            <label className="sr-only" htmlFor={`${ids}-nome`}>
              Nome da chave
            </label>
            <input
              ref={campo}
              className="input"
              id={`${ids}-nome`}
              value={nome}
              maxLength={60}
              onChange={(e) => setNome(e.target.value)}
              aria-invalid={erroNome ? true : undefined}
              aria-describedby={erroNome ? `${ids}-nome-erro` : undefined}
            />
            <button className="btn btn--sm btn--primary" type="submit" disabled={ocupado} aria-busy={ocupado}>
              {ocupado ? 'Salvando…' : 'Salvar'}
            </button>
            <button className="btn btn--sm" type="button" disabled={ocupado} onClick={() => sair('renomear')}>
              Cancelar
            </button>
            {erroNome && (
              <p className="campo-erro" id={`${ids}-nome-erro`}>
                {erroNome}
              </p>
            )}
          </form>
        )}
        {modo === 'tirar' && (
          <ConfirmaNaLinha
            texto={textoDeTirar(ultima)}
            rotulo="Tirar a chave"
            rotuloOcupado="Tirando…"
            ocupado={ocupado}
            aoConfirmar={() => disparar(tirar())}
            aoCancelar={() => sair('tirar')}
          />
        )}
        {modo === 'ver' && (
          <>
            <button
              ref={btRenomear}
              className="btn btn--sm"
              type="button"
              aria-label={`Renomear ${chave.name}`}
              onClick={() => {
                setNome(chave.name);
                setErroNome('');
                setModo('renomear');
              }}
            >
              Renomear
            </button>
            <button
              ref={btTirar}
              className="btn btn--sm btn--perigo"
              type="button"
              aria-label={`Tirar ${chave.name}`}
              onClick={() => (ultima && !temApp ? setBloqueada(true) : setModo('tirar'))}
            >
              Tirar
            </button>
          </>
        )}
      </div>
      {bloqueada && (
        <p className="chave-acesso-bloqueio" role="status">
          {BLOQUEIO_DA_ULTIMA}
        </p>
      )}
    </li>
  );
}
