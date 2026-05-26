package documents

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// fakeMetadataStore is a minimal in-test stand-in for store.MemoryStore
// to avoid the `store → documents` import cycle. Only the methods the
// service actually calls during a reap loop are implemented; the
// others panic so a future call site without a real fixture fails
// loudly instead of silently returning zero values.
type fakeMetadataStore struct {
	mu        sync.Mutex
	documents map[string]Document
	// deleteErr, if set for a docID, makes DeleteDocument return that
	// error for that doc once (then it clears) — used to assert the
	// reaper continues the batch on a DB hiccup.
	deleteErr map[string]error
}

func newFakeMetadataStore() *fakeMetadataStore {
	return &fakeMetadataStore{
		documents: make(map[string]Document),
		deleteErr: make(map[string]error),
	}
}

func (f *fakeMetadataStore) seed(doc Document) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.documents[doc.ID] = doc
}

func (f *fakeMetadataStore) snapshot() map[string]Document {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make(map[string]Document, len(f.documents))
	for k, v := range f.documents {
		out[k] = v
	}
	return out
}

func (f *fakeMetadataStore) CreateDocument(ctx context.Context, document Document) (Document, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.documents[document.ID] = document
	return document, nil
}

func (f *fakeMetadataStore) DocumentsByUser(ctx context.Context, userID string) ([]Document, error) {
	panic("not implemented in tests")
}

func (f *fakeMetadataStore) DocumentByID(ctx context.Context, userID string, documentID string) (Document, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	doc, ok := f.documents[documentID]
	if !ok || doc.UserID != userID {
		return Document{}, fmt.Errorf("not found: %s", documentID)
	}
	return doc, nil
}

func (f *fakeMetadataStore) MarkDocumentProcessing(ctx context.Context, userID string, documentID string) (Document, error) {
	panic("not implemented in tests")
}

func (f *fakeMetadataStore) MarkDocumentReady(ctx context.Context, userID string, documentID string, textObjectKey string) (Document, error) {
	panic("not implemented in tests")
}

func (f *fakeMetadataStore) MarkDocumentFailed(ctx context.Context, userID string, documentID string, errorMessage string) (Document, error) {
	panic("not implemented in tests")
}

func (f *fakeMetadataStore) DeleteDocument(ctx context.Context, userID string, documentID string) (Document, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if err, ok := f.deleteErr[documentID]; ok {
		delete(f.deleteErr, documentID)
		return Document{}, err
	}
	doc, ok := f.documents[documentID]
	if !ok || doc.UserID != userID {
		return Document{}, fmt.Errorf("not found: %s", documentID)
	}
	doc.Status = StatusDeleted
	doc.UpdatedAt = time.Now().UTC()
	f.documents[documentID] = doc
	return doc, nil
}

func (f *fakeMetadataStore) ListExpiredDocuments(ctx context.Context, cutoff time.Time, limit int) ([]Document, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if limit <= 0 {
		limit = 100
	}
	out := make([]Document, 0)
	for _, doc := range f.documents {
		if doc.Status == StatusDeleted {
			continue
		}
		if doc.ExpiresAt.IsZero() || !doc.ExpiresAt.Before(cutoff) {
			continue
		}
		out = append(out, doc)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt.Before(out[j].CreatedAt) })
	if len(out) > limit {
		out = out[:limit]
	}
	return out, nil
}

// failingObjectStorage wraps MemoryObjectStorage and lets the test
// inject a one-shot error for a given key.
type failingObjectStorage struct {
	inner    *MemoryObjectStorage
	failKeys map[string]error
}

func newFailingObjectStorage() *failingObjectStorage {
	return &failingObjectStorage{
		inner:    NewMemoryObjectStorage(),
		failKeys: make(map[string]error),
	}
}

func (s *failingObjectStorage) PresignPut(ctx context.Context, key string, contentType string, expiresIn time.Duration) (UploadTarget, error) {
	return s.inner.PresignPut(ctx, key, contentType, expiresIn)
}

func (s *failingObjectStorage) PutObject(ctx context.Context, key string, contentType string, data []byte) error {
	return s.inner.PutObject(ctx, key, contentType, data)
}

