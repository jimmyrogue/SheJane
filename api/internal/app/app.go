package app

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"log"
	"math"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"golang.org/x/crypto/bcrypt"

	"github.com/coldflame/jiandanly/api/internal/config"
	"github.com/coldflame/jiandanly/api/internal/documents"
	"github.com/coldflame/jiandanly/api/internal/llm"
	"github.com/coldflame/jiandanly/api/internal/modelreg"
	"github.com/coldflame/jiandanly/api/internal/store"
)

var (
	ErrInvalidCredentials = errors.New("invalid credentials")
	ErrUnauthorized       = errors.New("unauthorized")
	ErrValidation         = errors.New("validation error")
	ErrAccountDisabled    = errors.New("account disabled")
)

type App struct {
	Config    config.Config
	Store     store.Store
	Router    *llm.Router
	Registry  *modelreg.Registry
	Documents *documents.Service
}

type AuthResult struct {
	AccessToken  string
	RefreshToken string
	User         store.User
}

type Claims struct {
	UserID string `json:"uid"`
	Email  string `json:"email"`
	Role   string `json:"role"`
	jwt.RegisteredClaims
}

type Option func(*appOptions)

type appOptions struct {
	documentStorage documents.ObjectStorage
}

func WithDocumentObjectStorage(storage documents.ObjectStorage) Option {
	return func(options *appOptions) {
		options.documentStorage = storage
	}
}

func New(cfg config.Config, st store.Store, opts ...Option) *App {
	options := appOptions{}
	for _, opt := range opts {
		opt(&options)
	}
	fast, deep := providersFromConfig(cfg)
	documentStorage := options.documentStorage
	if documentStorage == nil {
		documentStorage = documents.NewObjectStorageFromConfig(context.Background(), documents.StorageConfig{
			Region:          cfg.AWSRegion,
			AccessKeyID:     cfg.AWSAccessKeyID,
			SecretAccessKey: cfg.AWSSecretAccessKey,
			Bucket:          cfg.S3Bucket,
		})
	}
	documentConfig := documents.DefaultServiceConfig()
	documentConfig.S3DocumentPrefix = cfg.S3DocumentPrefix
	documentConfig.MaxBytes = cfg.DocumentMaxBytes
	documentConfig.TextLimit = cfg.DocumentTextLimit
	documentConfig.TTL = time.Duration(cfg.DocumentTTLHours) * time.Hour

	router := llm.NewRouterWithModels(fast, cfg.FastModel, deep, cfg.DeepModel)
	registry := modelreg.New(st, cfg)
	if err := registry.EnsureSeed(context.Background()); err != nil {
		log.Printf("app: model config seed failed (falling back to env config): %v", err)
	}
	router.SetResolver(registry.Resolve)

	return &App{
		Config:    cfg,
		Store:     st,
		Router:    router,
		Registry:  registry,
		Documents: documents.NewService(st, documentStorage, documentConfig),
	}
}

func (a *App) Register(ctx context.Context, email string, password string, name string) (AuthResult, error) {
	if !validEmail(email) || len(password) < 8 {
		return AuthResult{}, fmt.Errorf("%w: email and password are required", ErrValidation)
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return AuthResult{}, err
	}
	user, err := a.Store.CreateUser(ctx, email, string(hash), name)
	if err != nil {
		return AuthResult{}, err
	}
	user, err = a.promoteAdminIfConfigured(ctx, user)
	if err != nil {
		return AuthResult{}, err
	}
	if _, err := a.Store.EnsureWallet(ctx, user.ID, a.Config.MonthlyCredits); err != nil {
		return AuthResult{}, err
	}
	return a.issueAuth(ctx, user)
}

func (a *App) Login(ctx context.Context, email string, password string) (AuthResult, error) {
	user, err := a.Store.UserByEmail(ctx, email)
	if err != nil {
		return AuthResult{}, ErrInvalidCredentials
	}
	if err := bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte(password)); err != nil {
		return AuthResult{}, ErrInvalidCredentials
	}
	if user.Status != "active" {
		return AuthResult{}, ErrAccountDisabled
	}
	user, err = a.promoteAdminIfConfigured(ctx, user)
	if err != nil {
		return AuthResult{}, err
	}
	return a.issueAuth(ctx, user)
}

func (a *App) Refresh(ctx context.Context, refreshToken string) (AuthResult, error) {
	user, err := a.Store.UseRefreshToken(ctx, refreshToken)
	if err != nil {
		return AuthResult{}, ErrUnauthorized
	}
	if user.Status != "active" {
		return AuthResult{}, ErrUnauthorized
	}
	user, err = a.promoteAdminIfConfigured(ctx, user)
	if err != nil {
		return AuthResult{}, err
	}
	return a.issueAuth(ctx, user)
}

func (a *App) Logout(ctx context.Context, refreshToken string) error {
	if refreshToken == "" {
		return nil
	}
	return a.Store.RevokeRefreshToken(ctx, refreshToken)
}

func (a *App) Authenticate(ctx context.Context, token string) (store.User, error) {
	claims := &Claims{}
	parsed, err := jwt.ParseWithClaims(token, claims, func(token *jwt.Token) (any, error) {
		return []byte(a.Config.JWTSecret), nil
	})
	if err != nil || !parsed.Valid {
		return store.User{}, ErrUnauthorized
	}
	user, err := a.Store.UserByID(ctx, claims.UserID)
	if err != nil {
		return store.User{}, err
	}
	if user.Status != "active" {
		return store.User{}, ErrUnauthorized
	}
	return user, nil
}

