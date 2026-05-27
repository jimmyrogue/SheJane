FROM golang:1.25-alpine AS build

WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN go build -o /out/jiandanly-api ./cmd/api

FROM alpine:3.21
# poppler-utils provides pdftotext + pdfinfo, used by
# documents.ExtractText to pull text + metadata out of uploaded
# PDFs. The Go-native library we used previously (ledongthuc/pdf)
# misses layout, custom fonts, and has no metadata surface;
# Poppler is the industry standard. Extractor falls back to the
# Go library if pdftotext is missing, so this install only changes
# quality — the system still works without it.
RUN apk add --no-cache poppler-utils
RUN adduser -D -H jiandan
USER jiandan
WORKDIR /app
COPY --from=build /out/jiandanly-api /app/jiandanly-api
EXPOSE 8080
CMD ["/app/jiandanly-api"]
