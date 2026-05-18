package llm

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// OpenAIImageProvider talks to an OpenAI-compatible /images/generations API
// (OpenAI, Azure OpenAI, and most compatible gateways). baseURL should already
// include any required version prefix (e.g. https://api.openai.com/v1).
type OpenAIImageProvider struct {
	name    string
	baseURL string
	apiKey  string
	client  *http.Client
}

func NewOpenAIImageProvider(name string, baseURL string, apiKey string) *OpenAIImageProvider {
	return &OpenAIImageProvider{
		name:    name,
		baseURL: strings.TrimRight(baseURL, "/"),
		apiKey:  apiKey,
		client:  &http.Client{Timeout: 120 * time.Second},
	}
}

func (p *OpenAIImageProvider) Name() string { return p.name }

func (p *OpenAIImageProvider) GenerateImage(ctx context.Context, request ImageRequest, model string) (ImageResult, error) {
	n := request.N
	if n < 1 {
		n = 1
	}
	payload := map[string]any{
		"model":  model,
		"prompt": request.Prompt,
		"n":      n,
	}
	if strings.TrimSpace(request.Size) != "" {
		payload["size"] = request.Size
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return ImageResult{}, err
	}
	endpoint := p.baseURL + "/images/generations"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return ImageResult{}, err
	}
	req.Header.Set("Authorization", "Bearer "+p.apiKey)
	req.Header.Set("Content-Type", "application/json")

	resp, err := p.client.Do(req)
	if err != nil {
		return ImageResult{}, err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return ImageResult{}, fmt.Errorf("%s image provider returned status %d from %s: %s", p.name, resp.StatusCode, endpoint, snippet(raw))
	}
	var decoded struct {
		Data []struct {
			URL     string `json:"url"`
			B64JSON string `json:"b64_json"`
		} `json:"data"`
	}
	if err := json.Unmarshal(raw, &decoded); err != nil {
		// A non-JSON 2xx body almost always means a wrong base_url/path
		// (e.g. an HTML landing/404 page instead of the OpenAI image API).
		return ImageResult{}, fmt.Errorf(
			"%s image provider: expected JSON from POST %s but got status %d non-JSON body (check the model's Base URL/path, e.g. it may need a /v1 prefix): %s",
			p.name, endpoint, resp.StatusCode, snippet(raw),
		)
	}
	images := make([]ImageItem, 0, len(decoded.Data))
	for _, item := range decoded.Data {
		images = append(images, ImageItem{URL: item.URL, B64JSON: item.B64JSON})
	}
	if len(images) == 0 {
		return ImageResult{}, fmt.Errorf("%s image provider returned no images", p.name)
	}
	return ImageResult{Model: model, Images: images}, nil
}

// snippet trims and caps a response body for safe inclusion in error messages.
func snippet(raw []byte) string {
	s := strings.TrimSpace(string(raw))
	if s == "" {
		return "(empty body)"
	}
	runes := []rune(s)
	if len(runes) > 300 {
		return string(runes[:300]) + "…"
	}
	return s
}
