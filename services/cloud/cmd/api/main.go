package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os/signal"
	"syscall"
	"time"

	"github.com/getsentry/sentry-go"
	sentryhttp "github.com/getsentry/sentry-go/http"

	"github.com/coldflame/shejane/api/internal/app"
	"github.com/coldflame/shejane/api/internal/config"
	"github.com/coldflame/shejane/api/internal/httpapi"
	"github.com/coldflame/shejane/api/internal/store"
)

func main() {
	cfg, err := config.LoadStrict()
	if err != nil {
		log.Fatal(err)
	}

	// Error tracking + performance tracing. Disabled (no-op) when SENTRY_DSN
	// is unset, so dev/CI are unaffected.
	if cfg.SentryDSN != "" {
		if err := sentry.Init(sentry.ClientOptions{
			Dsn:              cfg.SentryDSN,
			Environment:      cfg.SentryEnvironment,
			EnableTracing:    cfg.SentryTracesSampleRate > 0,
			TracesSampleRate: cfg.SentryTracesSampleRate,
		}); err != nil {
			log.Printf("sentry init failed (continuing without it): %v", err)
		} else {
			defer sentry.Flush(2 * time.Second)
			log.Printf("Sentry enabled (env=%s, traces=%.2f)", cfg.SentryEnvironment, cfg.SentryTracesSampleRate)
		}
	}

	var st store.Store = store.NewMemoryStore()
	if cfg.DatabaseURL != "" {
		postgresStore, err := store.NewPostgresStore(context.Background(), cfg.DatabaseURL)
		if err != nil {
			log.Fatal(err)
		}
		st = postgresStore
	}
	application := app.New(cfg, st)

	var handler http.Handler = httpapi.NewServer(application)
	if cfg.SentryDSN != "" {
		// Outer wrapper: gives each request a Sentry hub + a performance
		// transaction. Repanic so our own recovery middleware still writes
		// the 500 + captures the exception.
		handler = sentryhttp.New(sentryhttp.Options{Repanic: true}).Handle(handler)
	}

	server := newHTTPServer(cfg, handler)
	errCh := make(chan error, 1)
	go func() {
		log.Printf("SheJane API listening on %s", cfg.HTTPAddr)
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- err
			return
		}
		errCh <- nil
	}()

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	select {
	case err := <-errCh:
		if err != nil {
			log.Fatal(err)
		}
	case <-ctx.Done():
		log.Printf("SheJane API shutting down")
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := server.Shutdown(shutdownCtx); err != nil {
			log.Fatal(err)
		}
		if err := <-errCh; err != nil {
			log.Fatal(err)
		}
	}
}

func newHTTPServer(cfg config.Config, handler http.Handler) *http.Server {
	return &http.Server{
		Addr:              cfg.HTTPAddr,
		Handler:           handler,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       30 * time.Second,
		IdleTimeout:       120 * time.Second,
	}
}
