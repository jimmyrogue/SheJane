FROM --platform=$BUILDPLATFORM node:22-alpine AS build

WORKDIR /src
ARG VITE_API_BASE_URL=http://localhost:8080
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/desktop/package.json apps/desktop/package.json
COPY apps/admin/package.json apps/admin/package.json
COPY packages/runtime-client/package.json packages/runtime-client/package.json
COPY tests/e2e/package.json tests/e2e/package.json
RUN corepack enable && pnpm install --filter shejane-client... --frozen-lockfile
COPY apps/desktop apps/desktop
COPY packages/runtime-client packages/runtime-client
WORKDIR /src/apps/desktop
RUN pnpm build

FROM nginx:1.30-alpine
RUN apk upgrade --no-cache
COPY --from=build /src/apps/desktop/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