func (s *failingObjectStorage) GetObject(ctx context.Context, key string) ([]byte, error) {
	return s.inner.GetObject(ctx, key)
}

func (s *failingObjectStorage) HeadObject(ctx context.Context, key string) (ObjectInfo, error) {
	return s.inner.HeadObject(ctx, key)
}

func (s *failingObjectStorage) DeleteObject(ctx context.Context, key string) error {
	if err, ok := s.failKeys[key]; ok {
		delete(s.failKeys, key)
		return err
	}
	return s.inner.DeleteObject(ctx, key)
}

// buildReaperFixture wires Service over a fake store + object storage
// and seeds three documents: 1 expired ready, 1 expired processing
// (still gets reaped — anything not yet tombstoned past expiry is
// fair game), and 1 fresh ready (must be left alone).
func buildReaperFixture(t *testing.T, now time.Time) (*Service, *fakeMetadataStore, *failingObjectStorage, []string) {
	t.Helper()
	store := newFakeMetadataStore()
	objs := newFailingObjectStorage()
	svc := NewService(store, objs, ServiceConfig{
		Now: func() time.Time { return now },
	})

	expiredReady := Document{
		ID:              "expired-ready",
		UserID:          "alice",
		OriginalName:    "old.pdf",
		ContentType:     "application/pdf",
		SizeBytes:       100,
		Status:          StatusReady,
		SourceObjectKey: "documents/alice/expired-ready/source.pdf",
		TextObjectKey:   "documents/alice/expired-ready/extracted.txt",
		ExpiresAt:       now.Add(-1 * time.Hour),
		CreatedAt:       now.Add(-8 * 24 * time.Hour),
		UpdatedAt:       now.Add(-7 * 24 * time.Hour),
	}
	expiredProcessing := Document{
		ID:              "expired-processing",
		UserID:          "bob",
		OriginalName:    "older.pdf",
		ContentType:     "application/pdf",
		SizeBytes:       200,
		Status:          StatusProcessing,
		SourceObjectKey: "documents/bob/expired-processing/source.pdf",
		// No text key — stuck in processing
		ExpiresAt: now.Add(-2 * time.Hour),
		CreatedAt: now.Add(-9 * 24 * time.Hour),
		UpdatedAt: now.Add(-8 * 24 * time.Hour),
	}
	fresh := Document{
		ID:              "fresh-ready",
		UserID:          "alice",
		OriginalName:    "new.pdf",
		ContentType:     "application/pdf",
		SizeBytes:       300,
		Status:          StatusReady,
		SourceObjectKey: "documents/alice/fresh-ready/source.pdf",
		TextObjectKey:   "documents/alice/fresh-ready/extracted.txt",
		ExpiresAt:       now.Add(6 * 24 * time.Hour),
		CreatedAt:       now.Add(-1 * time.Hour),
		UpdatedAt:       now.Add(-1 * time.Hour),
	}
	alreadyDeleted := Document{
		ID:              "already-deleted",
		UserID:          "carol",
		OriginalName:    "tombstoned.pdf",
		ContentType:     "application/pdf",
		SizeBytes:       400,
		Status:          StatusDeleted,
		SourceObjectKey: "documents/carol/already-deleted/source.pdf",
		ExpiresAt:       now.Add(-3 * time.Hour),
		CreatedAt:       now.Add(-10 * 24 * time.Hour),
		UpdatedAt:       now.Add(-3 * time.Hour),
	}

	for _, d := range []Document{expiredReady, expiredProcessing, fresh, alreadyDeleted} {
		store.seed(d)
		if d.SourceObjectKey != "" {
			_ = objs.PutObject(context.Background(), d.SourceObjectKey, d.ContentType, []byte("payload"))
		}
		if d.TextObjectKey != "" {
			_ = objs.PutObject(context.Background(), d.TextObjectKey, "text/plain", []byte("extracted"))
		}
	}

	expiredIDs := []string{"expired-ready", "expired-processing"}
	return svc, store, objs, expiredIDs
}

