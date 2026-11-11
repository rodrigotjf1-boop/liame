-- 0135 · O complemento do endereço da loja (plano da região, R1, parte 2; protótipo P40, aprovado pelo dono em
-- 11/11/2026 com as decisões D-RG-11 a D-RG-20). A gaveta "pôr a loja no mapa" pede, além do número, o complemento
-- (opcional: "Loja 2", "fundos"), que ajuda quem confere o ponto e diferencia duas lojas no mesmo número. É dado da
-- EMPRESA, como o resto do endereço (D-RG-2): fica na loja e nunca vai para o modelo de IA (D-A3-4).
-- Uma coluna opcional em `unit` (a tabela já tem RLS), com a regra de tamanho e a que só a aceita junto do endereço.
-- Idempotente, sem `drop`: a regra que junta colunas entra só se ainda não existe. Uma transação por arquivo (ADR-018).

alter table liame.unit add column if not exists address_complement text check (length(btrim(address_complement)) between 1 and 60);

do $$ begin
  -- O complemento só existe com o endereço (o CEP).
  if not exists (select 1 from pg_constraint where conrelid = 'liame.unit'::regclass and conname = 'unit_complemento_com_endereco') then
    alter table liame.unit add constraint unit_complemento_com_endereco
      check (address_complement is null or address_postal_code is not null);
  end if;
end $$;

-- ------------------------------------------------------------ conferência

do $$ begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'liame' and table_name = 'unit' and column_name = 'address_complement') then
    raise exception '0135: a coluna do complemento não entrou';
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'liame.unit'::regclass and conname = 'unit_complemento_com_endereco') then
    raise exception '0135: a regra do complemento não entrou';
  end if;
end $$;
