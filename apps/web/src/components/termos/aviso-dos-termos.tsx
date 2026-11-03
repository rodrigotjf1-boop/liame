'use client';

import type { MyTermsResponse } from '@liame/contracts';
import { usePathname } from 'next/navigation';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { useAvisar } from '@/components/ui/avisos';
import { Faixa } from '@/components/ui/faixa';
import { Icone } from '@/components/ui/icone';
import { api, chamar, mensagemDe } from '@/lib/api';
import { disparar } from '@/lib/disparar';
import { useSessao } from '@/lib/sessao';
import { GavetaOQueMuda } from './gaveta-o-que-muda';
import { TelaDoAceite } from './tela-do-aceite';
import { dataBr, faixaDoDiaNaCobranca, faixaDosTermos, hojeEmBrasilia } from './textos';

// Os Termos novos no shell (A7, W14, parte 14d; P35 aprovado; D-A7-90 a D-A7-93). Com a função ligada para a pessoa:
// durante o aviso, a faixa no alto de todas as telas até ela aceitar (âmbar nos últimos 7 dias); no dia, a tela do aceite
// no lugar do conteúdo, para quem ainda não aceitou (o Dono ainda abre Plano e cobrança, para cancelar ou exportar, com a
// faixa do dia). A situação é lida ao entrar e depois de aceitar. Desligada, ou sem resposta, a tela segue como sempre.
// A situação e a gaveta com o aceite ficam no contexto: o cartão "Termos e privacidade" (parte 14e) usa as mesmas, e o
// aceite feito por ele tira a faixa na hora.

const CAMINHO_DA_COBRANCA = '/cobranca';

type TermosNovos = {
  /** A situação da pessoa, com a função ligada; senão, `null`. */
  estado: MyTermsResponse | null;
  /** Abre a gaveta com o aceite da versão que vem, enquanto falta o aceite; senão, `null`. */
  verOQueMuda: ((de: HTMLElement) => void) | null;
};
const Contexto = createContext<TermosNovos>({ estado: null, verOQueMuda: null });
export const useTermosNovos = (): TermosNovos => useContext(Contexto);

export function AvisoDosTermos({ children }: { children: ReactNode }) {
  const { me, empresa, sair } = useSessao();
  const caminho = usePathname();
  const avisar = useAvisar();
  const [estado, setEstado] = useState<MyTermsResponse | null>(null);
  const [gaveta, setGaveta] = useState(false);
  const [ocupado, setOcupado] = useState(false);
  const [erro, setErro] = useState('');
  const origem = useRef<HTMLElement | null>(null);
  const seq = useRef(0);
  const pessoa = me?.user.id ?? null;

  const ler = useCallback(async () => {
    const id = ++seq.current;
    const r = await chamar(() => api.GET('/v1/me/terms'));
    if (id === seq.current) setEstado(r.ok ? r.data : null);
  }, []);

  useEffect(() => {
    setEstado(null);
    if (pessoa) disparar(ler());
  }, [pessoa, ler]);

  // Tolerante à API sem a rota (a tela nova durante um deploy) e à função desligada: nada muda.
  const ligada = estado?.enabled ? estado : null;
  const versao = ligada ? (ligada.required ?? (ligada.next && !ligada.next_accepted_at ? ligada.next : null)) : null;
  const noDia = !!ligada?.required;
  const dono = empresa?.role === 'dono';

  async function aceitar() {
    if (!versao || ocupado) return;
    setOcupado(true);
    setErro('');
    const r = await chamar(() => api.POST('/v1/me/terms/accept', { body: { version: versao.version } }));
    setOcupado(false);
    if (!r.ok) {
      setErro(mensagemDe(r.problema));
      return;
    }
    seq.current += 1;
    setEstado(r.data);
    setGaveta(false);
    avisar(`Pronto: você aceitou os Termos de ${dataBr(versao.effective_on)}.`);
  }

  const abrir = (de: HTMLElement) => {
    origem.current = de;
    setErro('');
    setGaveta(true);
  };
  function conteudo(): ReactNode {
    if (!ligada || !versao) return children;
    const gavetaNaTela = gaveta && (
      <GavetaOQueMuda
        versao={versao}
        noDia={noDia}
        dono={dono}
        hoje={{ termos: ligada.current.terms_url, privacidade: ligada.current.privacy_url }}
        ocupado={ocupado}
        erro={erro}
        reserva={origem}
        aoAceitar={() => disparar(aceitar())}
        aoFechar={() => setGaveta(false)}
      />
    );
    const verOQueMuda = (
      <button className="btn btn--primary" type="button" onClick={(e) => abrir(e.currentTarget)} aria-haspopup="dialog" aria-expanded={gaveta}>
        Ver o que muda
      </button>
    );

    // No dia: a tela do aceite no lugar do conteúdo; o Dono ainda abre Plano e cobrança, com a faixa do dia.
    if (noDia) {
      if (dono && caminho.startsWith(CAMINHO_DA_COBRANCA)) {
        const f = faixaDoDiaNaCobranca(versao);
        return (
          <>
            <Faixa tipo="atencao" icone={<Icone nome="file" />} titulo={f.titulo} texto={f.texto} acao={verOQueMuda} />
            {children}
            {gavetaNaTela}
          </>
        );
      }
      return (
        <>
          <TelaDoAceite
            versao={versao}
            dono={dono}
            ocupado={ocupado}
            erro={gaveta ? '' : erro}
            aoAceitar={() => disparar(aceitar())}
            aoVer={abrir}
            aoSair={() => disparar(sair())}
          />
          {gavetaNaTela}
        </>
      );
    }

    // Durante o aviso: a faixa no alto, até a pessoa aceitar.
    const f = faixaDosTermos(versao, hojeEmBrasilia());
    return (
      <>
        <Faixa tipo={f.tipo} icone={<Icone nome={f.tipo === 'atencao' ? 'clock' : 'file'} />} titulo={f.titulo} texto={f.texto} acao={verOQueMuda} />
        {children}
        {gavetaNaTela}
      </>
    );
  }

  const valor: TermosNovos = { estado: ligada, verOQueMuda: versao && !noDia ? abrir : null };
  return <Contexto.Provider value={valor}>{conteudo()}</Contexto.Provider>;
}
