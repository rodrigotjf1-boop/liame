import { type Database, type Tx, withSystem } from '@liame/database';
import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import {
  conferirRegistro,
  conteudoDoFuncionario,
  hashDaFerramenta,
  hashDoFuncionario,
  hashDoPrompt,
  type Registro,
  registroAtual,
  schemaDaFerramenta,
} from '../ai/registro/definicoes.js';
import { DATABASE } from '../database/database.module.js';

export interface ResultadoDoRegistro {
  /** `tabela:nome@versão` de cada versão que entrou agora. */
  novas: string[];
  /** Mesma versão com conteúdo diferente do que já foi ao ar: nada é sobrescrito. */
  conflitos: string[];
}

type Tabela = 'tool_registry' | 'prompt_version' | 'agent_definition';
type Item = { tabela: Tabela; coluna: 'name' | 'key'; nome: string; versao: number; hash: string; inserir: (tx: Tx, status: 'ativa' | 'aposentada') => Promise<void> };

/**
 * Grava no banco cada versão de ferramenta, prompt e funcionário que este código traz (A3, I2). A
 * definição vive no código; o registro guarda o que foi ao ar e quando, para reproduzir depois o que
 * valia em cada resposta. Roda na subida do worker, em escopo de sistema; pode rodar em várias réplicas
 * ao mesmo tempo (a chave primária decide quem grava).
 */
@Injectable()
export class RegistroIaService implements OnApplicationBootstrap {
  private readonly logger = new Logger('registro-ia');

  constructor(@Inject(DATABASE) private readonly database: Database | null) {}

  /** Falha aqui não derruba o worker: o registro é memória do que foi ao ar, não pré-requisito das filas. */
  async onApplicationBootstrap(): Promise<void> {
    try {
      const r = await this.registrar();
      if (r.novas.length) this.logger.log(`versões novas no registro: ${r.novas.join(', ')}`);
    } catch (err) {
      this.logger.error(`registro da IA falhou: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async registrar(registro: Registro = registroAtual()): Promise<ResultadoDoRegistro> {
    const resultado: ResultadoDoRegistro = { novas: [], conflitos: [] };
    if (!this.database) return resultado;
    const problemas = conferirRegistro(registro);
    if (problemas.length) throw new Error(`registro inconsistente: ${problemas.join('; ')}`);

    const itens: Item[] = [
      ...registro.ferramentas.map((f): Item => ({
        tabela: 'tool_registry',
        coluna: 'name',
        nome: f.name,
        versao: f.version,
        hash: hashDaFerramenta(f),
        inserir: async (tx, status) => {
          await tx.execute(sql`
            insert into liame.tool_registry (name, version, status, risk, permission, description, input_schema, owner, content_hash, retired_at)
            values (${f.name}, ${f.version}, ${status}, ${f.risk}, ${f.permission}, ${f.description}, ${JSON.stringify(schemaDaFerramenta(f))}::jsonb, ${f.owner},
                    ${hashDaFerramenta(f)}, ${status === 'aposentada' ? sql`now()` : null})
            on conflict (name, version) do nothing`);
        },
      })),
      ...registro.prompts.map((p): Item => ({
        tabela: 'prompt_version',
        coluna: 'key',
        nome: p.key,
        versao: p.version,
        hash: hashDoPrompt(p),
        inserir: async (tx, status) => {
          await tx.execute(sql`
            insert into liame.prompt_version (key, version, status, task, content, content_hash, retired_at)
            values (${p.key}, ${p.version}, ${status}, ${p.task}, ${p.content}, ${hashDoPrompt(p)}, ${status === 'aposentada' ? sql`now()` : null})
            on conflict (key, version) do nothing`);
        },
      })),
      ...registro.funcionarios.map((f): Item => ({
        tabela: 'agent_definition',
        coluna: 'key',
        nome: f.key,
        versao: f.version,
        hash: hashDoFuncionario(f),
        inserir: async (tx, status) => {
          await tx.execute(sql`
            insert into liame.agent_definition (key, version, status, name, definition, content_hash, retired_at)
            values (${f.key}, ${f.version}, ${status}, ${f.name}, ${JSON.stringify(conteudoDoFuncionario(f))}::jsonb, ${hashDoFuncionario(f)},
                    ${status === 'aposentada' ? sql`now()` : null})
            on conflict (key, version) do nothing`);
        },
      })),
    ];

    for (const item of itens) {
      const etiqueta = `${item.tabela}:${item.nome}@${item.versao}`;
      const tabela = sql.raw(`liame.${item.tabela}`);
      const coluna = sql.raw(item.coluna);
      await withSystem(this.database.db, async (tx) => {
        // A linha ativa do nome fica travada: duas réplicas subindo juntas gravam uma de cada vez.
        const linhas = await tx.execute<{ version: number; content_hash: string; status: string }>(sql`
          select version, content_hash, status from ${tabela} where ${coluna} = ${item.nome} order by version for update`);
        const igual = linhas.rows.find((l) => l.version === item.versao);
        if (igual) {
          if (igual.content_hash !== item.hash) {
            resultado.conflitos.push(etiqueta);
            this.logger.error(`${etiqueta}: o conteúdo é diferente do que já foi ao ar com esta versão; suba a versão (nada foi sobrescrito)`);
          }
          return;
        }
        // Código antigo subindo depois de um mais novo (troca de versão em andamento): entra como histórico.
        const maisNova = linhas.rows.some((l) => l.version > item.versao);
        if (!maisNova) {
          // Só as versões ANTERIORES: se outra réplica acabou de gravar esta mesma versão, ela não pode ser aposentada aqui.
          await tx.execute(sql`
            update ${tabela} set status = 'aposentada', retired_at = now()
             where ${coluna} = ${item.nome} and status = 'ativa' and version < ${item.versao}`);
        }
        await item.inserir(tx, maisNova ? 'aposentada' : 'ativa');
        resultado.novas.push(etiqueta);
      });
    }
    return resultado;
  }
}