// markupFactor is the global gross markup applied on top of the per-model
// cost ratio (the product's fixed core margin).
func (a *App) markupFactor() float64 {
	if a.Registry == nil {
		return 1
	}
	return a.Registry.Markup()
}

func (a *App) EstimateCredits(request llm.ChatRequest) int64 {
	tokens := llm.EstimateTokens(request.Messages)
	mode := llm.NormalizeMode(request.Model)
	credits := applyMultiplier(int64(tokens), a.Router.MultiplierFor(mode)*a.markupFactor())
	if credits < 300 {
		return 300
	}
	return credits
}

// UsageCredits converts settled token usage to credits using the per-model
// cost ratio for the mode times the global markup, minimum 1 credit.
func (a *App) UsageCredits(mode llm.Mode, totalTokens int) int64 {
	credits := applyMultiplier(int64(totalTokens), a.Router.MultiplierFor(mode)*a.markupFactor())
	if credits < 1 {
		return 1
	}
	return credits
}

func applyMultiplier(tokens int64, multiplier float64) int64 {
	if multiplier <= 0 {
		multiplier = 1
	}
	return int64(math.Ceil(float64(tokens) * multiplier))
}

func (a *App) NewRequestID() string {
	return randomToken("req")
}

func (a *App) NewUUID() string {
	var bytes [16]byte
	if _, err := rand.Read(bytes[:]); err != nil {
		panic(err)
	}
	bytes[6] = (bytes[6] & 0x0f) | 0x40
	bytes[8] = (bytes[8] & 0x3f) | 0x80
	encoded := hex.EncodeToString(bytes[:])
	return encoded[0:8] + "-" + encoded[8:12] + "-" + encoded[12:16] + "-" + encoded[16:20] + "-" + encoded[20:32]
}

func (a *App) promoteAdminIfConfigured(ctx context.Context, user store.User) (store.User, error) {
	if user.Role == "admin" || !a.Config.IsAdminEmail(user.Email) {
		return user, nil
	}
	return a.Store.UpdateUserRole(ctx, user.ID, "admin")
}

func (a *App) issueAuth(ctx context.Context, user store.User) (AuthResult, error) {
	now := time.Now().UTC()
	claims := Claims{
		UserID: user.ID,
		Email:  user.Email,
		Role:   user.Role,
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:   user.ID,
			Issuer:    "jiandanly-api",
			IssuedAt:  jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(now.Add(a.Config.AccessTokenTTL)),
		},
	}
	accessToken, err := jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString([]byte(a.Config.JWTSecret))
	if err != nil {
		return AuthResult{}, err
	}
	refreshToken := randomToken("refresh")
	if err := a.Store.SaveRefreshToken(ctx, refreshToken, user.ID, now.Add(a.Config.RefreshTokenTTL)); err != nil {
		return AuthResult{}, err
	}
	return AuthResult{AccessToken: accessToken, RefreshToken: refreshToken, User: user}, nil
}

func providersFromConfig(cfg config.Config) (llm.Provider, llm.Provider) {
	if cfg.MockLLM {
		return llm.NewMockProvider("deepseek-fast", "Mock Jiandan response from fast mode"), llm.NewMockProvider("claude-deep", "Mock Jiandan response from deep mode")
	}

	fast := llm.Provider(llm.NewMockProvider("deepseek-fast", "Mock Jiandan response from fast fallback"))
	if cfg.FastProviderBaseURL != "" && cfg.FastProviderAPIKey != "" {
		fastKind := llm.InferOpenAIProviderKind(cfg.FastProviderKind, cfg.FastProviderBaseURL)
		fast = llm.NewOpenAICompatibleProviderWithProfile("deepseek-fast", cfg.FastProviderBaseURL, cfg.FastProviderAPIKey, llm.ProfileForProviderKind(fastKind))
	}

	deep := llm.Provider(llm.NewMockProvider("claude-deep", "Mock Jiandan response from deep fallback"))
	deepKind := llm.NormalizeProviderKind(cfg.DeepProviderKind)
	if cfg.AnthropicAPIKey != "" && (deepKind == "" || deepKind == llm.ProviderKindAnthropic) {
		deep = llm.NewAnthropicProvider(cfg.AnthropicAPIKey, cfg.AnthropicVersion)
	} else if cfg.DeepProviderBaseURL != "" && cfg.DeepProviderAPIKey != "" {
		if deepKind == "" || deepKind == llm.ProviderKindAnthropic {
			deepKind = llm.InferOpenAIProviderKind(cfg.DeepProviderKind, cfg.DeepProviderBaseURL)
		}
		deep = llm.NewOpenAICompatibleProviderWithProfile("deep-compatible", cfg.DeepProviderBaseURL, cfg.DeepProviderAPIKey, llm.ProfileForProviderKind(deepKind))
	}
	return fast, deep
}

func randomToken(prefix string) string {
	var bytes [24]byte
	if _, err := rand.Read(bytes[:]); err != nil {
		panic(errors.New("crypto/rand failed"))
	}
	return prefix + "_" + hex.EncodeToString(bytes[:])
}

func validEmail(email string) bool {
	email = strings.TrimSpace(email)
	return strings.Contains(email, "@") && strings.Contains(email, ".")
}
