'use client';

import type { PasskeysResponse } from '@liame/contracts';
import { useEffect, useState } from 'react';
import { Estado } from '@/components/ui/estado';
import { Icone } from '@/components/ui/icone';
import { mensagemDe, type Problema } from '@/lib/api';
import { navegadorAceitaChave } from '@/lib/chave-de-acesso';
import { MAX_CHAVES, rotuloDeCriar, subtituloDasChaves } from './chaves-textos';
import { ItemChave } from './item-chave';

// O cartão "Chaves de acesso", no alto de Segurança da conta (A7, W9, parte 9c1; P28 aprovado; D-A7-54 a D-A7-58): o
// que a chave faz (quem ainda não tem), a lista com renomear e tirar, e "Criar uma chave de acesso" (a gaveta).

export type CargaDasChaves = { tipo: 'carregando' } | { tipo: 'ok'; dados: PasskeysResponse } | { tipo: 'erro'; problema: Problema };

type Props = {
  chaves: CargaDasChaves;
  agora: Date;
  /** A gaveta de criar está aberta (o botão diz `aria-expanded`). */
  criando: boolean;
  aoCriar: () => void;
  aoRecarregar: () => void;
  aoMudar: (dados: PasskeysResponse, aviso: string, tirada: boolean) => void;
  aoErro: (texto: string) => void;
};

export function CartaoChaves({ chaves, agora, criando, aoCriar, aoRecarregar, aoMudar, aoErro }: Props) {
  // O navegador só se conhece depois de montar (o primeiro render é igual no servidor e no navegador; V35).
  const [aceita, setAceita] = useState(true);
  useEffect(() => setAceita(navegadorAceitaChave()), []);
  const dados = chaves.tipo === 'ok' ? chaves.dados : null;
  const n = dados?.items.length ?? 0;
  const max = dados?.max ?? MAX_CHAVES;

  return (
    <article className="card chave-acesso-card anima" style={{ ['--i' as string]: 0 }} aria-labelledby="t-chaves" aria-busy={chaves.tipo === 'carregando'}>
      <div className="card-cab">
        <div>
          <h2 id="t-chaves">Chaves de acesso</h2>
          <p className="card-sub">{subtituloDasChaves(n)}</p>
        </div>
        {dados?.can_create && (
          <button className="btn btn--primary" type="button" aria-haspopup="dialog" aria-expanded={criando} disabled={n >= max || !aceita} onClick={aoCriar}>
            <Icone nome="key" />
            {rotuloDeCriar(n)}
          </button>
        )}
      </div>

      {chaves.tipo === 'carregando' && (
        <div className="chave-acesso-carregando" aria-hidden="true">
          <span className="esqueleto" style={{ width: '60%', height: 14 }} />
          <span className="esqueleto" style={{ width: '85%', height: 12 }} />
        </div>
      )}
      {chaves.tipo === 'erro' && (
        <Estado
          icone="alert"
          perigo
          titulo="Não deu para carregar as chaves de acesso"
          acao={
            <button className="btn" type="button" onClick={aoRecarregar}>
              <Icone nome="refresh" />
              Tentar de novo
            </button>
          }
        >
          {mensagemDe(chaves.problema)}
        </Estado>
      )}
      {dados?.can_create && !aceita && (
        <p className="seg-txt chave-acesso-sem-suporte" role="status">
          Este navegador não aceita chave de acesso. Para criar uma, use o Chrome, o Edge, o Safari ou o Firefox atualizados.
        </p>
      )}
      {dados && n === 0 && (
        <div className="chave-acesso-vazia">
          <span className="ap-ic" aria-hidden="true">
            <Icone nome="key" />
          </span>
          <div>
            <p className="seg-txt">
              <b>Uma chave de acesso fica no seu celular, no computador ou numa chave física.</b> Com ela:
            </p>
            <ul>
              <li>
                <Icone nome="check" pequeno />
                <span>você entra sem digitar a senha;</span>
              </li>
              <li>
                <Icone nome="check" pequeno />
                <span>ela vale pelo código do app, ao entrar e ao aprovar;</span>
              </li>
              <li>
                <Icone nome="check" pequeno />
                <span>ninguém consegue usá-la num site falso: ela só abre o Liame.</span>
              </li>
            </ul>
            <p className="seg-txt">O app autenticador e os códigos de recuperação continuam valendo.</p>
          </div>
        </div>
      )}
      {dados && n > 0 && (
        <ul className="aparelhos" aria-label="As suas chaves de acesso">
          {dados.items.map((k) => (
            <ItemChave key={k.id} chave={k} agora={agora} ultima={n === 1} temApp={dados.has_totp} aoMudar={aoMudar} aoErro={aoErro} />
          ))}
        </ul>
      )}
      {dados?.can_create && n >= max && <p className="seg-txt">Você chegou a {max} chaves. Para criar outra, tire uma.</p>}
    </article>
  );
}
