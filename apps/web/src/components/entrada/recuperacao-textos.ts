import type { AccountRecovery, AccountRecoveryReason, MyAccountRecoveryResponse } from '@liame/contracts';
import { quandoComHora } from '@/lib/formato';

// As frases da recuperação da conta do Dono na entrada (P34 aprovado; A7, W8, parte 5; D-A7-62, D-A7-64). Quem decide é o
// servidor (`recuperacao.service.ts`): a tela só mostra o andamento e evita pedir o que ele recusaria.

/** O que aconteceu, como o pedido pergunta. */
export const MOTIVOS: readonly { valor: AccountRecoveryReason; rotulo: string }[] = [
  { valor: 'perdi_celular_e_codigos', rotulo: 'Perdi o celular e os códigos' },
  { valor: 'celular_roubado_ou_quebrado', rotulo: 'O celular foi roubado ou quebrou, e não tenho os códigos' },
  { valor: 'outro', rotulo: 'Outro motivo' },
];

/** O documento: JPG, PNG ou PDF, até 10 MB (o servidor confere pelo conteúdo). */
export const DOCUMENTO = { tipos: ['image/jpeg', 'image/png', 'application/pdf'], maxBytes: 10 * 1024 * 1024 } as const;

/** O documento escolhido, conferido antes de enviar; nulo = pode ir. */
export function problemaDoDocumento(arquivo: { type: string; size: number } | null): string | null {
  if (!arquivo) return 'Mande o seu documento com foto.';
  if (!(DOCUMENTO.tipos as readonly string[]).includes(arquivo.type)) return 'Mande o documento em JPG, PNG ou PDF.';
  if (arquivo.size > DOCUMENTO.maxBytes) return 'O documento passa de 10 MB. Mande uma foto menor ou um PDF mais leve.';
  if (arquivo.size === 0) return 'O arquivo está vazio. Escolha o documento de novo.';
  return null;
}

/** O pedido ainda anda (a pessoa acompanha e pode cancelar). */
export const emAndamento = (r: AccountRecovery | null): boolean => r !== null && ['pedido', 'conferido', 'parado'].includes(r.status);

export type Etapa = { situacao: 'feito' | 'agora' | 'parado' | 'depois'; titulo: string; texto: string };

const APP_NOVO = 'Ao entrar com a senha, você lê o QR do app novo e recebe 10 códigos novos';

/** O andamento do pedido, em etapas, como o P34 mostra. */
export function etapas(r: AccountRecovery, agora = new Date()): Etapa[] {
  const recebido: Etapa = { situacao: 'feito', titulo: 'Pedido recebido', texto: quandoComHora(r.created_at, agora) };
  const conferido: Etapa | null = r.checked_at
    ? { situacao: 'feito', titulo: 'Conferência da DMS', texto: `O documento, o quadro de sócios e a videochamada · ${quandoComHora(r.checked_at, agora)}` }
    : null;
  switch (r.status) {
    case 'pedido':
      return [
        recebido,
        { situacao: 'agora', titulo: 'Conferência da DMS', texto: 'O documento, o quadro de sócios e uma videochamada curta, em até 2 dias úteis; a DMS marca pelo seu e-mail' },
        { situacao: 'depois', titulo: 'Espera de segurança', texto: '7 dias depois da conferência, com aviso ao seu e-mail e aos Administradores' },
        { situacao: 'depois', titulo: 'Cadastrar o app novo', texto: APP_NOVO },
      ];
    case 'conferido':
      return [
        recebido,
        conferido!,
        {
          situacao: 'agora',
          titulo: 'Espera de segurança',
          texto: `Até ${r.applies_at ? quandoComHora(r.applies_at, agora) : ''}. Avisamos o seu e-mail e os Administradores das suas empresas.`,
        },
        { situacao: 'depois', titulo: 'Cadastrar o app novo', texto: APP_NOVO },
      ];
    case 'parado':
      return [
        recebido,
        ...(conferido ? [conferido] : []),
        {
          situacao: 'parado',
          titulo: 'Pedido parado',
          texto: 'Um Administrador não reconheceu o pedido. A DMS fala com você pelo e-mail e pelo telefone cadastrados antes de seguir.',
        },
      ];
    case 'aplicado':
      return [
        recebido,
        ...(conferido ? [conferido] : []),
        { situacao: 'feito', titulo: 'Espera de segurança', texto: `Terminou ${r.closed_at ? quandoComHora(r.closed_at, agora) : ''}` },
        { situacao: 'agora', titulo: 'Cadastrar o app novo', texto: 'Entre com a senha: você lê o QR do app novo e recebe 10 códigos novos.' },
      ];
    case 'recusado':
      return [recebido, { situacao: 'parado', titulo: 'Pedido recusado pela DMS', texto: r.refusal_reason ?? '' }];
    case 'cancelado': {
      const quando = r.closed_at ? quandoComHora(r.closed_at, agora) : '';
      return [
        recebido,
        ...(conferido ? [conferido] : []),
        {
          situacao: 'parado',
          titulo: 'Pedido cancelado',
          texto:
            r.cancelled_by === 'entrou'
              ? `${maiuscula(quando)}: você entrou com o app ou com um código, e o pedido caiu sozinho. Nada mudou na sua conta.`
              : `${maiuscula(quando)}, por você. Nada mudou na sua conta.`,
        },
      ];
    }
  }
}

function maiuscula(texto: string): string {
  return texto ? texto[0]!.toUpperCase() + texto.slice(1) : texto;
}

/** Por que não dá para pedir, em palavras; nulo = pode pedir (ou já tem um pedido andando, que a tela mostra). */
export function porQueNaoPode(
  motivo: MyAccountRecoveryResponse['cannot_request'],
  suporte: string,
): { titulo: string; texto: string } | null {
  switch (motivo) {
    case 'nao-e-dono':
      return { titulo: 'A recuperação pela DMS é só para o Dono', texto: `Sem o celular e sem os códigos, fale com o suporte: ${suporte}.` };
    case 'indisponivel':
      return { titulo: 'Fale com o suporte', texto: `A recuperação pela entrada ainda não está ligada. Escreva para ${suporte}.` };
    case 'ja-entrou':
      return { titulo: 'Você já entrou', texto: 'Para trocar o app autenticador, use Segurança da conta.' };
    case 'sem-segundo-fator':
      return { titulo: 'Sua conta não tem app autenticador', texto: 'Entre só com o e-mail e a senha.' };
    default:
      return null;
  }
}
