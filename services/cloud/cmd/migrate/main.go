package main

import (
	"context"
	"database/sql"
	"flag"
	"log"
	"os"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"

	"github.com/coldflame/shejane/api/internal/dbmigrations"
)

func main() {
	dir := flag.String("dir", defaultMigrationDir(), "directory containing *.sql migrations")
	flag.Parse()

	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		log.Fatal("DATABASE_URL is required")
	}

	migrations, err := dbmigrations.Discover(*dir)
	if err != nil {
		log.Fatal(err)
	}

	db, err := sql.Open("pgx", dsn)
	if err != nil {
		log.Fatal(err)
	}
	defer db.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	if err := db.PingContext(ctx); err != nil {
		log.Fatal(err)
	}
	if err := dbmigrations.Run(ctx, dbmigrations.NewPostgresStore(db), migrations, os.Stdout); err != nil {
		log.Fatal(err)
	}
}

func defaultMigrationDir() string {
	if value := os.Getenv("MIGRATIONS_DIR"); value != "" {
		return value
	}
	return "/app/migrations"
}
