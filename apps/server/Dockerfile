# syntax=docker/dockerfile:1.7
# Imagem da API e do worker (o mesmo código, comandos diferentes; ADR-002). Contexto: raiz do repositório.
#   docker build -f apps/server/Dockerfile -t liame-server --build-arg APP_VERSION=$(git rev-parse --short HEAD) .
#   API:    docker run liame-server
#   worker: docker run liame-server node --enable-source-maps --import ./dist/telemetry.js dist/main.worker.js
#           (o worker responde /health no 127.0.0.1 do contêiner: o HEALTHCHECK abaixo vale para os dois)
#   migrations (release): docker run -e DATABASE_URL_OWNER=... liame-server node node_modules/@liame/database/dist/cli/migrate.js

# Base fixada por digest: Node 24.22.1, bookworm-slim, de 21/10/2026 (o boletim de segurança do Node de 21/10/2026:
# a falha do Brotli, CVE-2026-111497, e as chaves da eMudhra). Tag sozinha pode mudar por baixo, e o digest não se
# atualiza sozinho: a versão é a mesma do `.nvmrc`, e o job `imagem` do CI confere (base-conhecimento §15.1).
FROM node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS build
ENV CI=true TURBO_TELEMETRY_DISABLED=1 NEXT_TELEMETRY_DISABLED=1
# pnpm 12 é nativo: o script de instalação DELE troca o marcador pelo binário da plataforma (ERR-017).
# Os scripts das dependências do projeto continuam desligados (V9, LIC-079).
RUN npm install --global pnpm@12.6.0
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile --ignore-scripts
RUN pnpm turbo run build --filter=@liame/server...
# Só o necessário para rodar: dependências de produção + os pacotes do workspace já compilados.
RUN pnpm --filter @liame/server deploy --prod /out \
 && rm -rf /out/src /out/test /out/tsconfig.json /out/tsconfig.build.json /out/nest-cli.json

FROM node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS runtime
# A base de 21/10/2026 já traz o perl-base 5.36.0-7+deb12u4, a correção que este estágio subia à mão desde 07/10/2026
# (a mais nova do bookworm em 23/10/2026): o passo saiu, como o security-model.md §9 pede.
# Versão no /health: o EasyPanel passa GIT_SHA como argumento de build; APP_VERSION explícito vence.
ARG GIT_SHA=dev
ARG APP_VERSION=${GIT_SHA}
ENV NODE_ENV=production APP_VERSION=${APP_VERSION} PORT=3001
WORKDIR /app
COPY --from=build --chown=node:node /out ./
# Certificado raiz do Supabase (público): as URLs do banco usam sslmode=verify-full&sslrootcert=/app/certs/supabase-ca.crt.
COPY --chown=node:node infra/supabase/prod-ca-2021.crt ./certs/supabase-ca.crt
# Sem root em tempo de execução.
USER node
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "--enable-source-maps", "--import", "./dist/telemetry.js", "dist/main.api.js"]
