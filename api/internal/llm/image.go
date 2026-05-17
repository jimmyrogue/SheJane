package llm

import "context"

// ImageRequest is a single image-generation call.
type ImageRequest struct {
	Prompt string
	Size   string
	N      int
}

// ImageItem is one generated image (URL or base64, provider-dependent).
type ImageItem struct {
	URL     string `json:"url,omitempty"`
	B64JSON string `json:"b64_json,omitempty"`
}

type ImageResult struct {
	Model  string      `json:"model"`
	Images []ImageItem `json:"images"`
}

// ImageProvider generates images. Kept separate from the streaming chat
// Provider since image APIs are request/response, not SSE.
type ImageProvider interface {
	Name() string
	GenerateImage(ctx context.Context, request ImageRequest, model string) (ImageResult, error)
}

// MockImageProvider returns a deterministic placeholder; used when an image
// slot is enabled but not fully configured, and in tests.
type MockImageProvider struct {
	name string
}

func NewMockImageProvider(name string) *MockImageProvider {
	if name == "" {
		name = "mock-image"
	}
	return &MockImageProvider{name: name}
}

func (p *MockImageProvider) Name() string { return p.name }

func (p *MockImageProvider) GenerateImage(_ context.Context, request ImageRequest, model string) (ImageResult, error) {
	n := request.N
	if n < 1 {
		n = 1
	}
	images := make([]ImageItem, 0, n)
	for i := 0; i < n; i++ {
		images = append(images, ImageItem{URL: "https://example.com/mock-image.png"})
	}
	return ImageResult{Model: model, Images: images}, nil
}
