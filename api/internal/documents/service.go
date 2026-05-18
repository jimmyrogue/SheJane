package documents

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"path/filepath"
	"strings"
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
