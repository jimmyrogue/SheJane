FROM golang:1.25-alpine AS build

WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN go build -o /out/jiandanly-api ./cmd/api

FROM alpine:3.21
RUN adduser -D -H jiandan
USER jiandan
WORKDIR /app
COPY --from=build /out/jiandanly-api /app/jiandanly-api
EXPOSE 8080
CMD ["/app/jiandanly-api"]
