-- 0132 · A loja no mapa (plano da região, R1; `docs/plano-regiao.md`, aprovado pelo dono em 11/11/2026 com as decisões
-- D-RG-1 a D-RG-10 como recomendadas; base de conhecimento §19). Cada loja do Liame passa a guardar onde fica: o
-- endereço (CEP, rua, número, bairro, município e UF), o código IBGE do município (a chave das fontes públicas da
-- região, §19.1), a coordenada com a precisão dela (achada pelo endereço, pelo bairro ou pela cidade, no
-- OpenStreetMap) e de onde o endereço veio (o Perfil da Empresa no Google ou o CEP digitado), o raio de entrega e as
-- áreas de entrega (até 20, como o Perfil do Google dá). É dado da EMPRESA (D-RG-2): fica na loja e nunca vai para o
-- modelo de IA (D-A3-4); quem salva e quando ficam na loja e na auditoria.
-- (1) A função `regiao`, desligada (a loja no mapa e, depois, o raio-x da região; só leitura de fontes públicas).
-- (2) As colunas novas em `unit`, todas opcionais (a loja sem endereço continua valendo), com as regras de cada uma.
-- Da distribuição (a função) e das empresas (as colunas, na tabela que já tem RLS). Idempotente, sem `drop`: as regras
-- que juntam colunas entram só se ainda não existem. Uma transação por arquivo (ADR-018).

-- A semente grava em tabela com RLS forçada (V20).
select set_config('app.scope', 'sistema', true);

-- ------------------------------------------------------------ (1) a função

insert into liame.feature_flag (key, kind, default_value, description, owner, is_write)
values ('regiao', 'boolean', 'false', 'Região: a loja no mapa (endereço, coordenada e raio de entrega) e o raio-x da região pelas fontes públicas (plano da região, R1 e R2). Só leitura de fontes públicas; nada é escrito em plataforma', 'midia', false)
on conflict (key) do nothing;

-- ------------------------------------------------------------ (2) as colunas da loja

alter table liame.unit add column if not exists address_postal_code text check (address_postal_code ~ '^[0-9]{8}$');
alter table liame.unit add column if not exists address_street text check (length(btrim(address_street)) between 1 and 200);
alter table liame.unit add column if not exists address_number text check (length(btrim(address_number)) between 1 and 20);
alter table liame.unit add column if not exists address_district text check (length(btrim(address_district)) between 1 and 120);
alter table liame.unit add column if not exists address_city text check (length(btrim(address_city)) between 1 and 120);
alter table liame.unit add column if not exists address_state text check (address_state ~ '^[A-Z]{2}$');
-- O código IBGE do município (7 dígitos), pelo CEP: é por ele que as fontes da região são lidas.
alter table liame.unit add column if not exists ibge_city_code text check (ibge_city_code ~ '^[0-9]{7}$');
-- A coordenada (graus, 6 casas: cerca de 10 cm) e a precisão: `endereco`, `bairro` ou `cidade`.
alter table liame.unit add column if not exists latitude numeric(9, 6) check (latitude between -34 and 6);
alter table liame.unit add column if not exists longitude numeric(9, 6) check (longitude between -75 and -28);
alter table liame.unit add column if not exists location_precision text check (location_precision in ('endereco', 'bairro', 'cidade'));
-- De onde veio o endereço: `perfil_google` ou `cep` (digitado pela pessoa e completado pelo CEP).
alter table liame.unit add column if not exists location_source text check (location_source in ('perfil_google', 'cep'));
-- O raio de entrega, em km, de 1 a 15, de meio em meio.
alter table liame.unit add column if not exists delivery_radius_km numeric(3, 1) check (delivery_radius_km between 1 and 15 and delivery_radius_km * 2 = trunc(delivery_radius_km * 2));
-- As áreas de entrega (nomes de bairros ou lugares), até 20.
alter table liame.unit add column if not exists delivery_areas jsonb not null default '[]'::jsonb
  check (jsonb_typeof(delivery_areas) = 'array' and jsonb_array_length(delivery_areas) <= 20);
alter table liame.unit add column if not exists location_set_at timestamptz;
alter table liame.unit add column if not exists location_set_by uuid references liame.app_user (id) on delete set null;

do $$ begin
  -- A coordenada vai inteira, com a precisão.
  if not exists (select 1 from pg_constraint where conrelid = 'liame.unit'::regclass and conname = 'unit_coordenada_inteira') then
    alter table liame.unit add constraint unit_coordenada_inteira
      check ((latitude is null) = (longitude is null) and (latitude is null) = (location_precision is null));
  end if;
  -- Com o CEP, vêm o município, a UF, o código IBGE e a origem; sem ele, nada do endereço.
  if not exists (select 1 from pg_constraint where conrelid = 'liame.unit'::regclass and conname = 'unit_endereco_inteiro') then
    alter table liame.unit add constraint unit_endereco_inteiro
      check (
        case when address_postal_code is null
          then address_street is null and address_number is null and address_district is null and address_city is null
               and address_state is null and ibge_city_code is null and location_source is null and latitude is null
          else address_city is not null and address_state is not null and ibge_city_code is not null and location_source is not null
        end);
  end if;
end $$;

-- ------------------------------------------------------------ conferência

do $$ begin
  if not exists (select 1 from liame.feature_flag where key = 'regiao' and default_value = 'false'::jsonb and not is_write) then
    raise exception '0132: a função regiao não entrou desligada';
  end if;
  if (select count(*) from information_schema.columns
       where table_schema = 'liame' and table_name = 'unit'
         and column_name in ('address_postal_code', 'address_street', 'address_number', 'address_district', 'address_city', 'address_state',
                             'ibge_city_code', 'latitude', 'longitude', 'location_precision', 'location_source', 'delivery_radius_km',
                             'delivery_areas', 'location_set_at', 'location_set_by')) <> 15 then
    raise exception '0132: as colunas da loja no mapa não entraram';
  end if;
  if (select count(*) from pg_constraint where conrelid = 'liame.unit'::regclass and conname in ('unit_coordenada_inteira', 'unit_endereco_inteiro')) <> 2 then
    raise exception '0132: as regras da loja no mapa não entraram';
  end if;
end $$;
