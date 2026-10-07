# syntax=docker/dockerfile:1.7
# Imagem do webapp (Next 16, saída standalone). Contexto: raiz do repositório.
#   docker build -f apps/web/Dockerfile -t liame-web --build-arg NEXT_PUBLIC_API_URL=https://api.exemplo .

# Base fixada por digest (a mesma do servidor: Node 24.21.0, bookworm-slim, refeita em 06/10/2026).
FROM node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS build
ENV CI=true TURBO_TELEMETRY_DISABLED=1 NEXT_TELEMETRY_DISABLED=1
# pnpm 12 é nativo: o script de instalação DELE troca o marcador pelo binário da plataforma (ERR-017).
# Os scripts das dependências do projeto continuam desligados (V9, LIC-079).
RUN npm install --global pnpm@12.6.0
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile --ignore-scripts
# Endereço público da API, fixado no build (o navegador fala direto com ela; docs/configuracao.md).
ARG NEXT_PUBLIC_API_URL=
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}
RUN pnpm turbo run build --filter=@liame/web...

FROM node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS runtime
# Correção de segurança do Debian que a imagem oficial do Node ainda não trouxe (07/10/2026): perl-base
# 5.36.0-7+deb12u4, com avisos críticos. Quem acusa é o Grype do CI. Quando a base fixada já vier com a versão
# corrigida, este passo não faz nada e pode sair (security-model.md §9).
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends --only-upgrade perl-base \
 && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /app
# O standalone traz o servidor e só as dependências rastreadas; estáticos e public vão ao lado.
COPY --from=build --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static
# public/ não vai no standalone: a LIA 3D (public/lia, montado no build) é servida daqui.
COPY --from=build --chown=node:node /repo/apps/web/public ./apps/web/public
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
