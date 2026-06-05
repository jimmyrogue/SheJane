package httpapi

import (
	"context"
	"fmt"
	"io"
	"math"
	"net/http"
	"path"
	"strings"
	"time"

	"github.com/coldflame/jiandanly/api/internal/billing"
	"github.com/coldflame/jiandanly/api/internal/llm"
	"github.com/coldflame/jiandanly/api/internal/store"
)

const (
	imageToolName     = "image.generate"
	imageEditToolName = "image.edit"
)

type imageGenInput struct {
	RunID          string
	ToolCallID     string
	IdempotencyKey string
	Prompt         string
	Size           string
	N              int
}

type imageEditInput struct {
	RunID          string
	ToolCallID     string
	IdempotencyKey string
	Prompt         string
	ImageURL       string
	MaskURL        string
	DocumentID     string
	MaskDocumentID string
	Size           string
	N              int
}

// imageCreditsPerImage converts a money-per-call price into credits using the
// registry-cached baseline cost and the global markup. ok is false when the
// baseline cost has not been configured (image billing then refuses).
func (s *Server) imageCreditsPerImage(pricePerCall float64) (int64, bool) {
	baseCost, ok := s.app.Registry.CurrencyPerCredit()
	if !ok {
		return 0, false
	}
	perImage := int64(math.Ceil(pricePerCall / baseCost * s.app.Registry.Markup()))
	if perImage < 1 {
		perImage = 1
	}
	return perImage, true
}

func argString(args map[string]any, key string) string {
	if args == nil {
		return ""
	}
	if v, ok := args[key].(string); ok {
		return v
	}
	return ""
}

func argInt(args map[string]any, key string) int {
	if args == nil {
		return 0
	}
	switch v := args[key].(type) {
	case float64:
		return int(v)
	case int:
		return v
	default:
		return 0
	}
}

// imageToolCapability advertises image.generate to the agent only when an
// image model is enabled and the credit rate is configured.
func (s *Server) imageToolCapability(_ context.Context) toolCapability {
	provider, _, pricePerCall, ok := s.app.Registry.ResolveImage()
	capability := toolCapability{Provider: "image", RequiresAuth: true}
	if !ok {
		return capability
	}
	perImage, billOK := s.imageCreditsPerImage(pricePerCall)
	if !billOK {
		return capability
	}
	capability.Configured = true
	capability.Provider = provider.Name()
	capability.CreditsCost = perImage
	return capability
}

func clampImageCount(n int) int {
	if n < 1 {
		return 1
	}
	if n > 4 {
		return 4
	}
	return n
}

