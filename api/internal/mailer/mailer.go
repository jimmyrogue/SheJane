// Package mailer sends transactional email. The only platform-paid provider
// key (RESEND_API_KEY) lives here in the Go API, never in the daemon
// (CLAUDE.md Invariant #1). When no key is configured the LogMailer logs the
// message instead of sending — so the full reset flow is exercisable in dev
// without real delivery.
package mailer

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"
)

// Mailer sends the transactional emails the auth flows need.
type Mailer interface {
	// SendPasswordReset emails a reset link to `to`. Implementations must not
	// reveal whether the address belongs to a real account.
	SendPasswordReset(ctx context.Context, to string, resetURL string) error
}

// New returns a ResendMailer when apiKey + fromAddress are set, otherwise a
// LogMailer (dev/test: logs the link, sends nothing).
func New(apiKey string, fromAddress string, fromName string) Mailer {
	if strings.TrimSpace(apiKey) == "" || strings.TrimSpace(fromAddress) == "" {
		slog.Warn("mailer: RESEND_API_KEY / MAIL_FROM_ADDRESS not set — using LogMailer (emails are logged, not sent)")
		return &LogMailer{}
	}
	return &ResendMailer{
		apiKey:      apiKey,
		fromAddress: fromAddress,
		fromName:    fromName,
		httpClient:  &http.Client{Timeout: 10 * time.Second},
		endpoint:    "https://api.resend.com/emails",
	}
}

// LogMailer logs what it would send. Used in dev/test and whenever email is
// unconfigured. The reset link is logged so a developer can complete the flow.
type LogMailer struct{}

func (m *LogMailer) SendPasswordReset(_ context.Context, to string, resetURL string) error {
	slog.Info("mailer(log): password reset email", "to", to, "reset_url", resetURL)
	return nil
}

// ResendMailer sends via the Resend HTTP API.
type ResendMailer struct {
	apiKey      string
	fromAddress string
	fromName    string
	httpClient  *http.Client
	endpoint    string
}

func (m *ResendMailer) SendPasswordReset(ctx context.Context, to string, resetURL string) error {
	subject := "Reset your SheJane password / 重置石间密码"
	html := fmt.Sprintf(
		`<p>We received a request to reset your SheJane password.</p>`+
			`<p><a href="%s">Click here to choose a new password</a>. This link expires soon.</p>`+
			`<p>If you didn't request this, you can safely ignore this email.</p>`+
			`<hr><p>我们收到了重置你石间密码的请求。<a href="%s">点此设置新密码</a>(链接很快过期)。`+
			`若非本人操作,忽略本邮件即可。</p>`,
		resetURL, resetURL,
	)
	return m.send(ctx, to, subject, html)
}

func (m *ResendMailer) send(ctx context.Context, to string, subject string, html string) error {
	from := m.fromAddress
	if strings.TrimSpace(m.fromName) != "" {
		from = fmt.Sprintf("%s <%s>", m.fromName, m.fromAddress)
	}
	body, err := json.Marshal(map[string]any{
		"from":    from,
		"to":      []string{to},
		"subject": subject,
		"html":    html,
	})
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, m.endpoint, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+m.apiKey)
	req.Header.Set("Content-Type", "application/json")
	resp, err := m.httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		payload, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		return fmt.Errorf("resend: unexpected status %d: %s", resp.StatusCode, strings.TrimSpace(string(payload)))
	}
	return nil
}
