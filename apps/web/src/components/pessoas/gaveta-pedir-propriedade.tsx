'use client';

import type { OwnershipClaim, OwnershipClaimReason, OwnershipClaimResponse } from '@liame/contracts';
import { type FormEvent, type RefObject, useId, useRef, useState } from 'react';
import { problemaDoDocumento } from '@/components/entrada/recuperacao-textos';
import { Icone } from '@/components/ui/icone';
import { useDialogo } from '@/components/ui/use-dialogo';
import { api, chamar, mensagemDe } from '@/lib/api';
import { disparar } from '@/lib/disparar';
import { useTermos } from '@/lib/entrada';
import { enviarDocumentoDaPropriedade } from './enviar-documento-da-propriedade';
import { motivosDaPropriedade } from './propriedade-dms-textos';

// "Pedir a propriedade à DMS" (P34 aprovado; A7, W8, parte 6b; D-A7-63, D-A7-64): para quando o Dono não pode mais cuidar
// da conta e não consegue transferir. O que aconteceu, o documento com foto de quem pede, o documento da empresa que
// mostra quem a representa, o que a DMS precisa saber e o aceite dos Termos como dona, se a DMS aprovar. O envio vai em
// partes (o rascunho, os dois documentos, o envio); o que falhar no meio fica no rascunho e se completa ao tentar de novo.

type Props = {
  dono: string;
  empresa: string;
  /** O rascunho de uma tentativa anterior, se houver. */
  rascunho: OwnershipClaim | null;
  reserva: RefObject<HTMLElement | null>;
  aoEnviado: (r: OwnershipClaimResponse) => void;
  aoFechar: () => void;
};

const MAIOR_NOTA = 600;

