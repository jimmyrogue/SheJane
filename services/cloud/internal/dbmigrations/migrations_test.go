package dbmigrations

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDiscoverSortsAndChecksums(t *testing.T) {
	t.Setenv("TZ", "UTC")
	dir := t.TempDir()
	writeMigrationFile(t, dir, "002_second.sql", "SELECT 2;")
	writeMigrationFile(t, dir, "001_first.sql", "SELECT 1;")
	writeMigrationFile(t, dir, "README.md", "ignored")

	migrations, err := Discover(dir)
	if err != nil {
		t.Fatalf("Discover() error = %v", err)
	}
	if len(migrations) != 2 {
		t.Fatalf("len(migrations) = %d, want 2", len(migrations))
	}
	if migrations[0].Version != "001" || migrations[0].Name != "first" {
		t.Fatalf("first migration = %#v, want version 001 name first", migrations[0])
	}
	if migrations[1].Version != "002" || migrations[1].Name != "second" {
		t.Fatalf("second migration = %#v, want version 002 name second", migrations[1])
	}
	if migrations[0].Checksum == "" || migrations[0].Checksum == migrations[1].Checksum {
		t.Fatalf("checksums look wrong: %#v", migrations)
	}
}

func TestRunSkipsAppliedMigrations(t *testing.T) {
	store := &fakeStore{
		applied: map[string]AppliedMigration{
			"001": {Checksum: "checksum-1"},
		},
	}
	migrations := []Migration{
		{Version: "001", Name: "first", Checksum: "checksum-1", SQL: "SELECT 1;"},
		{Version: "002", Name: "second", Checksum: "checksum-2", SQL: "SELECT 2;"},
	}

	if err := Run(context.Background(), store, migrations, nil); err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	if !store.ensured {
		t.Fatal("Run() did not ensure the migration table")
	}
	if got := strings.Join(store.appliedOrder, ","); got != "002" {
		t.Fatalf("applied order = %q, want 002", got)
	}
}

func TestRunRejectsChecksumDrift(t *testing.T) {
	store := &fakeStore{
		applied: map[string]AppliedMigration{
			"001": {Checksum: "old-checksum"},
		},
	}
	migrations := []Migration{
		{Version: "001", Name: "first", Checksum: "new-checksum", SQL: "SELECT 1;"},
	}

	err := Run(context.Background(), store, migrations, nil)
	if err == nil {
		t.Fatal("Run() error = nil, want checksum drift error")
	}
	if !strings.Contains(err.Error(), "checksum mismatch") {
		t.Fatalf("Run() error = %q, want checksum mismatch", err)
	}
	if len(store.appliedOrder) != 0 {
		t.Fatalf("appliedOrder = %#v, want none", store.appliedOrder)
	}
}

func TestEmailVerificationMigrationDoesNotReverifyUsersWithTokens(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "migrations", "012_phase6_email_verification.sql"))
	if err != nil {
		t.Fatalf("read email verification migration: %v", err)
	}
	sql := string(raw)
	createTokenTable := strings.Index(sql, "CREATE TABLE IF NOT EXISTS email_verification_tokens")
	grandfatherUpdate := strings.Index(sql, "UPDATE users")
	if createTokenTable < 0 || grandfatherUpdate < 0 {
		t.Fatalf("migration missing token table or grandfather update:\n%s", sql)
	}
	if createTokenTable > grandfatherUpdate {
		t.Fatalf("email verification token table must be created before grandfather update")
	}
	for _, part := range []string{"NOT EXISTS", "email_verification_tokens.user_id = users.id"} {
		if !strings.Contains(sql, part) {
			t.Fatalf("grandfather update must exclude users with verification tokens; missing %q", part)
		}
	}
}

type fakeStore struct {
	ensured      bool
	applied      map[string]AppliedMigration
	appliedOrder []string
}

func (s *fakeStore) Ensure(context.Context) error {
	s.ensured = true
	return nil
}

func (s *fakeStore) Applied(context.Context) (map[string]AppliedMigration, error) {
	if s.applied == nil {
		return map[string]AppliedMigration{}, nil
	}
	return s.applied, nil
}

func (s *fakeStore) Apply(_ context.Context, migration Migration) error {
	s.appliedOrder = append(s.appliedOrder, migration.Version)
	if s.applied == nil {
		s.applied = map[string]AppliedMigration{}
	}
	s.applied[migration.Version] = AppliedMigration{Checksum: migration.Checksum}
	return nil
}

func writeMigrationFile(t *testing.T, dir string, name string, content string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o644); err != nil {
		t.Fatalf("write %s: %v", name, err)
	}
}
