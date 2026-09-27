-- 0016 · Qual versão dos Termos de Uso e da Política de Privacidade a pessoa aceitou ao criar o login
-- (cadastro ou convite), e quando. A versão vigente vem da configuração (TERMS_VERSION); em produção
-- ela é obrigatória, então ninguém aceita termos que não foram publicados (A0-6).
-- Idempotente; uma transação por arquivo (ADR-018).

alter table liame.app_user add column if not exists terms_version text check (char_length(terms_version) between 1 and 60);
alter table liame.app_user add column if not exists terms_accepted_at timestamptz;
