package llm

import (
	"context"
	"errors"
	"fmt"
)

// ErrProviderUnconfigured signals that a model slot is bound to a real
// provider that is missing required credentials (API key / base URL).
// Returning this — instead of silently substituting a billable mock that
// emits a fake answer — lets the caller's billing path RELEASE the
// reservation, so the user is never charged for a misconfiguration.
var ErrProviderUnconfigured = errors.New("model provider is not configured (missing API key or base URL)")

func unconfiguredErr(reason string) error {
	if reason == "" {
		return ErrProviderUnconfigured
	}
	return fmt.Errorf("%w: %s", ErrProviderUnconfigured, reason)
}

// UnconfiguredProvider is the chat provider used when a real provider kind
// has no usable credentials. Every Stream fails fast (no chunks, one error)
// so nothing is billed and the user sees an error rather than a fake reply.
type UnconfiguredProvider struct {
	name   string
	reason string
}

func NewUnconfiguredProvider(name, reason string) *UnconfiguredProvider {
	return &UnconfiguredProvider{name: name, reason: reason}
}

func (p *UnconfiguredProvider) Name() string { return p.name }

func (p *UnconfiguredProvider) Stream(_ context.Context, _ ChatRequest, _ string) (<-chan Chunk, <-chan error) {
	chunks := make(chan Chunk)
	errs := make(chan error, 1)
	errs <- unconfiguredErr(p.reason)
	close(chunks)
	close(errs)
	return chunks, errs
}

// UnconfiguredImageProvider mirrors UnconfiguredProvider for image slots:
// generate/edit fail fast so the billed-image path releases its reservation.
type UnconfiguredImageProvider struct {
	name   string
	reason string
}

func NewUnconfiguredImageProvider(name, reason string) *UnconfiguredImageProvider {
	return &UnconfiguredImageProvider{name: name, reason: reason}
}

func (p *UnconfiguredImageProvider) Name() string { return p.name }

func (p *UnconfiguredImageProvider) GenerateImage(_ context.Context, _ ImageRequest, _ string) (ImageResult, error) {
	return ImageResult{}, unconfiguredErr(p.reason)
}

func (p *UnconfiguredImageProvider) EditImage(_ context.Context, _ ImageEditRequest, _ string) (ImageResult, error) {
	return ImageResult{}, unconfiguredErr(p.reason)
}
