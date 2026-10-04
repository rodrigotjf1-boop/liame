'use client';

import { createContext, type ReactNode, useCallback, useContext, useMemo, useRef, useState } from 'react';

// O painel da Conversa com a LIA é do shell: fica ao lado da tela (ou por cima, nas menores) e segue aberto ao
// trocar de tela. Aqui vive só o que as outras telas precisam: abrir, fechar e mandar uma pergunta pronta.

export interface PedidoDeConversa {
  /** Muda a cada pedido: o painel sabe que é um pedido novo mesmo com o mesmo texto. */
  id: number;
  texto: string;
}

export interface Conversa {
  /** A pessoa pode conversar com a LIA nesta empresa (`conversa.usar`, com empresa ativa). */
  disponivel: boolean;
  aberta: boolean;
  /** Chegou resposta com o painel fechado. */
  temNova: boolean;
  /** Abre o painel; com `pergunta`, manda a pergunta assim que ele abrir. */
  abrir: (opcoes?: { pergunta?: string }) => void;
  fechar: (opcoes?: { devolverFoco?: boolean }) => void;
  alternar: () => void;
  pedido: PedidoDeConversa | null;
  consumirPedido: () => void;
  marcarNova: (tem: boolean) => void;
}

const SEM_CONVERSA: Conversa = {
  disponivel: false,
  aberta: false,
  temNova: false,
  abrir: () => {},
  fechar: () => {},
  alternar: () => {},
  pedido: null,
  consumirPedido: () => {},
  marcarNova: () => {},
};

const ConversaContexto = createContext<Conversa>(SEM_CONVERSA);

/** Fora do shell (testes, telas de entrada), a conversa não está disponível e os botões dela não aparecem. */
export function useConversa(): Conversa {
  return useContext(ConversaContexto);
}

/** O id do botão do topo que abre a conversa: é para ele que o foco volta quando quem abriu sumiu da tela. */
export const ID_DO_BOTAO_DA_LIA = 'bt-lia';
export const ID_DO_PAINEL = 'lia';

export function ConversaProvider({ disponivel, children }: { disponivel: boolean; children: ReactNode }) {
  const [aberta, setAberta] = useState(false);
  const [temNova, setTemNova] = useState(false);
  const [pedido, setPedido] = useState<PedidoDeConversa | null>(null);
  const origem = useRef<HTMLElement | null>(null);
  const seq = useRef(0);

  const abrir = useCallback(
    (opcoes?: { pergunta?: string }) => {
      if (!disponivel) return;
      const pergunta = opcoes?.pergunta?.trim();
      if (pergunta) setPedido({ id: ++seq.current, texto: pergunta });
      setAberta((ja) => {
        if (!ja) {
          const ativo = document.activeElement;
          origem.current = ativo instanceof HTMLElement && ativo !== document.body && !ativo.closest(`#${ID_DO_PAINEL}`) ? ativo : null;
        }
        return true;
      });
      setTemNova(false);
    },
    [disponivel],
  );

  const fechar = useCallback((opcoes?: { devolverFoco?: boolean }) => {
    setAberta(false);
    if (opcoes?.devolverFoco === false) {
      origem.current = null;
      return;
    }
    const alvo = origem.current;
    origem.current = null;
    // Depois do commit: o resto da tela deixa de estar inerte e pode receber o foco.
    setTimeout(() => {
      const botao = document.getElementById(ID_DO_BOTAO_DA_LIA);
      const volta = alvo && alvo.isConnected && !alvo.closest('[inert]') && alvo.getClientRects().length ? alvo : botao;
      volta?.focus({ preventScroll: true });
      // Quem abriu pode não aceitar o foco (o item do menu, com a gaveta fechada no celular): fica o botão do topo.
      if (volta !== botao && document.activeElement !== volta) botao?.focus({ preventScroll: true });
    }, 0);
  }, []);

  const valor = useMemo<Conversa>(
    () => ({
      disponivel,
      aberta: disponivel && aberta,
      temNova,
      abrir,
      fechar,
      alternar: () => (aberta ? fechar() : abrir()),
      pedido,
      consumirPedido: () => setPedido(null),
      marcarNova: setTemNova,
    }),
    [disponivel, aberta, temNova, abrir, fechar, pedido],
  );
  return <ConversaContexto.Provider value={valor}>{children}</ConversaContexto.Provider>;
}
