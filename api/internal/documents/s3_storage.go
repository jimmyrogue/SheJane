package documents

import (
	"bytes"
	"context"
	"io"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

type StorageConfig struct {
	Region          string
	AccessKeyID     string
	SecretAccessKey string
	Bucket          string
}

type S3ObjectStorage struct {
	client    *s3.Client
	presigner *s3.PresignClient
	bucket    string
}

func NewObjectStorageFromConfig(ctx context.Context, cfg StorageConfig) ObjectStorage {
	if strings.TrimSpace(cfg.Bucket) == "" {
		return NewDisabledObjectStorage("S3_BUCKET is required")
	}
	if strings.TrimSpace(cfg.Region) == "" {
		return NewDisabledObjectStorage("AWS_REGION is required")
	}
	options := []func(*awsconfig.LoadOptions) error{awsconfig.WithRegion(cfg.Region)}
	if cfg.AccessKeyID != "" || cfg.SecretAccessKey != "" {
		options = append(options, awsconfig.WithCredentialsProvider(credentials.NewStaticCredentialsProvider(cfg.AccessKeyID, cfg.SecretAccessKey, "")))
	}
	awsCfg, err := awsconfig.LoadDefaultConfig(ctx, options...)
	if err != nil {
		return NewDisabledObjectStorage(err.Error())
	}
	client := s3.NewFromConfig(awsCfg)
	return &S3ObjectStorage{
		client:    client,
		presigner: s3.NewPresignClient(client),
		bucket:    cfg.Bucket,
	}
}

func (s *S3ObjectStorage) PresignPut(ctx context.Context, key string, contentType string, expiresIn time.Duration) (UploadTarget, error) {
	result, err := s.presigner.PresignPutObject(ctx, &s3.PutObjectInput{
		Bucket:      aws.String(s.bucket),
		Key:         aws.String(key),
		ContentType: aws.String(contentType),
	}, s3.WithPresignExpires(expiresIn))
	if err != nil {
		return UploadTarget{}, err
	}
	headers := make(map[string]string, len(result.SignedHeader))
	for key, values := range result.SignedHeader {
		if len(values) > 0 {
			headers[key] = values[0]
		}
	}
	if _, ok := headers["Content-Type"]; !ok {
		headers["Content-Type"] = contentType
	}
	return uploadTarget(result.URL, headers, time.Now().UTC().Add(expiresIn)), nil
}

func (s *S3ObjectStorage) PutObject(ctx context.Context, key string, contentType string, data []byte) error {
	_, err := s.client.PutObject(ctx, &s3.PutObjectInput{
		Bucket:      aws.String(s.bucket),
		Key:         aws.String(key),
		ContentType: aws.String(contentType),
		Body:        bytes.NewReader(data),
	})
	return err
}

func (s *S3ObjectStorage) GetObject(ctx context.Context, key string) ([]byte, error) {
	result, err := s.client.GetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String(s.bucket),
		Key:    aws.String(key),
	})
	if err != nil {
		return nil, err
	}
	defer result.Body.Close()
	return io.ReadAll(result.Body)
}

func (s *S3ObjectStorage) HeadObject(ctx context.Context, key string) (ObjectInfo, error) {
	result, err := s.client.HeadObject(ctx, &s3.HeadObjectInput{
		Bucket: aws.String(s.bucket),
		Key:    aws.String(key),
	})
	if err != nil {
		return ObjectInfo{}, err
	}
	size := int64(0)
	if result.ContentLength != nil {
		size = *result.ContentLength
	}
	contentType := ""
	if result.ContentType != nil {
		contentType = *result.ContentType
	}
	return ObjectInfo{ContentType: contentType, SizeBytes: size}, nil
}

func (s *S3ObjectStorage) DeleteObject(ctx context.Context, key string) error {
	if strings.TrimSpace(key) == "" {
		return nil
	}
	_, err := s.client.DeleteObject(ctx, &s3.DeleteObjectInput{
		Bucket: aws.String(s.bucket),
		Key:    aws.String(key),
	})
	return err
}
