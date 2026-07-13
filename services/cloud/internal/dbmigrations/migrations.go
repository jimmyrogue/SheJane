package dbmigrations

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

type Migration struct {
	Version  string
	Name     string
	Path     string
	Checksum string
	SQL      string
}

type AppliedMigration struct {
	Version  string
	Name     string
	Checksum string
}

type Store interface {
	Ensure(context.Context) error
	Applied(context.Context) (map[string]AppliedMigration, error)
	Apply(context.Context, Migration) error
}

func Discover(dir string) ([]Migration, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	migrations := make([]Migration, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".sql" {
			continue
		}
		version, name, ok := parseMigrationFilename(entry.Name())
		if !ok {
			return nil, fmt.Errorf("invalid migration filename %q: expected <version>_<name>.sql", entry.Name())
		}
		path := filepath.Join(dir, entry.Name())
		raw, err := os.ReadFile(path)
		if err != nil {
			return nil, err
		}
		sum := sha256.Sum256(raw)
		migrations = append(migrations, Migration{
			Version:  version,
			Name:     name,
			Path:     path,
			Checksum: hex.EncodeToString(sum[:]),
			SQL:      string(raw),
		})
	}
	sort.Slice(migrations, func(i, j int) bool {
		return migrations[i].Version < migrations[j].Version
	})
	return migrations, nil
}

func Run(ctx context.Context, store Store, migrations []Migration, log io.Writer) error {
	if err := store.Ensure(ctx); err != nil {
		return err
	}
	applied, err := store.Applied(ctx)
	if err != nil {
		return err
	}
	for _, migration := range migrations {
		existing, ok := applied[migration.Version]
		if ok {
			if existing.Checksum != migration.Checksum {
				return fmt.Errorf("migration %s checksum mismatch: database=%s file=%s", migration.Version, existing.Checksum, migration.Checksum)
			}
			writeLog(log, "skip %s_%s\n", migration.Version, migration.Name)
			continue
		}
		if err := store.Apply(ctx, migration); err != nil {
			return fmt.Errorf("apply %s_%s: %w", migration.Version, migration.Name, err)
		}
		applied[migration.Version] = AppliedMigration{
			Version:  migration.Version,
			Name:     migration.Name,
			Checksum: migration.Checksum,
		}
		writeLog(log, "applied %s_%s\n", migration.Version, migration.Name)
	}
	return nil
}

func parseMigrationFilename(filename string) (string, string, bool) {
	base := strings.TrimSuffix(filename, filepath.Ext(filename))
	version, name, ok := strings.Cut(base, "_")
	if !ok || version == "" || name == "" {
		return "", "", false
	}
	for _, r := range version {
		if r < '0' || r > '9' {
			return "", "", false
		}
	}
	return version, name, true
}

func writeLog(w io.Writer, format string, args ...any) {
	if w == nil {
		return
	}
	_, _ = fmt.Fprintf(w, format, args...)
}

type PostgresStore struct {
	db *sql.DB
}

func NewPostgresStore(db *sql.DB) *PostgresStore {
	return &PostgresStore{db: db}
}

func (s *PostgresStore) Ensure(ctx context.Context) error {
	if s == nil || s.db == nil {
		return errors.New("dbmigrations: nil database")
	}
	_, err := s.db.ExecContext(ctx, `
CREATE TABLE IF NOT EXISTS schema_migrations (
    version VARCHAR(32) PRIMARY KEY,
    name TEXT NOT NULL,
    checksum CHAR(64) NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`)
	return err
}

func (s *PostgresStore) Applied(ctx context.Context) (map[string]AppliedMigration, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT version, name, checksum FROM schema_migrations`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	applied := map[string]AppliedMigration{}
	for rows.Next() {
		var migration AppliedMigration
		if err := rows.Scan(&migration.Version, &migration.Name, &migration.Checksum); err != nil {
			return nil, err
		}
		applied[migration.Version] = migration
	}
	return applied, rows.Err()
}

func (s *PostgresStore) Apply(ctx context.Context, migration Migration) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() {
		_ = tx.Rollback()
	}()
	if _, err := tx.ExecContext(ctx, migration.SQL); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `
INSERT INTO schema_migrations (version, name, checksum)
VALUES ($1, $2, $3)
`, migration.Version, migration.Name, migration.Checksum); err != nil {
		return err
	}
	return tx.Commit()
}
