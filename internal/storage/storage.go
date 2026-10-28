// Package storage keeps attachment bytes in an S3-compatible bucket (MinIO, AWS, ...).
package storage

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"time"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"

	"github.com/flappeh/notegraph/internal/config"
)

type Store struct {
	client *minio.Client
	bucket string
}

// New returns nil (and no error) when S3 is not configured: the app then
// runs with attachments disabled.
func New(ctx context.Context, c *config.Config) (*Store, error) {
	if c.S3Endpoint == "" {
		slog.Warn("S3_ENDPOINT not set: attachments are disabled")
		return nil, nil
	}
	cl, err := minio.New(c.S3Endpoint, &minio.Options{
		Creds:  credentials.NewStaticV4(c.S3AccessKey, c.S3SecretKey, ""),
		Secure: c.S3UseSSL,
		Region: c.S3Region,
	})
	if err != nil {
		return nil, fmt.Errorf("s3 client: %w", err)
	}
	// Object storage may start after us in a swarm; retry for a while.
	var ok bool
	for attempt := 1; ; attempt++ {
		if ok, err = cl.BucketExists(ctx, c.S3Bucket); err == nil {
			break
		}
		if attempt >= 30 {
			return nil, fmt.Errorf("s3 bucket check: %w", err)
		}
		slog.Warn("object storage not reachable, retrying", "attempt", attempt, "err", err)
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(2 * time.Second):
		}
	}
	if !ok {
		if err := cl.MakeBucket(ctx, c.S3Bucket, minio.MakeBucketOptions{Region: c.S3Region}); err != nil {
			return nil, fmt.Errorf("s3 create bucket %q: %w", c.S3Bucket, err)
		}
		slog.Info("created bucket", "bucket", c.S3Bucket)
	}
	return &Store{client: cl, bucket: c.S3Bucket}, nil
}

func Key(userID, id string) string { return userID + "/" + id }

func (s *Store) Put(ctx context.Context, key string, r io.Reader, size int64, mime string) error {
	_, err := s.client.PutObject(ctx, s.bucket, key, r, size, minio.PutObjectOptions{ContentType: mime})
	return err
}

// Get returns the object stream and its size.
func (s *Store) Get(ctx context.Context, key string) (io.ReadCloser, int64, error) {
	obj, err := s.client.GetObject(ctx, s.bucket, key, minio.GetObjectOptions{})
	if err != nil {
		return nil, 0, err
	}
	st, err := obj.Stat()
	if err != nil {
		obj.Close()
		return nil, 0, err
	}
	return obj, st.Size, nil
}

func (s *Store) Delete(ctx context.Context, key string) error {
	return s.client.RemoveObject(ctx, s.bucket, key, minio.RemoveObjectOptions{})
}
