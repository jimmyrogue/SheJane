FROM golang:1.25-alpine3.22 AS build

WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN go build -o /out/shejane-api ./cmd/api
RUN go build -o /out/shejane-migrate ./cmd/migrate

FROM alpine:3.22
# poppler-utils → pdftotext + pdfinfo, used by
#   • documents.ExtractText / ExtractMetadata at upload time
#     (Layer A — text + metadata extraction), and
#   • the pdf.inspect gateway's "info" operation (Layer B).
# pdfgrep → the pdf.inspect gateway's "search" operation. It is a
# SEPARATE package from poppler-utils (lives in Alpine's community
# repo), so it must be listed explicitly — poppler-utils alone does
# NOT provide it.
# Both are best-effort: ExtractText falls back to the Go-native pdf
# library when pdftotext is missing, and pdf.inspect returns a
# clean tool-error envelope if a binary is absent — so a build
# without these only degrades features, never crashes.
RUN apk upgrade --no-cache && apk add --no-cache poppler-utils pdfgrep
RUN adduser -D -H shejane
USER shejane
WORKDIR /app
COPY --from=build /out/shejane-api /app/shejane-api
COPY --from=build /out/shejane-migrate /app/shejane-migrate
COPY --from=build /src/migrations /app/migrations
EXPOSE 8080
CMD ["/app/shejane-api"]
