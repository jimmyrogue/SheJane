package documents

import (
	"context"
	"fmt"
	"sync"
	"time"
)

type memoryObject struct {
	contentType string
	data        []byte
}

type MemoryObjectStorage struct {
	mu      sync.Mutex
	objects map[string]memoryObject
}

func NewMemoryObjectStorage() *MemoryObjectStorage {
	return &MemoryObjectStorage{objects: make(map[string]memoryObject)}
}

func (s *MemoryObjectStorage) PresignPut(ctx context.Context, key string, contentType string, expiresIn time.Duration) (UploadTarget, error) {
	return uploadTarget("memory://"+key, map[string]string{"Content-Type": contentType}, time.Now().UTC().Add(expiresIn)), nil
}

func (s *MemoryObjectStorage) PutObject(ctx context.Context, key string, contentType string, data []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	copied := append([]byte(nil), data...)
	s.objects[key] = memoryObject{contentType: contentType, data: copied}
	return nil
}

func (s *MemoryObjectStorage) GetObject(ctx context.Context, key string) ([]byte, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	object, ok := s.objects[key]
	if !ok {
		return nil, fmt.Errorf("%w: object %s", ErrObjectStorageMissing, key)
	}
	return append([]byte(nil), object.data...), nil
}

func (s *MemoryObjectStorage) HeadObject(ctx context.Context, key string) (ObjectInfo, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	object, ok := s.objects[key]
	if !ok {
		return ObjectInfo{}, fmt.Errorf("%w: object %s", ErrObjectStorageMissing, key)
	}
	return ObjectInfo{ContentType: object.contentType, SizeBytes: int64(len(object.data))}, nil
}

func (s *MemoryObjectStorage) DeleteObject(ctx context.Context, key string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.objects, key)
	return nil
}

type disabledObjectStorage struct {
	reason string
}

func NewDisabledObjectStorage(reason string) ObjectStorage {
	return disabledObjectStorage{reason: reason}
}

func (s disabledObjectStorage) PresignPut(ctx context.Context, key string, contentType string, expiresIn time.Duration) (UploadTarget, error) {
	return UploadTarget{}, fmt.Errorf("%w: %s", ErrObjectStorageMissing, s.reason)
}

func (s disabledObjectStorage) PutObject(ctx context.Context, key string, contentType string, data []byte) error {
	return fmt.Errorf("%w: %s", ErrObjectStorageMissing, s.reason)
}

func (s disabledObjectStorage) GetObject(ctx context.Context, key string) ([]byte, error) {
	return nil, fmt.Errorf("%w: %s", ErrObjectStorageMissing, s.reason)
}

func (s disabledObjectStorage) HeadObject(ctx context.Context, key string) (ObjectInfo, error) {
	return ObjectInfo{}, fmt.Errorf("%w: %s", ErrObjectStorageMissing, s.reason)
}

func (s disabledObjectStorage) DeleteObject(ctx context.Context, key string) error {
	return nil
}