// runBilledImage runs a fully-billed image op (generate or edit) and returns
// the agent-tool-shaped result + HTTP status. Billing reuses the external-tool
// ledger (reserve → settle/release, idempotent). invoke calls the provider.
func (s *Server) runBilledImage(
	ctx context.Context,
	user store.User,
	toolName, runID, toolCallID, idempotencyKey string,
	n int,
	invoke func(provider llm.ImageProvider, model string) (llm.ImageResult, error),
) (agentToolExecuteResult, int) {
	provider, model, pricePerCall, ok := s.app.Registry.ResolveImage()
	if !ok {
		return toolError("image_generation_disabled", "图像功能未启用：请在管理后台配置并启用一个 image.default 模型。"), http.StatusBadRequest
	}
	perImage, ok := s.imageCreditsPerImage(pricePerCall)
	if !ok {
		return toolError("image_billing_not_configured", "图像计费未配置：请先在管理后台设置「基准每 token 成本」。"), http.StatusBadRequest
	}

	n = clampImageCount(n)
	creditsCost := perImage * int64(n)

	idempotencyKey = strings.TrimSpace(idempotencyKey)
	if idempotencyKey == "" {
		idempotencyKey = strings.Join([]string{runID, toolCallID, toolName}, ":")
	}
	if existing, err := s.app.Store.ExternalToolCallByIdempotencyKey(ctx, user.ID, idempotencyKey); err == nil && existing.Status == "done" {
		return resultFromToolRecord(existing), http.StatusOK
	}

	requestID := requestIDFromContext(ctx, s.app.NewRequestID())
	reservation, err := s.app.Store.ReserveUsage(ctx, user.ID, s.app.Config.MonthlyCredits, creditsCost, billing.ReservationMeta{
		UserID:    user.ID,
		RequestID: requestID,
		Mode:      "image",
	})
	if err != nil {
		if billing.IsInsufficientCredits(err) {
			return toolError("insufficient_credits", "额度不足，请升级或充值"), http.StatusPaymentRequired
		}
		return toolError("reservation_failed", "额度预留失败"), http.StatusInternalServerError
	}

	record, created, err := s.app.Store.CreateExternalToolCall(ctx, store.ExternalToolCallRecord{
		RequestID:      requestID,
		UserID:         user.ID,
		WalletID:       reservation.WalletID,
		ReservationID:  reservation.ID,
		RunID:          runID,
		ToolCallID:     toolCallID,
		Tool:           toolName,
		Provider:       provider.Name(),
		Status:         "running",
		IdempotencyKey: idempotencyKey,
		StartedAt:      time.Now().UTC(),
	})
	if err != nil {
		_ = s.app.Store.ReleaseUsage(ctx, user.ID, reservation.ID)
		return toolError("tool_record_failed", "记录工具调用失败"), http.StatusInternalServerError
	}
	if !created {
		_ = s.app.Store.ReleaseUsage(ctx, user.ID, reservation.ID)
		if record.Status == "done" {
			return resultFromToolRecord(record), http.StatusOK
		}
		return toolError("tool_call_in_progress", "This image task is already being processed."), http.StatusConflict
	}

	generated, err := invoke(provider, model)
	if err != nil {
		_ = s.app.Store.ReleaseUsage(ctx, user.ID, reservation.ID)
		_ = s.app.Store.FinishExternalToolCall(ctx, requestID, "failed", 0, 0, "image_generation_failed", truncateProviderError(err.Error()), "", nil)
		return toolError("image_generation_failed", "图像处理失败："+truncateProviderError(err.Error())), http.StatusBadGateway
	}

	units := len(generated.Images)
	if err := s.app.Store.SettleUsage(ctx, user.ID, reservation.ID, creditsCost); err != nil {
		// Reservation is still Reserved on settle failure — release it so
		// the held estimate isn't stranded.
		_ = s.app.Store.ReleaseUsage(ctx, user.ID, reservation.ID)
		_ = s.app.Store.FinishExternalToolCall(ctx, requestID, "failed", units, 0, "settlement_failed", err.Error(), "", nil)
		if billing.IsInsufficientCredits(err) {
			return toolError("insufficient_credits", "额度不足，请升级或充值"), http.StatusPaymentRequired
		}
		return toolError("settlement_failed", "额度结算失败"), http.StatusInternalServerError
	}

	imagePayload := make([]map[string]any, 0, len(generated.Images))
	contentLines := make([]string, 0, len(generated.Images)+1)
	contentLines = append(contentLines, fmt.Sprintf("已完成 %d 张图片（模型 %s）：", units, generated.Model))
	for index, image := range generated.Images {
		entry := map[string]any{}
		if image.URL != "" {
			entry["url"] = image.URL
			contentLines = append(contentLines, fmt.Sprintf("%d. %s", index+1, image.URL))
		}
		if image.B64JSON != "" {
			entry["b64_json"] = image.B64JSON
			contentLines = append(contentLines, fmt.Sprintf("%d. [base64 image]", index+1))
		}
		imagePayload = append(imagePayload, entry)
	}
	data := map[string]any{
		"source":     toolName,
		"model":      generated.Model,
		"images":     imagePayload,
		"request_id": requestID,
	}
	result := agentToolExecuteResult{
		OK:      true,
		Content: strings.Join(contentLines, "\n"),
		Data:    data,
		Usage: map[string]any{
			"credits_cost": creditsCost,
			"units":        units,
			"request_id":   requestID,
		},
	}
	if err := s.app.Store.FinishExternalToolCall(ctx, requestID, "done", units, creditsCost, "", "", result.Content, data); err != nil {
		return toolError("tool_finish_failed", "记录工具调用完成失败"), http.StatusInternalServerError
	}
	return result, http.StatusOK
}

func (s *Server) runImageGeneration(ctx context.Context, user store.User, in imageGenInput) (agentToolExecuteResult, int) {
	prompt := strings.TrimSpace(in.Prompt)
	if prompt == "" {
		return toolError("prompt_required", "An image prompt is required."), http.StatusBadRequest
	}
	return s.runBilledImage(ctx, user, imageToolName, in.RunID, in.ToolCallID, in.IdempotencyKey, in.N,
		func(provider llm.ImageProvider, model string) (llm.ImageResult, error) {
			return provider.GenerateImage(ctx, llm.ImageRequest{Prompt: prompt, Size: in.Size, N: clampImageCount(in.N)}, model)
		})
}

// resolveImageBytes returns image bytes + a filename, preferring an uploaded
// document (S3, no public URL needed) over a fetchable URL.
func (s *Server) resolveImageBytes(ctx context.Context, userID, documentID, rawURL string) ([]byte, string, string, error) {
	if strings.TrimSpace(documentID) != "" {
		data, contentType, name, err := s.app.Documents.ReadSource(ctx, userID, strings.TrimSpace(documentID))
		if err != nil {
			return nil, "", "", err
		}
		return data, name, contentType, nil
	}
	if strings.TrimSpace(rawURL) != "" {
		data, name, err := fetchURLBytes(ctx, strings.TrimSpace(rawURL))
		return data, name, "", err
	}
	return nil, "", "", nil
}

