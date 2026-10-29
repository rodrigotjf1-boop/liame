'use client';

import type { BrandPhoto, PostChannelAccounts, PostResponse } from '@liame/contracts';
import Link from 'next/link';
import { type FormEvent, type RefObject, useEffect, useId, useRef, useState } from 'react';
import { Icone } from '@/components/ui/icone';
import { useDialogo } from '@/components/ui/use-dialogo';
import { api, chamar, mensagemDe } from '@/lib/api';
import { disparar } from '@/lib/disparar';
import { PreviaDoCanal } from './previa-do-canal';
import { PreviaDoPacote } from './previa-do-pacote';
import {
  CANAIS_DO_LIAME,
  CANAIS_DO_PACOTE,
  campoDaRecusa,
  conferirNovo,
  contaDoCanal,
  DO_TEXTO,
  dicaDaHora,
  dicaDoTexto,
  type ErrosDoNovo,
  ehDoPacote,
  formatoDaPrevia,
  instanteNoFuso,
  LIMITE_DO_TEXTO,
  NOME_DO_CANAL,
  type NovoPost,
  quadroDoRecorte,
  somaDias,
  textoDoBotao,
} from './textos';

// O novo post (P19, gaveta à direita; D-A6-20): a foto (das Fotos), onde sai (o Instagram e a Página ligados à marca, uma
// conta em cada, D-A6-36), o texto de cada canal com o limite da rede, o recorte do Instagram quando a foto não cabe
// nele (D-A6-21), o dia e a hora (entre 8h e 22h no fuso da empresa). A tela confere antes de mandar, e o servidor
// confere de novo; o post vira um pedido em Aprovações, que só sai com o código do app. O item da pauta ("Fazer o
// post") fica para quando o servidor mandar a pauta na Agenda (divergência do P19). O pacote pronto (P22; Z8): os
// canais em dois grupos, o que o Liame publica e o que a pessoa publica (o TikTok e o YouTube, sem conta); o botão diz o
// que acontece (mandar para aprovação, montar o pacote, ou os dois), e o pacote fica pronto na Agenda, na mesma hora.

type Props = {
  marca: string;
  /** As fotos prontas das Fotos da marca, a mais nova primeiro; nula quando as Fotos não estão ligadas ou não abriram. */
  fotos: BrandPhoto[] | null;
  canais: PostChannelAccounts[];
  fuso: string;
  hoje: string;
  podeVerContas: boolean;
  podeVerFotos: boolean;
  reserva: RefObject<HTMLElement | null>;
  /** O post mandado (o do Liame ou, sem ele, o primeiro pacote) e os canais que a pessoa escolheu. */
  aoMandar: (post: PostResponse, canais: string[]) => void;
  aoFechar: () => void;
};

/** A ordem dos canais na tela e no pedido: os do Liame, depois os do pacote. */
const ORDEM: readonly string[] = [...CANAIS_DO_LIAME, ...CANAIS_DO_PACOTE];

