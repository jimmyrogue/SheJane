package documents

import (
	"context"
	"errors"
	"net/http"
	"path/filepath"
	"strings"
	"time"
)

const (
	StatusUploading  = "uploading"
	StatusProcessing = "processing"
	StatusReady      = "ready"
	StatusFailed     = "failed"
	StatusDeleted    = "deleted"
)

var (
	ErrExpired              = errors.New("document expired")
	ErrNotReady             = errors.New("document not ready")
	ErrObjectStorageMissing = errors.New("object storage is not configured")
	ErrTooLarge             = errors.New("document is too large")
	ErrUnsupportedType      = errors.New("unsupported document type")
)

type Document struct {
	ID              string    `json:"id"`
	UserID          string    `json:"user_id"`
	OriginalName    string    `json:"original_name"`
	ContentType     string    `json:"content_type"`
	SizeBytes       int64     `json:"size_bytes"`
	Status          string    `json:"status"`
	SourceObjectKey string    `json:"source_object_key"`
	TextObjectKey   string    `json:"text_object_key,omitempty"`
	ErrorMessage    string    `json:"error_message,omitempty"`
	ExpiresAt       time.Time `json:"expires_at"`
	CreatedAt       time.Time `json:"created_at"`
	UpdatedAt       time.Time `json:"updated_at"`
}

type UploadTarget struct {
	Method    string            `json:"method"`
	URL       string            `json:"url"`
	Headers   map[string]string `json:"headers"`
	ExpiresAt time.Time         `json:"expires_at"`
}

type UploadResponse struct {
	Document Document     `json:"document"`
	Upload   UploadTarget `json:"upload"`
}

type ObjectInfo struct {
	ContentType string
	SizeBytes   int64
}

type ObjectStorage interface {
	PresignPut(ctx context.Context, key string, contentType string, expiresIn time.Duration) (UploadTarget, error)
	PutObject(ctx context.Context, key string, contentType string, data []byte) error
	GetObject(ctx context.Context, key string) ([]byte, error)
	HeadObject(ctx context.Context, key string) (ObjectInfo, error)
	DeleteObject(ctx context.Context, key string) error
}

type MetadataStore interface {
	CreateDocument(ctx context.Context, document Document) (Document, error)
	DocumentsByUser(ctx context.Context, userID string) ([]Document, error)
	DocumentByID(ctx context.Context, userID string, documentID string) (Document, error)
	MarkDocumentProcessing(ctx context.Context, userID string, documentID string) (Document, error)
	MarkDocumentReady(ctx context.Context, userID string, documentID string, textObjectKey string) (Document, error)
	MarkDocumentFailed(ctx context.Context, userID string, documentID string, errorMessage string) (Document, error)
	DeleteDocument(ctx context.Context, userID string, documentID string) (Document, error)
}

type ServiceConfig struct {
	S3DocumentPrefix string
	MaxBytes         int64
	TextLimit        int
	TTL              time.Duration
	PresignTTL       time.Duration
	Now              func() time.Time
}

func DefaultServiceConfig() ServiceConfig {
	return ServiceConfig{
		S3DocumentPrefix: "documents",
		MaxBytes:         30 * 1024 * 1024,
		TextLimit:        60_000,
		TTL:              7 * 24 * time.Hour,
		PresignTTL:       15 * time.Minute,
		Now:              func() time.Time { return time.Now().UTC() },
	}
}

func NormalizeContentType(filename string, contentType string) (string, string, error) {
	name := strings.TrimSpace(filename)
	if name == "" {
		return "", "", ErrUnsupportedType
	}
	ext := strings.ToLower(filepath.Ext(name))
	normalized := strings.ToLower(strings.TrimSpace(strings.Split(contentType, ";")[0]))
	switch {
	case ext == ".pdf" || normalized == "application/pdf":
		return "application/pdf", ".pdf", nil
	case ext == ".docx" || normalized == "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
		return "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ".docx", nil
	case ext == ".xlsx" || normalized == "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
		return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ".xlsx", nil
	default:
		return "", "", ErrUnsupportedType
	}
}

func (document Document) IsExpired(now time.Time) bool {
	return !document.ExpiresAt.IsZero() && now.After(document.ExpiresAt)
}

func uploadTarget(url string, headers map[string]string, expiresAt time.Time) UploadTarget {
	if headers == nil {
		headers = map[string]string{}
	}
	return UploadTarget{Method: http.MethodPut, URL: url, Headers: headers, ExpiresAt: expiresAt}
}
