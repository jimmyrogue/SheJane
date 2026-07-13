FROM --platform=$BUILDPLATFORM node:22-alpine AS build

WORKDIR /src
ARG VITE_API_BASE_URL=http://localhost:8080
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY client/package.json client/package.json
COPY admin/package.json admin/package.json
COPY tests/e2e/package.json tests/e2e/package.json
RUN corepack enable && pnpm install --filter shejane-client... --frozen-lockfile
COPY client client
WORKDIR /src/client
RUN pnpm build

FROM nginx:1.30-alpine
RUN apk upgrade --no-cache
COPY --from=build /src/client/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
