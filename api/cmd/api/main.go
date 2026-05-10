package main

import (
	"context"
	"log"
	"net/http"

	"github.com/coldflame/jiandanly/api/internal/app"
	"github.com/coldflame/jiandanly/api/internal/config"
	"github.com/coldflame/jiandanly/api/internal/httpapi"
	"github.com/coldflame/jiandanly/api/internal/store"
)

func main() {
	cfg := config.Load()
	var st store.Store = store.NewMemoryStore()
	if cfg.DatabaseURL != "" {
		postgresStore, err := store.NewPostgresStore(context.Background(), cfg.DatabaseURL)
		if err != nil {
			log.Fatal(err)
		}
		st = postgresStore
	}
	application := app.New(cfg, st)
	server := httpapi.NewServer(application)

	log.Printf("Jiandanly API listening on %s", cfg.HTTPAddr)
	if err := http.ListenAndServe(cfg.HTTPAddr, server); err != nil {
		log.Fatal(err)
	}
}