export function GavetaNovoPost({ marca, fotos, canais, fuso, hoje, podeVerContas, podeVerFotos, reserva, aoMandar, aoFechar }: Props) {
  const ids = useId();
  const primeiroCampo = useRef<HTMLButtonElement>(null);
  const fecharBt = useRef<HTMLButtonElement>(null);
  const corpo = useRef<HTMLDivElement>(null);
  const contas = Object.fromEntries(CANAIS_DO_LIAME.map((c) => [c, contaDoCanal(canais.find((x) => x.channel === c)?.accounts ?? [])]));
  const { ref, fechar, devolverFoco } = useDialogo({ focoInicial: fotos?.length ? primeiroCampo : fecharBt, reserva });
  const [novo, setNovo] = useState<NovoPost>(() => ({
    foto: null,
    canais: CANAIS_DO_LIAME.filter((c) => contas[c]?.conta),
    textos: Object.fromEntries(ORDEM.map((c) => [c, ''])),
    dia: somaDias(hoje, 1),
    hora: '19:00',
    recorte: 50,
  }));
  const [aba, setAba] = useState<string>(() => ORDEM.find((c) => contas[c]?.conta) ?? 'instagram');
  const [erros, setErros] = useState<ErrosDoNovo>({});
  const [erroGeral, setErroGeral] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);
  const foto = fotos?.find((f) => f.id === novo.foto) ?? null;
  const abaAtual = novo.canais.includes(aba) ? aba : (novo.canais[0] ?? aba);
  const quadro = foto && novo.canais.includes('instagram') ? quadroDoRecorte(foto.width, foto.height, novo.recorte) : null;
  const formato = foto ? formatoDaPrevia('instagram', foto.width, foto.height) : 'inteira';

  const mudar = (parcial: Partial<NovoPost>) => setNovo((n) => ({ ...n, ...parcial }));
  const tirarErro = (campo: string) => setErros((e) => (e[campo] ? Object.fromEntries(Object.entries(e).filter(([k]) => k !== campo)) : e));

  // O foco vai ao primeiro erro depois que a tela redesenha: na recusa do servidor, os campos só voltam a aceitar foco
  // quando o "Mandando…" sai da tela (um campo desabilitado recusa o foco, e ele cairia na página).
  const focoPendente = useRef<ErrosDoNovo | null>(null);
  const [pedidoDeFoco, setPedidoDeFoco] = useState(0);
  useEffect(() => {
    const e = focoPendente.current;
    if (!e || enviando) return;
    focoPendente.current = null;
    const textoComErro = novo.canais.find((c) => e[`texto-${c}`]);
    const alvo = e.foto
      ? ref.current?.querySelector<HTMLElement>('.po-foto-op')
      : e.canais
        ? ref.current?.querySelector<HTMLElement>('.po-canal input:not([disabled])')
        : textoComErro
          ? ref.current?.querySelector<HTMLElement>(`#${CSS.escape(`${ids}-texto`)}`)
          : ref.current?.querySelector<HTMLElement>(`#${CSS.escape(`${ids}-hora`)}`);
    alvo?.focus();
  }, [pedidoDeFoco, enviando, novo.canais, ref, ids]);

  function focarErro(e: ErrosDoNovo) {
    const textoComErro = novo.canais.find((c) => e[`texto-${c}`]);
    if (textoComErro && !e[`texto-${abaAtual}`]) setAba(textoComErro);
    focoPendente.current = e;
    setPedidoDeFoco((n) => n + 1);
  }

  async function mandar(ev: FormEvent) {
    ev.preventDefault();
    setErroGeral(null);
    const e = conferirNovo(novo, new Date(), fuso);
    setErros(e);
    if (Object.keys(e).length) return focarErro(e);
    setEnviando(true);
    const canaisNaOrdem = ORDEM.filter((c) => novo.canais.includes(c));
    const r = await chamar(() =>
      api.POST('/v1/posts', {
        body: {
          brand_id: marca,
          photo_id: novo.foto!,
          publish_at: instanteNoFuso(novo.dia, novo.hora, fuso).toISOString(),
          ...(quadro ? { crop_pos: novo.recorte } : {}),
          channels: canaisNaOrdem.map((c) => ({ channel: c as 'instagram' | 'facebook' | 'tiktok' | 'youtube', text: (novo.textos[c] ?? '').trim() })),
        },
      }),
    );
    setEnviando(false);
    if (r.ok) {
      aoMandar(r.data, canaisNaOrdem);
      return fechar();
    }
    const campo = campoDaRecusa(r.problema.code);
    const texto = mensagemDe(r.problema);
    if (campo === 'texto') {
      const e2 = { [`texto-${abaAtual}`]: texto };
      setErros(e2);
      return focarErro(e2);
    }
    if (campo) {
      const e2 = { [campo]: texto };
      setErros(e2);
      return focarErro(e2);
    }
    setErroGeral(texto);
    corpo.current?.scrollTo({ top: 0 });
  }

  function copiarTexto() {
    const t = novo.textos[abaAtual] ?? '';
    mudar({ textos: Object.fromEntries(ORDEM.map((c) => [c, novo.canais.includes(c) ? t : (novo.textos[c] ?? '')])) });
  }

  const limite = LIMITE_DO_TEXTO[abaAtual] ?? 0;
  const tamanho = (novo.textos[abaAtual] ?? '').length;
  const erroTexto = erros[`texto-${abaAtual}`];
  const algumCanal = CANAIS_DO_LIAME.some((c) => contas[c]?.conta);

  /** A linha de um canal: a caixa de marcar, o nome e a conta (ou por que não dá). O canal do pacote não tem conta. */
  const caixaDoCanal = (c: string) => {
    const { conta, fora } = contas[c] ?? { conta: null, fora: null };
    return (
      <div key={c} className={`po-canal${fora ? ' po-canal--fora' : ''}`}>
        <label>
          <input
            type="checkbox"
            checked={novo.canais.includes(c)}
            disabled={Boolean(fora) || enviando}
            onChange={(e) => {
              mudar({ canais: e.target.checked ? ORDEM.filter((x) => x === c || novo.canais.includes(x)) : novo.canais.filter((x) => x !== c) });
              if (e.target.checked) setAba(c);
              tirarErro('canais');
            }}
          />
          {NOME_DO_CANAL[c]}
        </label>
        {conta && <span className="campo-dica">{conta.name}</span>}
        {fora && <span className="campo-dica">{fora}</span>}
      </div>
    );
  };

  return (
    <dialog
      ref={ref}
      className="dialogo dialogo--lado po-gaveta"
      aria-labelledby={`${ids}-t`}
      onClose={() => {
        aoFechar();
        devolverFoco();
      }}
      onClick={(e) => {
        if (e.target === ref.current && !enviando) fechar();
      }}
    >
      <form className="dialogo-form" onSubmit={(e) => disparar(mandar(e))} noValidate>
        <div className="dialogo-cab">
          <div className="dlg-titulo">
            <p className="rotulo-marca">Agenda</p>
            <h2 id={`${ids}-t`}>Novo post</h2>
          </div>
          <button className="btn btn--icon btn--ghost" type="button" ref={fecharBt} onClick={fechar} aria-label="Fechar" disabled={enviando}>
            <Icone nome="x" />
          </button>
        </div>
        <div className="dialogo-corpo" ref={corpo}>
          {erroGeral && (
            <p className="dialogo-erro" role="alert">
              <Icone nome="alert" pequeno />
              <span>{erroGeral}</span>
            </p>
          )}
          <div className="campo" role="group" aria-labelledby={`${ids}-fotos-t`} aria-describedby={erros.foto ? `${ids}-foto-erro` : `${ids}-fotos-d`}>
            <span className="rotulo" id={`${ids}-fotos-t`}>
              A foto
            </span>
            <span className="campo-dica" id={`${ids}-fotos-d`}>
              As fotos de verdade dos produtos, da tela Fotos.
            </span>
            {fotos?.length ? (
              <ul className="po-fotos" aria-label="Fotos da marca">
                {fotos.map((f, i) => (
                  <li key={f.id}>
                    <button
                      className="po-foto-op"
                      type="button"
                      ref={i === 0 ? primeiroCampo : undefined}
                      aria-pressed={novo.foto === f.id}
                      aria-label={`${f.product ?? 'Sem produto'}${f.description ? `: ${f.description}` : ''}`}
                      onClick={() => {
                        mudar({ foto: f.id, recorte: 50 });
                        tirarErro('foto');
                      }}
                      disabled={enviando}
                    >
                      <img src={f.thumbnail_url} alt="" referrerPolicy="no-referrer" />
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="po-nota">
                <Icone nome="camera" pequeno />
                <span>
                  {fotos === null ? 'As Fotos não estão ligadas para esta empresa, ou não abriram agora: o post precisa de uma foto de lá.' : 'Nenhuma foto pronta nas Fotos desta marca: o post precisa de uma foto de lá.'}
                  {podeVerFotos && fotos !== null ? ' Envie uma em Fotos.' : ''}
                </span>
              </p>
            )}
            {erros.foto && (
              <span className="campo-erro" id={`${ids}-foto-erro`}>
                {erros.foto}
              </span>
            )}
          </div>

          <fieldset className="campo" aria-describedby={`${erros.canais ? `${ids}-canais-erro ` : ''}${ids}-pacote-d`}>
            <legend>Onde sai</legend>
            <p className="po-grupo-t" id={`${ids}-liame-t`}>
              O Liame publica, depois de aprovado
            </p>
            <div className="po-canais" role="group" aria-labelledby={`${ids}-liame-t`}>
              {CANAIS_DO_LIAME.map(caixaDoCanal)}
            </div>
            {!algumCanal && podeVerContas && (
              <Link className="btn btn--sm" href="/contas">
                <Icone nome="plug" pequeno />
                Abrir Contas conectadas
              </Link>
            )}
            <p className="po-grupo-t" id={`${ids}-pacote-t`}>
              Você publica: o Liame monta o pacote
            </p>
            <div className="po-canais" role="group" aria-labelledby={`${ids}-pacote-t`}>
              {CANAIS_DO_PACOTE.map(caixaDoCanal)}
            </div>
            <span className="campo-dica" id={`${ids}-pacote-d`}>
              No TikTok e no YouTube, o Liame não publica: ele monta o texto, a foto e a hora, e o pacote aparece na Agenda para você publicar.
            </span>
            {erros.canais && (
              <span className="campo-erro" id={`${ids}-canais-erro`}>
                {erros.canais}
              </span>
            )}
          </fieldset>

          {novo.canais.length > 0 && (
            <div className="campo">
              {novo.canais.length > 1 && (
                <div className="seg po-canais-seg" role="group" aria-label="O texto de cada canal">
                  {ORDEM.filter((c) => novo.canais.includes(c)).map((c) => (
                    <button key={c} type="button" aria-pressed={c === abaAtual} onClick={() => setAba(c)}>
                      {NOME_DO_CANAL[c]}
                      {erros[`texto-${c}`] ? ' ⚠' : ''}
                    </button>
                  ))}
                </div>
              )}
              <label htmlFor={`${ids}-texto`}>Texto {DO_TEXTO[abaAtual] ?? `em ${abaAtual}`}</label>
              <textarea
                className="input"
                id={`${ids}-texto`}
                rows={4}
                value={novo.textos[abaAtual] ?? ''}
                onChange={(e) => {
                  mudar({ textos: { ...novo.textos, [abaAtual]: e.target.value } });
                  tirarErro(`texto-${abaAtual}`);
                }}
                aria-invalid={erroTexto ? true : undefined}
                aria-describedby={`${erroTexto ? `${ids}-texto-erro ` : ''}${ids}-texto-n ${ids}-texto-d`}
                disabled={enviando}
              />
              {erroTexto && (
                <span className="campo-erro" id={`${ids}-texto-erro`}>
                  {erroTexto}
                </span>
              )}
              <span className={`po-contador${limite && tamanho > limite ? ' po-contador--passou' : ''}`} id={`${ids}-texto-n`}>
                {tamanho.toLocaleString('pt-BR')} de {limite.toLocaleString('pt-BR')}
              </span>
              <span className="campo-dica" id={`${ids}-texto-d`}>
                {dicaDoTexto(abaAtual)}
                {novo.canais.length > 1 ? ` Cada canal tem o seu texto: comece por um e copie para ${novo.canais.length > 2 ? 'os outros' : 'o outro'}.` : ''}
              </span>
              {novo.canais.length > 1 && (
                <button className="btn btn--sm btn--ghost po-copiar" type="button" onClick={copiarTexto} disabled={enviando}>
                  <Icone nome="copy" pequeno />
                  {novo.canais.length > 2 ? 'Usar este texto nos outros canais' : 'Usar este texto no outro canal'}
                </button>
              )}
            </div>
          )}

          {foto && quadro && (
            <div className="campo po-recorte">
              <span className="rotulo">O recorte do Instagram</span>
              <div className={`po-recorte-foto${formato === 'alta' ? ' po-recorte-foto--alta' : ''}`}>
                <img src={foto.url} alt="" referrerPolicy="no-referrer" />
                <span className="po-quadro" style={{ top: `${quadro.top}%`, left: `${quadro.left}%`, width: `${quadro.width}%`, height: `${quadro.height}%` }} />
              </div>
              <label htmlFor={`${ids}-recorte`}>{formato === 'alta' ? 'Mais para cima ou para baixo' : 'Mais para a esquerda ou para a direita'}</label>
              <input
                type="range"
                id={`${ids}-recorte`}
                min={0}
                max={100}
                step={5}
                value={novo.recorte}
                onChange={(e) => mudar({ recorte: Number(e.target.value) })}
                aria-describedby={`${ids}-recorte-d`}
                disabled={enviando}
              />
              <span className="campo-dica" id={`${ids}-recorte-d`}>
                A foto é {formato === 'alta' ? 'mais alta' : 'mais larga'} do que o Instagram aceita: lá, sai o que está no quadro.
                {novo.canais.includes('facebook') && novo.canais.some(ehDoPacote)
                  ? ' Na Página e no pacote, a foto vai inteira.'
                  : novo.canais.includes('facebook')
                    ? ' Na Página, a foto vai inteira.'
                    : novo.canais.some(ehDoPacote)
                      ? ' No pacote, a foto vai inteira.'
                      : ''}
              </span>
            </div>
          )}

          <div className="po-hora">
            <div className="campo">
              <label htmlFor={`${ids}-dia`}>Dia</label>
              <input
                className="input"
                type="date"
                id={`${ids}-dia`}
                value={novo.dia}
                min={hoje}
                max={somaDias(hoje, 60)}
                onChange={(e) => {
                  mudar({ dia: e.target.value });
                  tirarErro('hora');
                }}
                aria-invalid={erros.hora ? true : undefined}
                aria-describedby={erros.hora ? `${ids}-hora-erro` : `${ids}-hora-d`}
                disabled={enviando}
              />
            </div>
            <div className="campo">
              <label htmlFor={`${ids}-hora`}>Hora</label>
              <input
                className="input"
                type="time"
                id={`${ids}-hora`}
                value={novo.hora}
                min="08:00"
                max="22:00"
                step={900}
                onChange={(e) => {
                  mudar({ hora: e.target.value });
                  tirarErro('hora');
                }}
                aria-invalid={erros.hora ? true : undefined}
                aria-describedby={erros.hora ? `${ids}-hora-erro` : `${ids}-hora-d`}
                disabled={enviando}
              />
            </div>
          </div>
          {erros.hora ? (
            <span className="campo-erro" id={`${ids}-hora-erro`}>
              {erros.hora}
            </span>
          ) : (
            <span className="campo-dica" id={`${ids}-hora-d`}>
              {dicaDaHora(novo.canais)}
            </span>
          )}

          {foto && novo.canais.length > 0 && (
            <section aria-labelledby={`${ids}-previa-t`} className="po-como-sai">
              <h3 className="rotulo-marca" id={`${ids}-previa-t`}>
                Como sai
              </h3>
              {ehDoPacote(abaAtual) ? (
                <PreviaDoPacote canal={abaAtual} texto={(novo.textos[abaAtual] ?? '').trim() || '…'} foto={foto} />
              ) : (
                <PreviaDoCanal
                  canal={abaAtual}
                  conta={contas[abaAtual]?.conta?.name ?? null}
                  texto={(novo.textos[abaAtual] ?? '').trim() || '…'}
                  foto={foto}
                  recorte={quadro ? novo.recorte : null}
                />
              )}
            </section>
          )}
        </div>
        <div className="dialogo-acoes">
          <span className="spacer" />
          <button className="btn" type="button" onClick={fechar} disabled={enviando}>
            Cancelar
          </button>
          <button className="btn btn--primary" type="submit" disabled={enviando}>
            {enviando ? 'Mandando…' : textoDoBotao(novo.canais)}
          </button>
        </div>
      </form>
    </dialog>
  );
}
