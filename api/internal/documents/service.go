package documents

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"log"
	"path/filepath"
	"strings"
	"time"
)

type Service struct {
	store   MetadataStore
	objects ObjectStorage
	config  ServiceConfig
}

func NewService(store MetadataStore, objects ObjectStorage, cfg ServiceConfig) *Service {
	defaults := DefaultServiceConfig()
	if cfg.S3DocumentPrefix == "" {
		cfg.S3DocumentPrefix = defaults.S3DocumentPrefix
	}
	if cfg.MaxBytes <= 0 {
		cfg.MaxBytes = defaults.MaxBytes
	}
	if cfg.TextLimit <= 0 {
		cfg.TextLimit = defaults.TextLimit
	}
	if cfg.TTL == 0 {
		cfg.TTL = defaults.TTL
	}
	if cfg.PresignTTL == 0 {
		cfg.PresignTTL = defaults.PresignTTL
	}
	if cfg.Now == nil {
		cfg.Now = defaults.Now
	}
	if objects == nil {
		objects = NewDisabledObjectStorage("object storage is not configured")
	}
	return &Service{store: store, objects: objects, config: cfg}
}

func (s *Service) CreateUpload(ctx context.Context, userID string, filename string, contentType string, sizeBytes int64) (UploadResponse, error) {
	contentType, ext, err := NormalizeContentType(filename, contentType)
	if err != nil {
		return UploadResponse{}, err
	}
	if sizeBytes <= 0 || sizeBytes > s.config.MaxBytes {
		return UploadResponse{}, ErrTooLarge
	}
	now := s.config.Now().UTC()
	documentID := newDocumentID()
	document := Document{
		ID:              documentID,
		UserID:          userID,
		OriginalName:    filepath.Base(strings.TrimSpace(filename)),
		ContentType:     contentType,
		SizeBytes:       sizeBytes,
		Status:          StatusUploading,
		SourceObjectKey: s.objectKey(userID, documentID, "source"+ext),
		ExpiresAt:       now.Add(s.config.TTL),
		CreatedAt:       now,
		UpdatedAt:       now,
	}
	created, err := s.store.CreateDocument(ctx, document)
	if err != nil {
		return UploadResponse{}, err
	}
	target, err := s.objects.PresignPut(ctx, created.SourceObjectKey, created.ContentType, s.config.PresignTTL)
	if err != nil {
		return UploadResponse{}, err
	}
	return UploadResponse{Document: created, Upload: target}, nil
}

func (s *Service) CompleteUpload(ctx context.Context, userID string, documentID string) (Document, error) {
	document, err := s.store.MarkDocumentProcessing(ctx, userID, documentID)
	if err != nil {
		return Document{}, err
	}
	info, err := s.objects.HeadObject(ctx, document.SourceObjectKey)
	if err != nil {
		return s.fail(ctx, userID, documentID, err)
	}
	if info.SizeBytes <= 0 || info.SizeBytes > s.config.MaxBytes {
		return s.fail(ctx, userID, documentID, ErrTooLarge)
	}
	if IsImageContentType(document.ContentType) {
		// Images carry no extractable text; they are consumed directly by
		// image.edit via ReadSource. Mark ready with no text object.
		return s.store.MarkDocumentReady(ctx, userID, documentID, "")
	}
	data, err := s.objects.GetObject(ctx, document.SourceObjectKey)
	if err != nil {
		return s.fail(ctx, userID, documentID, err)
	}
	text, err := ExtractText(document.OriginalName, document.ContentType, data, s.config.TextLimit)
	if err != nil {
		return s.fail(ctx, userID, documentID, err)
	}
	textKey := s.objectKey(userID, document.ID, "extracted.txt")
	if err := s.objects.PutObject(ctx, textKey, "text/plain; charset=utf-8", []byte(text)); err != nil {
		return s.fail(ctx, userID, documentID, err)
	}
	return s.store.MarkDocumentReady(ctx, userID, documentID, textKey)
}

func (s *Service) DocumentsByUser(ctx context.Context, userID string) ([]Document, error) {
	return s.store.DocumentsByUser(ctx, userID)
}

func (s *Service) DocumentByID(ctx context.Context, userID string, documentID string) (Document, error) {
	return s.store.DocumentByID(ctx, userID, documentID)
}

func (s *Service) TextForQuestion(ctx context.Context, userID string, documentID string) (Document, string, error) {
	document, err := s.store.DocumentByID(ctx, userID, documentID)
	if err != nil {
		return Document{}, "", err
	}
	if document.IsExpired(s.config.Now().UTC()) {
		return Document{}, "", ErrExpired
	}
	if document.Status != StatusReady {
		return Document{}, "", ErrNotReady
	}
	data, err := s.objects.GetObject(ctx, document.TextObjectKey)
	if err != nil {
		return Document{}, "", err
	}
	return document, string(data), nil
}

// ReadSource returns the raw uploaded bytes of a ready (non-expired) document,
// with its content type and original filename. Used by image.edit to feed a
// client-uploaded image into the provider without a public URL.
func (s *Service) ReadSource(ctx context.Context, userID string, documentID string) ([]byte, string, string, error) {
	document, err := s.store.DocumentByID(ctx, userID, documentID)
	if err != nil {
		return nil, "", "", err
	}
	if document.IsExpired(s.config.Now().UTC()) {
		return nil, "", "", ErrExpired
	}
	if document.Status != StatusReady {
		return nil, "", "", ErrNotReady
	}
	data, err := s.objects.GetObject(ctx, document.SourceObjectKey)
	if err != nil {
		return nil, "", "", err
	}
	return data, document.ContentType, document.OriginalName, nil
}