func fetchURLBytes(ctx context.Context, rawURL string) ([]byte, string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, "", err
	}
	client := &http.Client{Timeout: 60 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, "", fmt.Errorf("download %s returned status %d", rawURL, resp.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, 16<<20))
	if err != nil {
		return nil, "", err
	}
	name := path.Base(strings.SplitN(rawURL, "?", 2)[0])
	if name == "" || name == "." || name == "/" || !strings.Contains(name, ".") {
		name = "image.png"
	}
	return data, name, nil
}

func (s *Server) runImageEdit(ctx context.Context, user store.User, in imageEditInput) (agentToolExecuteResult, int) {
	prompt := strings.TrimSpace(in.Prompt)
	if prompt == "" {
		return toolError("prompt_required", "An edit prompt is required."), http.StatusBadRequest
	}
	if strings.TrimSpace(in.DocumentID) == "" && strings.TrimSpace(in.ImageURL) == "" {
		return toolError("image_source_required", "Provide document_id (an uploaded image) or image_url to edit."), http.StatusBadRequest
	}
	imageData, imageName, _, err := s.resolveImageBytes(ctx, user.ID, in.DocumentID, in.ImageURL)
	if err != nil {
		return toolError("image_source_failed", "无法读取待编辑的图片："+truncateProviderError(err.Error())), http.StatusBadRequest
	}
	if len(imageData) == 0 {
		return toolError("image_source_required", "Source image is empty or unavailable."), http.StatusBadRequest
	}
	var maskData []byte
	var maskName string
	if strings.TrimSpace(in.MaskDocumentID) != "" || strings.TrimSpace(in.MaskURL) != "" {
		maskData, maskName, _, err = s.resolveImageBytes(ctx, user.ID, in.MaskDocumentID, in.MaskURL)
		if err != nil {
			return toolError("image_source_failed", "无法读取 mask 图片："+truncateProviderError(err.Error())), http.StatusBadRequest
		}
	}
	return s.runBilledImage(ctx, user, imageEditToolName, in.RunID, in.ToolCallID, in.IdempotencyKey, in.N,
		func(provider llm.ImageProvider, model string) (llm.ImageResult, error) {
			return provider.EditImage(ctx, llm.ImageEditRequest{
				Prompt:    prompt,
				Image:     imageData,
				ImageName: imageName,
				Mask:      maskData,
				MaskName:  maskName,
				Size:      in.Size,
				N:         clampImageCount(in.N),
			}, model)
		})
}

// imagesGenerations is the plain REST entrypoint (auth required). Each call is
// a fresh generation (unique idempotency key).
func (s *Server) imagesGenerations(w http.ResponseWriter, r *http.Request, user store.User) {
	var body struct {
		Prompt string `json:"prompt"`
		Size   string `json:"size"`
		N      int    `json:"n"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	result, status := s.runImageGeneration(r.Context(), user, imageGenInput{
		IdempotencyKey: "image:" + s.app.NewRequestID(),
		Prompt:         body.Prompt,
		Size:           body.Size,
		N:              body.N,
	})
	code := 0
	if !result.OK {
		code = 1
	}
	writeJSON(w, status, apiResponse[agentToolExecuteResult]{Code: code, Message: result.Content, Data: result})
}

// imagesEdits is the plain REST entrypoint for image-to-image edits.
func (s *Server) imagesEdits(w http.ResponseWriter, r *http.Request, user store.User) {
	var body struct {
		Prompt         string `json:"prompt"`
		ImageURL       string `json:"image_url"`
		MaskURL        string `json:"mask_url"`
		DocumentID     string `json:"document_id"`
		MaskDocumentID string `json:"mask_document_id"`
		Size           string `json:"size"`
		N              int    `json:"n"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	result, status := s.runImageEdit(r.Context(), user, imageEditInput{
		IdempotencyKey: "image-edit:" + s.app.NewRequestID(),
		Prompt:         body.Prompt,
		ImageURL:       body.ImageURL,
		MaskURL:        body.MaskURL,
		DocumentID:     body.DocumentID,
		MaskDocumentID: body.MaskDocumentID,
		Size:           body.Size,
		N:              body.N,
	})
	code := 0
	if !result.OK {
		code = 1
	}
	writeJSON(w, status, apiResponse[agentToolExecuteResult]{Code: code, Message: result.Content, Data: result})
}