func TestReapExpiredHappyPath(t *testing.T) {
	now := time.Date(2026, 5, 26, 12, 0, 0, 0, time.UTC)
	svc, store, objs, expiredIDs := buildReaperFixture(t, now)

	count, err := svc.ReapExpired(context.Background(), now, 100)
	if err != nil {
		t.Fatalf("ReapExpired: %v", err)
	}
	if count != len(expiredIDs) {
		t.Fatalf("expected %d reaped, got %d", len(expiredIDs), count)
	}

	docs := store.snapshot()
	for _, id := range expiredIDs {
		doc, ok := docs[id]
		if !ok {
			t.Fatalf("expired doc %s vanished from store entirely (expected tombstoned)", id)
		}
		if doc.Status != StatusDeleted {
			t.Fatalf("doc %s status=%q expected %q", id, doc.Status, StatusDeleted)
		}
	}

	// Expired source + text objects gone from storage.
	for _, key := range []string{
		"documents/alice/expired-ready/source.pdf",
		"documents/alice/expired-ready/extracted.txt",
		"documents/bob/expired-processing/source.pdf",
	} {
		if _, err := objs.HeadObject(context.Background(), key); err == nil {
			t.Fatalf("object %s still present after reap", key)
		}
	}

	// Fresh document and its objects untouched.
	if doc := docs["fresh-ready"]; doc.Status != StatusReady {
		t.Fatalf("fresh-ready status=%q expected %q", doc.Status, StatusReady)
	}
	if _, err := objs.HeadObject(context.Background(), "documents/alice/fresh-ready/source.pdf"); err != nil {
		t.Fatalf("fresh source unexpectedly deleted: %v", err)
	}

	// Already-deleted document never re-entered the reap path (its
	// source object should still exist because we never touched it).
	if _, err := objs.HeadObject(context.Background(), "documents/carol/already-deleted/source.pdf"); err != nil {
		t.Fatalf("already-deleted source got removed even though reaper should skip it: %v", err)
	}
}

func TestReapExpiredContinuesAfterS3Failure(t *testing.T) {
	now := time.Date(2026, 5, 26, 12, 0, 0, 0, time.UTC)
	svc, store, objs, expiredIDs := buildReaperFixture(t, now)

	// Make the first expired doc's source delete fail. Reaper must
	// still tombstone it (otherwise the next tick keeps retrying
	// forever) and continue to the second expired doc.
	bogus := errors.New("s3 unavailable")
	objs.failKeys["documents/alice/expired-ready/source.pdf"] = bogus

	count, err := svc.ReapExpired(context.Background(), now, 100)
	if !errors.Is(err, bogus) {
		t.Fatalf("expected returned error to wrap injected s3 err, got %v", err)
	}
	if count != len(expiredIDs) {
		t.Fatalf("expected %d reaped (tombstone even on s3 failure), got %d", len(expiredIDs), count)
	}

	docs := store.snapshot()
	for _, id := range expiredIDs {
		if docs[id].Status != StatusDeleted {
			t.Fatalf("doc %s not tombstoned after reap (status=%q)", id, docs[id].Status)
		}
	}
}

func TestReapExpiredContinuesAfterStoreDeleteFailure(t *testing.T) {
	now := time.Date(2026, 5, 26, 12, 0, 0, 0, time.UTC)
	svc, store, _, _ := buildReaperFixture(t, now)

	dbErr := errors.New("db blip")
	store.mu.Lock()
	store.deleteErr["expired-ready"] = dbErr
	store.mu.Unlock()

	count, err := svc.ReapExpired(context.Background(), now, 100)
	if !errors.Is(err, dbErr) {
		t.Fatalf("expected returned error to wrap injected db err, got %v", err)
	}
	// Only the second doc successfully tombstones; the first one
	// stays alive and will be retried next tick.
	if count != 1 {
		t.Fatalf("expected 1 reaped after a db failure (the other doc), got %d", count)
	}

	docs := store.snapshot()
	if docs["expired-ready"].Status == StatusDeleted {
		t.Fatalf("expired-ready unexpectedly tombstoned even though its delete failed")
	}
	if docs["expired-processing"].Status != StatusDeleted {
		t.Fatalf("expired-processing should still be tombstoned (status=%q)", docs["expired-processing"].Status)
	}
}

