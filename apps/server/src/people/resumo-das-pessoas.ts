import { diaNoFuso } from '../cobranca/vida.js';
import { horaNoFuso, semanaFechada } from '../results/revisao-semanal.js';
import { ROLE_LABEL } from './grant-rules.js';

// O resumo da semana do que cada pessoa fez na conta, por e-mail ao Dono (ADR-017; A7, W8; D-A7-53). Sem banco: a
// semana, a classificação de cada ação da auditoria e o texto do e-mail. A rotina fica no worker
// (`worker/resumo-das-pessoas.service.ts`).

/** A partir desta hora da segunda-feira, no fuso da empresa, o resumo da semana que fechou no domingo pode sair. */
export const HORA_DO_RESUMO = 8;
/** Quantas vezes o envio ao Dono é tentado antes de desistir daquela semana. */
export const TENTATIVAS_DO_RESUMO = 3;

/** A semana do resumo (segunda a domingo, a última que fechou) e se já é hora de mandar. */
export function semanaDoResumo(agora: Date, fuso: string): { de: string; ate: string; pronto: boolean } {
  const hoje = diaNoFuso(agora, fuso);
  const semana = semanaFechada(hoje);
  // Na segunda-feira, a semana fechou à meia-noite, mas o resumo espera as 8h (como a revisão da semana).
  const segunda = new Date(Date.parse(`${semana.to}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  const pronto = hoje !== segunda || horaNoFuso(agora, fuso) >= HORA_DO_RESUMO;
  return { de: semana.from, ate: semana.to, pronto };
}

/** Os grupos do resumo, na ordem em que aparecem. As ações que mexem em dinheiro, em acesso e nos dados têm nome. */
export type Grupo = 'aprovou' | 'recusou' | 'verba' | 'pessoas' | 'contas' | 'parada' | 'cobranca' | 'exportou' | 'conta' | 'outras';
export const ORDEM_DOS_GRUPOS: readonly Grupo[] = ['aprovou', 'recusou', 'verba', 'pessoas', 'contas', 'parada', 'cobranca', 'exportou', 'conta', 'outras'];

/**
 * Ficam fora do resumo: entrar e sair, o próprio segundo fator e a própria senha (são da pessoa, não da empresa),
 * trocar a empresa em uso, confirmar o e-mail, aceitar o próprio convite, o cadastro da empresa (`conta.criar`, que é
 * do Dono) e o que só lê ou testa.
 */
const IGNORADAS = new Set([
  'conta.criar',
  'sessao.abrir',
  'sessao.encerrar',
  'sessao.encerrar_outras',
  'empresa.trocar_ativa',
  'email.confirmar',
  'senha.redefinir',
  'convite.aceitar',
  'resultados.ler_agora',
  'sandbox.gravar',
]);
const PREFIXOS_IGNORADOS = ['segundo_fator.', 'flag.'];
const DECIDEM = ['acao.', 'peca.', 'plano.', 'autonomia.'];

/** O grupo de uma ação da auditoria; `null` para a que fica fora do resumo. Toda ação sem grupo próprio é "outras". */
export function grupoDaAcao(acao: string): Grupo | null {
  if (IGNORADAS.has(acao) || PREFIXOS_IGNORADOS.some((p) => acao.startsWith(p))) return null;
  const [area = '', verbo = ''] = acao.split('.');
  if (DECIDEM.includes(`${area}.`) && (verbo === 'aprovar' || verbo === 'aprovar_varias')) return 'aprovou';
  if (DECIDEM.includes(`${area}.`) && verbo === 'recusar') return 'recusou';
  if (area === 'orcamento') return 'verba';
  if (area === 'convite' || area === 'acesso') return 'pessoas';
  if (area === 'conta' || area === 'conexao' || area === 'webhook') return 'contas';
  if (area === 'parada') return 'parada';
  if (area === 'cobranca') return 'cobranca';
  if (acao === 'dados.exportar') return 'exportou';
  if (area === 'empresa' || area === 'marca') return verbo === 'dossie_salvar' || verbo === 'dossie_voltar' || verbo.startsWith('sugestao_') ? 'outras' : 'conta';
  return 'outras';
}

const vezes = (n: number) => (n === 1 ? '1 vez' : `${n} vezes`);
const mudancas = (n: number) => (n === 1 ? '1 mudança' : `${n} mudanças`);
const pedidos = (n: number) => (n === 1 ? '1 pedido' : `${n} pedidos`);

/** As linhas de uma pessoa, a partir das contagens por grupo. Os grupos sem nada não aparecem. */
export function linhasDaPessoa(contagem: Partial<Record<Grupo, number>>): string[] {
  const c = (g: Grupo) => contagem[g] ?? 0;
  const linhas: string[] = [];
  if (c('aprovou') && c('recusou')) linhas.push(`aprovou ${pedidos(c('aprovou'))} e recusou ${c('recusou')}`);
  else if (c('aprovou')) linhas.push(`aprovou ${pedidos(c('aprovou'))}`);
  else if (c('recusou')) linhas.push(`recusou ${pedidos(c('recusou'))}`);
  if (c('verba')) linhas.push(`mudou a verba ${vezes(c('verba'))}`);
  if (c('pessoas')) linhas.push(`fez ${mudancas(c('pessoas'))} em Pessoas e acessos`);
  if (c('contas')) linhas.push(`fez ${mudancas(c('contas'))} em Contas conectadas`);
  if (c('parada')) linhas.push(`mexeu na parada de emergência ${vezes(c('parada'))}`);
  if (c('cobranca')) linhas.push(`fez ${mudancas(c('cobranca'))} em Plano e cobrança`);
  if (c('exportou')) linhas.push(`exportou os dados da empresa ${vezes(c('exportou'))}`);
  if (c('conta')) linhas.push(`fez ${mudancas(c('conta'))} nas marcas ou na conta da empresa`);
  if (c('outras')) {
    const n = c('outras');
    linhas.push(linhas.length ? `e mais ${n === 1 ? '1 ação' : `${n} ações`}` : `fez ${n === 1 ? '1 ação' : `${n} ações`} no Liame`);
  }
  return linhas;
}

export type PessoaDoResumo = {
  nome: string;
  /** O nível de agora; sem acesso, o último que a auditoria guardou (pode faltar). */
  nivel: string | null;
  /** O dia (no fuso da empresa) em que a pessoa perdeu o acesso, se perdeu. */
  semAcessoDesde: string | null;
  contagem: Partial<Record<Grupo, number>>;
};

const ddmm = (dia: string) => `${dia.slice(8, 10)}/${dia.slice(5, 7)}`;
const nomeDoNivel = (nivel: string | null) => (nivel && nivel in ROLE_LABEL ? ROLE_LABEL[nivel as keyof typeof ROLE_LABEL] : null);

/** O e-mail ao Dono, só texto. As pessoas vêm na ordem em que o e-mail as mostra. */
export function emailDoResumo(p: { dono: string; empresa: string; de: string; ate: string; pessoas: PessoaDoResumo[]; link: string }): { subject: string; text: string } {
  const primeiro = p.dono.trim().split(/\s+/)[0] ?? p.dono;
  const blocos = p.pessoas.map((x) => {
    const nivel = nomeDoNivel(x.nivel);
    const sobre = [nivel, x.semAcessoDesde ? `sem acesso desde ${ddmm(x.semAcessoDesde)}` : null].filter(Boolean).join(', ');
    return `${x.nome}${sobre ? ` (${sobre})` : ''}\n${linhasDaPessoa(x.contagem).map((l) => `- ${l}`).join(';\n')}.`;
  });
  const quem = p.pessoas.length === 1 ? 'esta pessoa mexeu' : 'estas pessoas mexeram';
  return {
    subject: `Liame: o que cada pessoa fez na ${p.empresa} (${ddmm(p.de)} a ${ddmm(p.ate)})`,
    text:
      `Olá, ${primeiro}.\n\n` +
      `Na semana de ${ddmm(p.de)} a ${ddmm(p.ate)}, além de você, ${quem} na conta da ${p.empresa}:\n\n` +
      `${blocos.join('\n\n')}\n\n` +
      'São só as contagens: o Liame guarda o registro de cada ação, com a hora e o que mudou.\n' +
      `Se alguma coisa não parece certa, tire o acesso da pessoa em Pessoas e acessos: ${p.link}\n\n` +
      'Você recebe este resumo às segundas-feiras, quando alguém além de você mexe na conta.\n',
  };
}
