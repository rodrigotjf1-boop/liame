-- 0043 · Revisor de IA do Compliance (A3, I9; D-A3-16 e D-A3-17).
-- Depois das regras de texto do código, um revisor de IA confere o tom, a clareza e as alegações de todo texto que a IA
-- escreve (explicação, leitura da revisão, resposta da conversa e plano). Se aponta problema, o texto não aparece e a
-- tela mostra o que o sistema escreve; o caso entra em `ai_refusal` com `kind = 'revisor'` e a categoria, sem o texto
-- (a tabela e o tipo já existem desde a 0040).
-- Nasce desligado para todos: a distribuição liga por empresa (comando `ligar-flag`), depois de publicar a rota de
-- modelo da tarefa `compliance_revisao`. Ligada, o portão é obrigatório: sem o revisor, o texto da IA não aparece.
-- Idempotente; uma transação por arquivo (ADR-018).

-- A semente da flag grava em tabela com RLS forçada (V20).
select set_config('app.scope', 'sistema', true);

insert into liame.feature_flag (key, kind, default_value, description, owner, is_write)
values ('revisor', 'boolean', 'false', 'Revisor de IA do Compliance: depois das regras de texto, confere tom, clareza e alegações de todo texto de IA antes de ele aparecer (A3, I9)', 'ia', false)
on conflict (key) do nothing;