export function GavetaPedirPropriedade({ dono, empresa, rascunho, reserva, aoEnviado, aoFechar }: Props) {
  const ids = useId();
  const primeiro = useRef<HTMLInputElement>(null);
  const campoFoto = useRef<HTMLInputElement>(null);
  const campoEmpresa = useRef<HTMLInputElement>(null);
  const campoTermos = useRef<HTMLInputElement>(null);
  const { ref, fechar, devolverFoco } = useDialogo({ focoInicial: primeiro, reserva });
  const { termos, problema: semTermos } = useTermos();
  const [motivo, setMotivo] = useState<OwnershipClaimReason | null>(rascunho?.reason ?? null);
  const [foto, setFoto] = useState<File | null>(null);
  const [daEmpresa, setDaEmpresa] = useState<File | null>(null);
  const [nota, setNota] = useState(rascunho?.note ?? '');
  const [aceito, setAceito] = useState(false);
  const [erros, setErros] = useState<{ motivo?: string; foto?: string; empresa?: string; termos?: string }>({});
  const [erro, setErro] = useState('');
  const [enviando, setEnviando] = useState(false);
  const jaTem = new Set(rascunho?.documents ?? []);

  async function enviar(e: FormEvent) {
    e.preventDefault();
    setErro('');
    const novos = {
      motivo: motivo ? undefined : 'Escolha o que aconteceu.',
      foto: jaTem.has('documento_com_foto') && !foto ? undefined : (problemaDoDocumento(foto) ?? undefined),
      empresa:
        jaTem.has('documento_da_empresa') && !daEmpresa
          ? undefined
          : daEmpresa
            ? (problemaDoDocumento(daEmpresa) ?? undefined)
            : 'Mande o documento da empresa que mostra você como representante.',
      termos: aceito ? undefined : 'Para pedir a propriedade, aceite os Termos de Uso como dona da conta.',
    };
    setErros(novos);
    if (novos.motivo) return primeiro.current?.focus();
    if (novos.foto) return campoFoto.current?.focus();
    if (novos.empresa) return campoEmpresa.current?.focus();
    if (novos.termos) return campoTermos.current?.focus();
    if (!termos) return setErro(semTermos ? mensagemDe(semTermos) : 'Os Termos ainda estão carregando. Tente de novo em instantes.');
    setEnviando(true);
    try {
      const r = await chamar(() =>
        api.POST('/v1/ownership/claims', { body: { reason: motivo!, note: nota.trim() ? nota.trim() : null, terms_version: termos.version } }),
      );
      if (!r.ok) return setErro(mensagemDe(r.problema));
      const id = r.data.claim!.id;
      for (const [tipo, arquivo] of [
        ['documento_com_foto', foto],
        ['documento_da_empresa', daEmpresa],
      ] as const) {
        if (!arquivo) continue;
        const d = await enviarDocumentoDaPropriedade(id, tipo, arquivo);
        if (!d.ok) return setErro(mensagemDe(d.problema));
      }
      const enviado = await chamar(() => api.POST('/v1/ownership/claims/{id}/send', { params: { path: { id } } }));
      if (!enviado.ok) return setErro(mensagemDe(enviado.problema));
      aoEnviado(enviado.data);
      fechar();
    } finally {
      setEnviando(false);
    }
  }

  return (
    <dialog
      ref={ref}
      className="dialogo dialogo--lado"
      aria-labelledby={`${ids}-t`}
      onClose={() => {
        aoFechar();
        devolverFoco();
      }}
    >
      <form className="dialogo-form" onSubmit={(e) => disparar(enviar(e))} noValidate>
        <div className="dialogo-cab">
          <h2 id={`${ids}-t`}>Pedir a propriedade à DMS</h2>
          <button className="btn btn--ghost btn--icon" type="button" onClick={fechar} aria-label="Fechar" disabled={enviando}>
            <Icone nome="x" />
          </button>
        </div>
        <div className="dialogo-corpo">
          {erro && (
            <p className="dialogo-erro" role="alert">
              <Icone nome="alert" pequeno />
              <span>{erro}</span>
            </p>
          )}
          <p className="dlg-lead">
            Para quando {dono} não pode mais cuidar da conta e não consegue transferir. A DMS confere quem representa a {empresa} antes de decidir.
          </p>
          <fieldset className="campo">
            <legend>O que aconteceu</legend>
            {erros.motivo && (
              <span className="campo-erro" id={`${ids}-motivo-erro`}>
                {erros.motivo}
              </span>
            )}
            <div className="opcoes">
              {motivosDaPropriedade(dono).map((m, i) => (
                <label className="opcao" key={m.valor}>
                  <input
                    ref={i === 0 ? primeiro : undefined}
                    type="radio"
                    name={`${ids}-motivo`}
                    value={m.valor}
                    checked={motivo === m.valor}
                    onChange={() => setMotivo(m.valor)}
                    aria-describedby={erros.motivo ? `${ids}-motivo-erro` : undefined}
                  />
                  <span className="opcao-txt">
                    <b>{m.titulo}</b>
                    <span>{m.texto}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          <div className="campo">
            <label htmlFor={`${ids}-foto`}>O seu documento com foto</label>
            <input
              ref={campoFoto}
              className="input input-arquivo"
              id={`${ids}-foto`}
              type="file"
              accept="image/jpeg,image/png,application/pdf"
              onChange={(e) => setFoto(e.target.files?.[0] ?? null)}
              aria-invalid={erros.foto ? true : undefined}
              aria-describedby={`${ids}-foto-dica${erros.foto ? ` ${ids}-foto-erro` : ''}`}
            />
            <span className="campo-dica" id={`${ids}-foto-dica`}>
              RG ou CNH, frente e verso. JPG, PNG ou PDF, até 10 MB.{jaTem.has('documento_com_foto') ? ' Já recebemos um; mande outro só para trocar.' : ''}
            </span>
            {erros.foto && (
              <span className="campo-erro" id={`${ids}-foto-erro`}>
                {erros.foto}
              </span>
            )}
          </div>
          <div className="campo">
            <label htmlFor={`${ids}-empresa`}>O documento que mostra você como representante da empresa</label>
            <input
              ref={campoEmpresa}
              className="input input-arquivo"
              id={`${ids}-empresa`}
              type="file"
              accept="image/jpeg,image/png,application/pdf"
              onChange={(e) => setDaEmpresa(e.target.files?.[0] ?? null)}
              aria-invalid={erros.empresa ? true : undefined}
              aria-describedby={`${ids}-empresa-dica${erros.empresa ? ` ${ids}-empresa-erro` : ''}`}
            />
            <span className="campo-dica" id={`${ids}-empresa-dica`}>
              O contrato social, a última alteração ou a certidão da Junta Comercial. A DMS confere também o quadro de sócios na Receita, pelo CNPJ.
              {jaTem.has('documento_da_empresa') ? ' Já recebemos um; mande outro só para trocar.' : ''}
            </span>
            {erros.empresa && (
              <span className="campo-erro" id={`${ids}-empresa-erro`}>
                {erros.empresa}
              </span>
            )}
          </div>
          <div className="campo">
            <label htmlFor={`${ids}-nota`}>
              Algo mais que a DMS precise saber <span className="campo-dica">(opcional)</span>
            </label>
            <textarea
              className="input textarea"
              id={`${ids}-nota`}
              rows={3}
              maxLength={MAIOR_NOTA}
              value={nota}
              onChange={(e) => setNota(e.target.value)}
              aria-describedby={`${ids}-nota-conta`}
            />
            <span className={`ag-contador${nota.length > MAIOR_NOTA - 60 ? ' ag-contador--perto' : ''}`} id={`${ids}-nota-conta`}>
              {nota.length} de {MAIOR_NOTA}
            </span>
          </div>
          <label className="check">
            <input
              ref={campoTermos}
              type="checkbox"
              checked={aceito}
              onChange={(e) => setAceito(e.target.checked)}
              aria-invalid={erros.termos ? true : undefined}
              aria-describedby={erros.termos ? `${ids}-termos-erro` : undefined}
            />
            <span>
              Li e aceito os{' '}
              {termos ? (
                <a href={termos.terms_url} target="_blank" rel="noreferrer">
                  Termos de Uso
                </a>
              ) : (
                'Termos de Uso'
              )}{' '}
              como dona da conta da {empresa}, se a DMS aprovar.
            </span>
          </label>
          {erros.termos && (
            <span className="campo-erro" id={`${ids}-termos-erro`}>
              {erros.termos}
            </span>
          )}
          <div className="rec-depois">
            <h3>O que acontece depois</h3>
            <ol>
              <li>A DMS confere os documentos e o quadro de sócios, e marca uma videochamada curta com você pelo seu e-mail.</li>
              <li>Avisamos {dono} no e-mail e esperamos 14 dias. Se houver resposta, a DMS fala com os dois antes de decidir.</li>
              <li>Aprovado, você vira a dona da conta, e o acesso de {dono} sai. Recusado, você recebe o motivo.</li>
            </ol>
            <p className="campo-dica">
              Os documentos ficam guardados à parte e são apagados 30 dias depois da decisão. Mande só por aqui: a DMS nunca pede documento por e-mail, por WhatsApp ou pela LIA.
            </p>
          </div>
        </div>
        <div className="dialogo-acoes">
          <button className="btn" type="button" onClick={fechar} disabled={enviando}>
            Cancelar
          </button>
          <button className="btn btn--primary" type="submit" disabled={enviando}>
            {enviando ? 'Enviando…' : 'Enviar o pedido à DMS'}
          </button>
        </div>
      </form>
    </dialog>
  );
}