func TestReapExpiredRespectsBatchSize(t *testing.T) {
	now := time.Date(2026, 5, 26, 12, 0, 0, 0, time.UTC)
	store := newFakeMetadataStore()
	objs := newFailingObjectStorage()
	svc := NewService(store, objs, ServiceConfig{
		Now: func() time.Time { return now },
	})

	// Seed 5 expired docs.
	for i := 0; i < 5; i++ {
		id := fmt.Sprintf("expired-%d", i)
		store.seed(Document{
			ID:              id,
			UserID:          "alice",
			OriginalName:    id + ".pdf",
			ContentType:     "application/pdf",
			SizeBytes:       100,
			Status:          StatusReady,
			SourceObjectKey: "documents/alice/" + id + "/source.pdf",
			ExpiresAt:       now.Add(-time.Duration(i+1) * time.Hour),
			// Older CreatedAt for smaller i so reap order is i=0, 1, 2…
			CreatedAt: now.Add(-time.Duration(10-i) * 24 * time.Hour),
			UpdatedAt: now,
		})
	}

	count, err := svc.ReapExpired(context.Background(), now, 2)
	if err != nil {
		t.Fatalf("ReapExpired: %v", err)
	}
	if count != 2 {
		t.Fatalf("expected batch size to cap reap at 2, got %d", count)
	}

	// Confirm only the two oldest (expired-0, expired-1 by CreatedAt
	// ordering) got tombstoned.
	docs := store.snapshot()
	if docs["expired-0"].Status != StatusDeleted {
		t.Fatalf("expired-0 should be reaped first (oldest CreatedAt)")
	}
	if docs["expired-1"].Status != StatusDeleted {
		t.Fatalf("expired-1 should be reaped second")
	}
	for i := 2; i < 5; i++ {
		id := fmt.Sprintf("expired-%d", i)
		if docs[id].Status == StatusDeleted {
			t.Fatalf("doc %s should not have been reaped this batch (newer CreatedAt)", id)
		}
	}
}

func TestStartReaperTicksAndStops(t *testing.T) {
	now := time.Date(2026, 5, 26, 12, 0, 0, 0, time.UTC)

	// Custom store that counts ListExpiredDocuments calls so we can
	// see the ticker actually fires.
	store := &countingMetadataStore{fakeMetadataStore: newFakeMetadataStore()}
	objs := NewMemoryObjectStorage()
	svc := NewService(store, objs, ServiceConfig{
		Now: func() time.Time { return now },
	})

	ctx, cancel := context.WithCancel(context.Background())
	svc.StartReaper(ctx, 10*time.Millisecond, 10)

	// Wait long enough for at least 3 ticks.
	deadline := time.Now().Add(500 * time.Millisecond)
	for time.Now().Before(deadline) {
		if atomic.LoadInt64(&store.listCalls) >= 3 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	cancel()
	if got := atomic.LoadInt64(&store.listCalls); got < 3 {
		t.Fatalf("expected reaper to tick at least 3 times, got %d", got)
	}

	// Give the goroutine a moment to exit after ctx cancel.
	time.Sleep(30 * time.Millisecond)
	settled := atomic.LoadInt64(&store.listCalls)
	time.Sleep(40 * time.Millisecond)
	if atomic.LoadInt64(&store.listCalls) != settled {
		t.Fatalf("reaper still ticking after ctx cancel: was %d, now %d", settled, atomic.LoadInt64(&store.listCalls))
	}
}

func TestStartReaperNoopWhenIntervalZero(t *testing.T) {
	store := &countingMetadataStore{fakeMetadataStore: newFakeMetadataStore()}
	svc := NewService(store, NewMemoryObjectStorage(), ServiceConfig{})

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	svc.StartReaper(ctx, 0, 0)            // disabled
	svc.StartReaper(ctx, -time.Second, 0) // also disabled
	time.Sleep(50 * time.Millisecond)
	if got := atomic.LoadInt64(&store.listCalls); got != 0 {
		t.Fatalf("expected no ticks when interval≤0, got %d", got)
	}
}

type countingMetadataStore struct {
	*fakeMetadataStore
	listCalls int64
}

func (c *countingMetadataStore) ListExpiredDocuments(ctx context.Context, cutoff time.Time, limit int) ([]Document, error) {
	atomic.AddInt64(&c.listCalls, 1)
	return c.fakeMetadataStore.ListExpiredDocuments(ctx, cutoff, limit)
}
