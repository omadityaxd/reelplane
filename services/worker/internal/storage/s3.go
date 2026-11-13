package storage

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sync"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"
	"github.com/aws/smithy-go"

	"github.com/omadityashukla/reelplane/services/worker/internal/config"
)

const (
	uploadConcurrency = 8
	deleteBatchSize   = 1000
)

// S3 talks to any S3-compatible provider (B2, R2, RustFS/MinIO, AWS).
type S3 struct {
	client *s3.Client
	bucket string
}

func NewS3(cfg config.Storage) (*S3, error) {
	if cfg.Endpoint == "" || cfg.Bucket == "" || cfg.AccessKeyID == "" || cfg.SecretAccessKey == "" {
		return nil, errors.New("storage: STORAGE_ENDPOINT, STORAGE_BUCKET and credentials are required")
	}
	region := cfg.Region
	if region == "" {
		region = "us-east-1"
	}
	client := s3.New(s3.Options{
		BaseEndpoint: aws.String(cfg.Endpoint),
		Region:       region,
		UsePathStyle: cfg.ForcePathStyle,
		Credentials:  credentials.NewStaticCredentialsProvider(cfg.AccessKeyID, cfg.SecretAccessKey, ""),
		// Same reason as the TypeScript client: not every S3-compatible provider accepts the
		// default CRC32 checksums added by recent SDK versions.
		RequestChecksumCalculation: aws.RequestChecksumCalculationWhenRequired,
		ResponseChecksumValidation: aws.ResponseChecksumValidationWhenRequired,
	})
	return &S3{client: client, bucket: cfg.Bucket}, nil
}

func isNotFound(err error) bool {
	var apiErr smithy.APIError
	if errors.As(err, &apiErr) {
		switch apiErr.ErrorCode() {
		case "NoSuchKey", "NotFound", "404":
			return true
		}
	}
	var noKey *types.NoSuchKey
	return errors.As(err, &noKey)
}

func (s *S3) Download(ctx context.Context, key, dst string) error {
	out, err := s.client.GetObject(ctx, &s3.GetObjectInput{Bucket: &s.bucket, Key: &key})
	if err != nil {
		if isNotFound(err) {
			return fmt.Errorf("%w: %s", ErrNotFound, key)
		}
		return fmt.Errorf("get %s: %w", key, err)
	}
	defer out.Body.Close()
	file, err := os.Create(dst)
	if err != nil {
		return fmt.Errorf("create %s: %w", dst, err)
	}
	if _, err := io.Copy(file, out.Body); err != nil {
		_ = file.Close()
		return fmt.Errorf("download %s: %w", key, err)
	}
	return file.Close()
}

func (s *S3) Put(ctx context.Context, key string, body []byte, contentType string) error {
	_, err := s.client.PutObject(ctx, &s3.PutObjectInput{
		Bucket: &s.bucket, Key: &key, Body: bytesReader(body), ContentType: &contentType,
		ContentLength: aws.Int64(int64(len(body))),
	})
	if err != nil {
		return fmt.Errorf("put %s: %w", key, err)
	}
	return nil
}

func (s *S3) putFile(ctx context.Context, local, key string) error {
	file, err := os.Open(local)
	if err != nil {
		return err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return err
	}
	contentType := ContentType(key)
	_, err = s.client.PutObject(ctx, &s3.PutObjectInput{
		Bucket: &s.bucket, Key: &key, Body: file, ContentType: &contentType,
		ContentLength: aws.Int64(info.Size()), CacheControl: aws.String(CacheControl),
	})
	if err != nil {
		return fmt.Errorf("upload %s: %w", key, err)
	}
	return nil
}

func (s *S3) UploadDir(ctx context.Context, dir, prefix string) ([]string, error) {
	if err := validPrefix(prefix); err != nil {
		return nil, err
	}
	files, err := localFiles(dir)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	work := make(chan string)
	errs := make(chan error, len(files))
	var wg sync.WaitGroup
	for range uploadConcurrency {
		wg.Go(func() {
			for rel := range work {
				if err := s.putFile(ctx, filepath.Join(dir, rel), joinKey(prefix, rel)); err != nil {
					errs <- err
					cancel()
				}
			}
		})
	}
	keys := make([]string, 0, len(files))
send:
	for _, rel := range files {
		select {
		case work <- rel:
			keys = append(keys, joinKey(prefix, rel))
		case <-ctx.Done():
			break send
		}
	}
	close(work)
	wg.Wait()
	close(errs)
	if err := errors.Join(drain(errs)...); err != nil {
		return nil, err
	}
	return keys, ctx.Err()
}

func (s *S3) List(ctx context.Context, prefix string) ([]string, error) {
	var keys []string
	paginator := s3.NewListObjectsV2Paginator(s.client, &s3.ListObjectsV2Input{Bucket: &s.bucket, Prefix: &prefix})
	for paginator.HasMorePages() {
		page, err := paginator.NextPage(ctx)
		if err != nil {
			return nil, fmt.Errorf("list %s: %w", prefix, err)
		}
		for _, object := range page.Contents {
			keys = append(keys, aws.ToString(object.Key))
		}
	}
	return keys, nil
}

func (s *S3) DeletePrefix(ctx context.Context, prefix string) (int, error) {
	if err := validPrefix(prefix); err != nil {
		return 0, err
	}
	keys, err := s.List(ctx, prefix)
	if err != nil {
		return 0, err
	}
	for start := 0; start < len(keys); start += deleteBatchSize {
		batch := keys[start:min(start+deleteBatchSize, len(keys))]
		objects := make([]types.ObjectIdentifier, len(batch))
		for i := range batch {
			objects[i] = types.ObjectIdentifier{Key: aws.String(batch[i])}
		}
		out, err := s.client.DeleteObjects(ctx, &s3.DeleteObjectsInput{
			Bucket: &s.bucket, Delete: &types.Delete{Objects: objects, Quiet: aws.Bool(true)},
		})
		if err != nil {
			return start, fmt.Errorf("delete under %s: %w", prefix, err)
		}
		// A 200 can still carry per-object failures: report them, so the sweep retries later
		// instead of forgetting objects that are still there.
		if len(out.Errors) > 0 {
			first := out.Errors[0]
			return start, fmt.Errorf("delete under %s: %d objects failed, e.g. %s: %s",
				prefix, len(out.Errors), aws.ToString(first.Key), aws.ToString(first.Message))
		}
	}
	return len(keys), nil
}

func (s *S3) AbortMultipart(ctx context.Context, key, uploadID string) error {
	_, err := s.client.AbortMultipartUpload(ctx, &s3.AbortMultipartUploadInput{
		Bucket: &s.bucket, Key: &key, UploadId: &uploadID,
	})
	var missing *types.NoSuchUpload
	if err != nil && !errors.As(err, &missing) {
		return fmt.Errorf("abort upload %s: %w", key, err)
	}
	return nil
}

func drain(errs <-chan error) []error {
	var all []error
	for err := range errs {
		all = append(all, err)
	}
	return all
}
