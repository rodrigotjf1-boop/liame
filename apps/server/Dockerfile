# syntax=docker/dockerfile:1.7
# Imagem da API e do worker (o mesmo código, comandos diferentes; ADR-002). Contexto: raiz do repositório.
#   docker build -f apps/server/Dockerfile -t liame-server --build-arg APP_VERSION=$(git rev-parse --short HEAD) .
#   API:    docker run liame-server
#   worker: docker run liame-server node --enable-source-maps --import ./dist/telemetry.js dist/main.worker.js
#           (o worker responde /health no 127.0.0.1 do contêiner: o HEALTHCHECK abaixo vale para os dois)
#   migrations (release): docker run -e DATABASE_URL_OWNER=... liame-server node node_modules/@liame/database/dist/cli/migrate.js

# Base fixada por digest (Node 24.21.0, bookworm-slim, refeita em 06/10/2026): tag sozinha pode mudar por baixo.
FROM node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS build
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

FROM node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS runtime
# Correção de segurança do Debian que a imagem oficial do Node ainda não trouxe (07/10/2026): perl-base
# 5.36.0-7+deb12u4, com avisos críticos. Quem acusa é o Grype do CI. Quando a base fixada já vier com a versão
# corrigida, este passo não faz nada e pode sair (security-model.md §9).
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends --only-upgrade perl-base \
 && rm -rf /var/lib/apt/lists/*
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