func (s *Service) DeleteDocument(ctx context.Context, userID string, documentID string) (Document, error) {
	document, err := s.store.DeleteDocument(ctx, userID, documentID)
	if err != nil {
		return Document{}, err
	}
	_ = s.objects.DeleteObject(ctx, document.SourceObjectKey)
	_ = s.objects.DeleteObject(ctx, document.TextObjectKey)
	return document, nil
}

// ReapExpired hard-deletes documents whose ExpiresAt is before
// `cutoff` and that aren't already tombstoned. For each: best-effort
// delete the S3 source + text objects, then flip the row to
// 'deleted'. Returns the count actually killed and the first error
// encountered (subsequent rows still attempted — one bad object
// shouldn't stall the rest of the batch).
//
// Why we keep this even when S3 Lifecycle is configured to expire
// objects on its own:
//   - Lifecycle runs once a day on AWS's schedule, with no SLA. A
//     burst of uploads near a Lifecycle pass can leave files sitting
//     for ~24h past their TTL.
//   - Lifecycle doesn't clean the Postgres `documents` row — those
//     would accumulate indefinitely and bloat the index even after
//     S3 has reclaimed the bytes.
//   - Defense in depth: if someone forgets to configure Lifecycle on
//     a new bucket, the reaper still keeps the system honest.
func (s *Service) ReapExpired(ctx context.Context, cutoff time.Time, limit int) (int, error) {
	if limit <= 0 {
		limit = 100
	}
	expired, err := s.store.ListExpiredDocuments(ctx, cutoff, limit)
	if err != nil {
		return 0, err
	}
	reaped := 0
	var firstErr error
	for _, doc := range expired {
		// S3 deletes first — if these fail we still tombstone the
		// row (so the next pass doesn't keep retrying forever); the
		// orphaned S3 object will eventually be reclaimed by the
		// bucket Lifecycle policy.
		if doc.SourceObjectKey != "" {
			if err := s.objects.DeleteObject(ctx, doc.SourceObjectKey); err != nil {
				log.Printf("documents.reaper: delete source object %q: %v", doc.SourceObjectKey, err)
				if firstErr == nil {
					firstErr = err
				}
			}
		}
		if doc.TextObjectKey != "" {
			if err := s.objects.DeleteObject(ctx, doc.TextObjectKey); err != nil {
				log.Printf("documents.reaper: delete text object %q: %v", doc.TextObjectKey, err)
				if firstErr == nil {
					firstErr = err
				}
			}
		}
		if _, err := s.store.DeleteDocument(ctx, doc.UserID, doc.ID); err != nil {
			log.Printf("documents.reaper: tombstone document %q: %v", doc.ID, err)
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		reaped++
	}
	return reaped, firstErr
}

// StartReaper kicks off a goroutine that calls ReapExpired every
// `interval` until ctx is cancelled. Idempotent no-op when interval
// is zero or negative (lets callers disable cleanly via config).
//
// `batchSize` caps how many documents one tick processes — if a tick
// finds the limit, it's likely backlog and the next tick continues.
// Tail latency stays bounded; we don't try to drain in a tight loop.
func (s *Service) StartReaper(ctx context.Context, interval time.Duration, batchSize int) {
	if interval <= 0 {
		return
	}
	if batchSize <= 0 {
		batchSize = 100
	}
	go func() {
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				count, err := s.ReapExpired(ctx, s.config.Now().UTC(), batchSize)
				if err != nil {
					log.Printf("documents.reaper: tick err=%v reaped=%d", err, count)
				} else if count > 0 {
					log.Printf("documents.reaper: tick reaped=%d", count)
				}
			}
		}
	}()
}

func (s *Service) fail(ctx context.Context, userID string, documentID string, cause error) (Document, error) {
	message := cause.Error()
	document, err := s.store.MarkDocumentFailed(ctx, userID, documentID, message)
	if err != nil {
		return Document{}, err
	}
	if errors.Is(cause, ErrTooLarge) || errors.Is(cause, ErrUnsupportedType) {
		return document, cause
	}
	return document, cause
}

func (s *Service) objectKey(userID string, documentID string, name string) string {
	prefix := strings.Trim(s.config.S3DocumentPrefix, "/")
	if prefix == "" {
		prefix = "documents"
	}
	return prefix + "/" + userID + "/" + documentID + "/" + name
}

func newDocumentID() string {
	var bytes [16]byte
	if _, err := rand.Read(bytes[:]); err != nil {
		panic(err)
	}
	bytes[6] = (bytes[6] & 0x0f) | 0x40
	bytes[8] = (bytes[8] & 0x3f) | 0x80
	encoded := hex.EncodeToString(bytes[:])
	return encoded[0:8] + "-" + encoded[8:12] + "-" + encoded[12:16] + "-" + encoded[16:20] + "-" + encoded[20:32]
}

func IsValidationError(err error) bool {
	return errors.Is(err, ErrTooLarge) || errors.Is(err, ErrUnsupportedType)
}
