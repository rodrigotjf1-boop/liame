import type { DirectAiSuggestionRequest, DirectAiSuggestionResponse } from '@liame/contracts';
import type { Database } from '@liame/database';
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { AiGateway } from '../ai/gateway.js';
import { naTransacaoDaEmpresa } from '../ai/na-empresa.js';
import { funcionarioAtivo } from '../ai/registro/ativacao.js';
import type { MensagemDaConversa } from '../ai/social/direct.js';
import { SOCIAL } from '../ai/social/prompt.js';
import { type AuthContext, currentTx } from '../context/request-context.js';
import { marcaDoCriativo } from '../criativo/base.js';
import { DATABASE } from '../database/database.module.js';
import { AppProblem } from '../errors/problems.js';
import { DirectService } from './direct.service.js';
import { sugestaoDoSocialNoDirect } from './sugestao-do-social.js';

// A sugestão do Social media numa conversa do Direct ou do Messenger, a pedido de quem atende (A6, Z12, parte 4b-2; P39;
// D-A6-110 e D-A6-145). A pessoa da equipe abre a conversa que espera resposta e pede ("Pedir ao Social media"); o
// Liame lê a conversa como a tela a mostra (as mesmas regras de quem vê), manda ao modelo as dez últimas mensagens sem o
// nome nem o @ de ninguém, confere cada sugestão e devolve só as que passam (`sugestao-do-social.ts`, o mesmo pedido do
// atendimento automático da pergunta). Nada é guardado: a sugestão vive na tela de quem pediu, e a resposta só sai quando
// a pessoa manda (parte 2, com o atendimento aberto). Sem a rota do modelo (ela só entra depois do eval pago e do item da
// Política 7), a rota responde `sem_ia`, e nenhuma mensagem vai a modelo.

type Quem = { tenantId: string; userId: string };

@Injectable()
export class DirectSuggestionService {
  constructor(
    @Inject(DATABASE) private readonly database: Database | null,
    private readonly direct: DirectService,
    private readonly gateway: AiGateway,
  ) {}

  private quem(auth: AuthContext): Quem {
    if (!auth.tenantId) throw new AppProblem(403, 'sem-empresa-ativa', 'Escolha uma empresa', 'Selecione uma empresa com acesso ativo.');
    return { tenantId: auth.tenantId, userId: auth.userId };
  }

  async sugerir(auth: AuthContext, conversationId: string, body: DirectAiSuggestionRequest, agora = new Date()): Promise<DirectAiSuggestionResponse> {
    const quem = this.quem(auth);
    if (!this.database) throw new AppProblem(503, 'sem-banco', 'Indisponível', 'Tente de novo em instantes.');
    const database = this.database;

    // A conversa como a tela a lê (quem vê o Direct da marca, o canal ligado, o Regem sem atender a conta), a marca e o
    // Social media na marca, numa transação curta.
    const lido = await naTransacaoDaEmpresa(database, quem, async () => {
      const tx = currentTx();
      const c = await this.direct.conversa(auth, body.brand_id, conversationId, agora);
      if (c.conversation.status !== 'espera') {
        throw new AppProblem(409, 'conversa-nao-espera', 'A conversa não espera resposta', 'O Social media só sugere resposta para a conversa que espera resposta, dentro da janela da Meta.');
      }
      const ativo = await funcionarioAtivo(tx, { tenantId: quem.tenantId, brandId: body.brand_id, agentKey: SOCIAL.key, ativoPorPadrao: SOCIAL.ativoPorPadrao });
      const fuso = (await tx.execute<{ timezone: string | null }>(sql`select timezone from liame.organization where id = ${quem.tenantId}`)).rows[0]?.timezone ?? 'America/Sao_Paulo';
      const nome = (await tx.execute<{ name: string }>(sql`select name from liame.brand where id = ${body.brand_id}`)).rows[0]!.name;
      return { conversa: c, ativo, nome, marca: await marcaDoCriativo(body.brand_id, fuso, agora) };
    });

    // O que vai ao modelo: quem (a pessoa ou a marca), o tipo e o texto de cada mensagem. O nome e o @ ficam aqui.
    const mensagens: MensagemDaConversa[] = lido.conversa.messages.map((m) => ({ de: m.direction === 'saida' ? 'marca' : 'pessoa', tipo: m.kind, texto: m.text }));
    const c = lido.conversa.conversation;
    const r = await sugestaoDoSocialNoDirect(
      { database, gateway: this.gateway },
      quem,
      body.brand_id,
      {
        tipo: c.kind,
        ativo: lido.ativo,
        nome: lido.nome,
        marca: lido.marca,
        canal: c.channel === 'messenger' ? 'messenger' : 'instagram',
        mensagens,
        quemEscreveu: c.username ?? c.name,
      },
      body.previous.map((a) => ({ enfoque: a.focus, texto: a.text })),
    );
    return r.resposta;
  }
}
