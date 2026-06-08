package httpapi

import (
	"archive/zip"
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/coldflame/shejane/api/internal/app"
	"github.com/coldflame/shejane/api/internal/billing"
	"github.com/coldflame/shejane/api/internal/config"
	"github.com/coldflame/shejane/api/internal/documents"
	"github.com/coldflame/shejane/api/internal/llm"
	"github.com/coldflame/shejane/api/internal/store"
)

type captureMailer struct {
	calls   int
	lastTo  string
	lastURL string
}

func (m *captureMailer) SendPasswordReset(_ context.Context, to string, resetURL string) error {
	m.calls++
	m.lastTo = to
	m.lastURL = resetURL
	return nil
}

func TestPasswordResetFlow(t *testing.T) {
	cfg := config.Default()
	cfg.JWTSecret = "test-secret"
	cfg.MockLLM = true
	cfg.MonthlyCredits = 10_000
	memory := store.NewMemoryStore()
	mail := &captureMailer{}
	server := NewServer(app.New(cfg, memory, app.WithMailer(mail)))

	registerAndTokenWithEmail(t, server, "reset-me@example.com")

	post := func(path, body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		server.ServeHTTP(rec, req)
		return rec
	}

	// Reset request for the real email → 200 + one email with a link.
	if rec := post("/api/v1/auth/password/reset-request", `{"email":"reset-me@example.com"}`); rec.Code != http.StatusOK {
		t.Fatalf("reset-request = %d, body = %s", rec.Code, rec.Body.String())
	}
	if mail.calls != 1 {
		t.Fatalf("expected 1 reset email, got %d", mail.calls)
	}

	// Unknown email ALSO returns 200 but sends no email (no user enumeration).
	if rec := post("/api/v1/auth/password/reset-request", `{"email":"nobody@example.com"}`); rec.Code != http.StatusOK {
		t.Fatalf("reset-request (unknown) = %d, want 200 (no enumeration)", rec.Code)
	}
	if mail.calls != 1 {
		t.Fatalf("unknown email must not send an email; calls = %d", mail.calls)
	}

	idx := strings.Index(mail.lastURL, "token=")
	if idx < 0 {
		t.Fatalf("reset url missing token: %q", mail.lastURL)
	}
	resetToken := mail.lastURL[idx+len("token="):]

	// Too-short password is rejected.
	if rec := post("/api/v1/auth/password/reset-confirm", `{"token":"`+resetToken+`","password":"short"}`); rec.Code != http.StatusBadRequest {
		t.Fatalf("short password = %d, want 400", rec.Code)
	}

	// Confirm with a valid new password.
	if rec := post("/api/v1/auth/password/reset-confirm", `{"token":"`+resetToken+`","password":"newpassword123"}`); rec.Code != http.StatusOK {
		t.Fatalf("reset-confirm = %d, body = %s", rec.Code, rec.Body.String())
	}

	// Old password no longer works; the new one does.
	if rec := post("/api/v1/auth/login", `{"email":"reset-me@example.com","password":"secret123"}`); rec.Code == http.StatusOK {
		t.Fatal("old password should no longer authenticate")
	}
	if rec := post("/api/v1/auth/login", `{"email":"reset-me@example.com","password":"newpassword123"}`); rec.Code != http.StatusOK {
		t.Fatalf("new password login = %d, want 200", rec.Code)
	}

	// The token is single-use: a second confirm fails.
	if rec := post("/api/v1/auth/password/reset-confirm", `{"token":"`+resetToken+`","password":"yetanother123"}`); rec.Code == http.StatusOK {
		t.Fatal("reset token must be single-use")
	}
}

func TestRegisterLoginAndMe(t *testing.T) {
	server := newTestServer(t)

	register := httptest.NewRequest(http.MethodPost, "/api/v1/auth/register", strings.NewReader(`{"email":"ada@example.com","password":"secret123","name":"Ada"}`))
	register.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()
	server.ServeHTTP(recorder, register)

	if recorder.Code != http.StatusCreated {
		t.Fatalf("register status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if len(recorder.Result().Cookies()) == 0 {
		t.Fatal("register did not set refresh cookie")
	}

	var registerBody apiResponse[authPayload]
	if err := json.Unmarshal(recorder.Body.Bytes(), &registerBody); err != nil {
		t.Fatalf("decode register response: %v", err)
	}
	if registerBody.Data.AccessToken == "" {
		t.Fatal("register access token is empty")
	}

	me := httptest.NewRequest(http.MethodGet, "/api/v1/user/me", nil)
	me.Header.Set("Authorization", "Bearer "+registerBody.Data.AccessToken)
	meRecorder := httptest.NewRecorder()
	server.ServeHTTP(meRecorder, me)

	if meRecorder.Code != http.StatusOK {
		t.Fatalf("me status = %d, body = %s", meRecorder.Code, meRecorder.Body.String())
	}
	if !strings.Contains(meRecorder.Body.String(), "ada@example.com") {
		t.Fatalf("me response missing user email: %s", meRecorder.Body.String())
	}
}

func TestChatStreamsAndSettlesUsage(t *testing.T) {
	server := newTestServer(t)
	token := registerAndToken(t, server)

	body := `{"model":"fast","stream":true,"client_conversation_id":"conv-local","client_message_id":"msg-local","scene":"write","messages":[{"role":"user","content":"写一封客户跟进邮件"}]}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/chat/completions", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()

	server.ServeHTTP(recorder, req)
	if recorder.Code != http.StatusOK {
		t.Fatalf("chat status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if got := recorder.Header().Get("Content-Type"); !strings.HasPrefix(got, "text/event-stream") {
		t.Fatalf("content type = %q, want text/event-stream", got)
	}

	scanner := bufio.NewScanner(strings.NewReader(recorder.Body.String()))
	var sawDelta bool
	var sawDone bool
	for scanner.Scan() {
		line := scanner.Text()
		if strings.Contains(line, "Mock SheJane response") {
			sawDelta = true
		}
		if line == "data: [DONE]" {
			sawDone = true
		}
	}
	if !sawDelta || !sawDone {
		t.Fatalf("stream delta=%t done=%t body=%s", sawDelta, sawDone, recorder.Body.String())
	}
}

func TestBillingBalanceRequiresAuth(t *testing.T) {
	server := newTestServer(t)
	req := httptest.NewRequest(http.MethodGet, "/api/v1/billing/balance", nil)
	recorder := httptest.NewRecorder()

	server.ServeHTTP(recorder, req)

	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("billing status = %d, want 401", recorder.Code)
	}
}

func TestDocumentUploadRequiresAuthAndValidatesInput(t *testing.T) {
	server, _ := newDocumentTestServer(t, nil)

	unauth := httptest.NewRequest(http.MethodPost, "/api/v1/documents/uploads", strings.NewReader(`{"filename":"brief.docx","content_type":"application/vnd.openxmlformats-officedocument.wordprocessingml.document","size_bytes":128}`))
	unauth.Header.Set("Content-Type", "application/json")
	unauthRecorder := httptest.NewRecorder()
	server.ServeHTTP(unauthRecorder, unauth)
	if unauthRecorder.Code != http.StatusUnauthorized {
		t.Fatalf("unauth upload status = %d, want 401", unauthRecorder.Code)
	}

	token := registerAndToken(t, server)
	unsupported := documentUploadRequest("legacy.doc", "application/msword", 128)
	unsupported.Header.Set("Authorization", "Bearer "+token)
	unsupportedRecorder := httptest.NewRecorder()
	server.ServeHTTP(unsupportedRecorder, unsupported)
	if unsupportedRecorder.Code != http.StatusBadRequest {
		t.Fatalf("unsupported upload status = %d, want 400, body = %s", unsupportedRecorder.Code, unsupportedRecorder.Body.String())
	}

	tooLarge := documentUploadRequest("large.pdf", "application/pdf", 31*1024*1024)
	tooLarge.Header.Set("Authorization", "Bearer "+token)
	tooLargeRecorder := httptest.NewRecorder()
	server.ServeHTTP(tooLargeRecorder, tooLarge)
	if tooLargeRecorder.Code != http.StatusBadRequest {
		t.Fatalf("large upload status = %d, want 400, body = %s", tooLargeRecorder.Code, tooLargeRecorder.Body.String())
	}

	valid := documentUploadRequest("brief.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", 512)
	valid.Header.Set("Authorization", "Bearer "+token)
	validRecorder := httptest.NewRecorder()
	server.ServeHTTP(validRecorder, valid)
	if validRecorder.Code != http.StatusCreated {
		t.Fatalf("valid upload status = %d, body = %s", validRecorder.Code, validRecorder.Body.String())
	}
	var body apiResponse[documentUploadPayload]
	if err := json.Unmarshal(validRecorder.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode valid upload: %v", err)
	}
	if body.Data.Document.ID == "" || body.Data.Document.Status != documents.StatusUploading {
		t.Fatalf("upload document = %#v", body.Data.Document)
	}
	if body.Data.Upload.Method != http.MethodPut || body.Data.Upload.URL == "" {
		t.Fatalf("upload info = %#v", body.Data.Upload)
	}
}

func TestDocumentCompleteExtractsDocxAndListsReadyDocument(t *testing.T) {
	server, objects := newDocumentTestServer(t, nil)
	token := registerAndToken(t, server)
	upload := createDocumentUpload(t, server, token, "brief.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", 512)

	if err := objects.PutObject(t.Context(), upload.Document.SourceObjectKey, upload.Document.ContentType, minimalDocx("Phase two document text")); err != nil {
		t.Fatalf("put source object: %v", err)
	}

	complete := httptest.NewRequest(http.MethodPost, "/api/v1/documents/"+upload.Document.ID+"/complete", nil)
	complete.Header.Set("Authorization", "Bearer "+token)
	completeRecorder := httptest.NewRecorder()
	server.ServeHTTP(completeRecorder, complete)
	if completeRecorder.Code != http.StatusOK {
		t.Fatalf("complete status = %d, body = %s", completeRecorder.Code, completeRecorder.Body.String())
	}
	var completeBody apiResponse[documents.Document]
	if err := json.Unmarshal(completeRecorder.Body.Bytes(), &completeBody); err != nil {
		t.Fatalf("decode complete: %v", err)
	}
	if completeBody.Data.Status != documents.StatusReady || completeBody.Data.TextObjectKey == "" {
		t.Fatalf("complete document = %#v", completeBody.Data)
	}
	extracted, err := objects.GetObject(t.Context(), completeBody.Data.TextObjectKey)
	if err != nil {
		t.Fatalf("get extracted text: %v", err)
	}
	if !strings.Contains(string(extracted), "Phase two document text") {
		t.Fatalf("extracted text = %q", string(extracted))
	}

	list := httptest.NewRequest(http.MethodGet, "/api/v1/documents", nil)
	list.Header.Set("Authorization", "Bearer "+token)
	listRecorder := httptest.NewRecorder()
	server.ServeHTTP(listRecorder, list)
	if listRecorder.Code != http.StatusOK {
		t.Fatalf("list status = %d, body = %s", listRecorder.Code, listRecorder.Body.String())
	}
	if !strings.Contains(listRecorder.Body.String(), `"status":"ready"`) {
		t.Fatalf("list missing ready document: %s", listRecorder.Body.String())
	}
}

func TestDocumentSourceStreamsBytesAndGatesOwnership(t *testing.T) {
	server, objects := newDocumentTestServer(t, nil)
	token := registerAndToken(t, server)
	upload := createDocumentUpload(t, server, token, "preview.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", 512)

	sourceBytes := minimalDocx("preview-bytes")
	if err := objects.PutObject(t.Context(), upload.Document.SourceObjectKey, upload.Document.ContentType, sourceBytes); err != nil {
		t.Fatalf("put source object: %v", err)
	}
	complete := httptest.NewRequest(http.MethodPost, "/api/v1/documents/"+upload.Document.ID+"/complete", nil)
	complete.Header.Set("Authorization", "Bearer "+token)
	completeRecorder := httptest.NewRecorder()
	server.ServeHTTP(completeRecorder, complete)
	if completeRecorder.Code != http.StatusOK {
		t.Fatalf("complete status = %d, body = %s", completeRecorder.Code, completeRecorder.Body.String())
	}

	// Happy path: GET /source returns the bytes with the right Content-Type.
	src := httptest.NewRequest(http.MethodGet, "/api/v1/documents/"+upload.Document.ID+"/source", nil)
	src.Header.Set("Authorization", "Bearer "+token)
	srcRecorder := httptest.NewRecorder()
	server.ServeHTTP(srcRecorder, src)
	if srcRecorder.Code != http.StatusOK {
		t.Fatalf("source status = %d, body = %s", srcRecorder.Code, srcRecorder.Body.String())
	}
	if got := srcRecorder.Body.Bytes(); !bytes.Equal(got, sourceBytes) {
		t.Fatalf("source bytes mismatch: got %d bytes, want %d", len(got), len(sourceBytes))
	}
	if got := srcRecorder.Header().Get("Content-Type"); got != upload.Document.ContentType {
		t.Fatalf("Content-Type = %q, want %q", got, upload.Document.ContentType)
	}
	if got := srcRecorder.Header().Get("Content-Disposition"); !strings.Contains(got, "preview.docx") {
		t.Fatalf("Content-Disposition = %q, want substring preview.docx", got)
	}

	// Ownership gate: a different user's token can't read it.
	otherToken := registerAndTokenWithEmail(t, server, "other-source-reader@example.com")
	if otherToken == token {
		t.Fatalf("expected distinct registration tokens")
	}
	denied := httptest.NewRequest(http.MethodGet, "/api/v1/documents/"+upload.Document.ID+"/source", nil)
	denied.Header.Set("Authorization", "Bearer "+otherToken)
	deniedRecorder := httptest.NewRecorder()
	server.ServeHTTP(deniedRecorder, denied)
	if deniedRecorder.Code == http.StatusOK {
		t.Fatalf("source served to non-owner; status = %d body = %s", deniedRecorder.Code, deniedRecorder.Body.String())
	}

	// Auth gate: no token → 401.
	unauth := httptest.NewRequest(http.MethodGet, "/api/v1/documents/"+upload.Document.ID+"/source", nil)
	unauthRecorder := httptest.NewRecorder()
	server.ServeHTTP(unauthRecorder, unauth)
	if unauthRecorder.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated source status = %d", unauthRecorder.Code)
	}
}

func TestDocumentAskStreamsAndSettlesUsage(t *testing.T) {
	server, objects := newDocumentTestServer(t, nil)
	token := registerAndToken(t, server)
	upload := createDocumentUpload(t, server, token, "brief.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", 512)
	if err := objects.PutObject(t.Context(), upload.Document.SourceObjectKey, upload.Document.ContentType, minimalDocx("The launch date is Tuesday.")); err != nil {
		t.Fatalf("put source object: %v", err)
	}
	completeDocument(t, server, token, upload.Document.ID)
	before := billingBalance(t, server, token)

	ask := httptest.NewRequest(http.MethodPost, "/api/v1/documents/"+upload.Document.ID+"/ask", strings.NewReader(`{"model":"fast","question":"When is launch?"}`))
	ask.Header.Set("Authorization", "Bearer "+token)
	ask.Header.Set("Content-Type", "application/json")
	askRecorder := httptest.NewRecorder()
	server.ServeHTTP(askRecorder, ask)
	if askRecorder.Code != http.StatusOK {
		t.Fatalf("ask status = %d, body = %s", askRecorder.Code, askRecorder.Body.String())
	}
	if !strings.Contains(askRecorder.Body.String(), "Mock SheJane response") || !strings.Contains(askRecorder.Body.String(), "data: [DONE]") {
		t.Fatalf("ask stream body = %s", askRecorder.Body.String())
	}
	after := billingBalance(t, server, token)
	if after.MonthlyRemaining >= before.MonthlyRemaining {
		t.Fatalf("monthly remaining before=%d after=%d, want decrease", before.MonthlyRemaining, after.MonthlyRemaining)
	}
}

func TestDocumentAskRejectsForeignAndExpiredDocuments(t *testing.T) {
	server, objects := newDocumentTestServer(t, nil)
	ownerToken := registerAndTokenWithEmail(t, server, "owner@example.com")
	otherToken := registerAndTokenWithEmail(t, server, "other@example.com")
	upload := createDocumentUpload(t, server, ownerToken, "brief.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", 512)
	if err := objects.PutObject(t.Context(), upload.Document.SourceObjectKey, upload.Document.ContentType, minimalDocx("Private text")); err != nil {
		t.Fatalf("put source object: %v", err)
	}
	completeDocument(t, server, ownerToken, upload.Document.ID)

	foreign := httptest.NewRequest(http.MethodPost, "/api/v1/documents/"+upload.Document.ID+"/ask", strings.NewReader(`{"model":"fast","question":"Read it"}`))
	foreign.Header.Set("Authorization", "Bearer "+otherToken)
	foreign.Header.Set("Content-Type", "application/json")
	foreignRecorder := httptest.NewRecorder()
	server.ServeHTTP(foreignRecorder, foreign)
	if foreignRecorder.Code != http.StatusNotFound {
		t.Fatalf("foreign ask status = %d, want 404, body = %s", foreignRecorder.Code, foreignRecorder.Body.String())
	}

	expiredServer, expiredObjects := newDocumentTestServer(t, func(cfg *config.Config) {
		cfg.DocumentTTLHours = -1
	})
	expiredToken := registerAndTokenWithEmail(t, expiredServer, "expired@example.com")
	expiredUpload := createDocumentUpload(t, expiredServer, expiredToken, "expired.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", 512)
	if err := expiredObjects.PutObject(t.Context(), expiredUpload.Document.SourceObjectKey, expiredUpload.Document.ContentType, minimalDocx("Expired text")); err != nil {
		t.Fatalf("put expired source object: %v", err)
	}
	completeDocument(t, expiredServer, expiredToken, expiredUpload.Document.ID)
	expiredAsk := httptest.NewRequest(http.MethodPost, "/api/v1/documents/"+expiredUpload.Document.ID+"/ask", strings.NewReader(`{"model":"fast","question":"Read it"}`))
	expiredAsk.Header.Set("Authorization", "Bearer "+expiredToken)
	expiredAsk.Header.Set("Content-Type", "application/json")
	expiredRecorder := httptest.NewRecorder()
	expiredServer.ServeHTTP(expiredRecorder, expiredAsk)
	if expiredRecorder.Code != http.StatusGone {
		t.Fatalf("expired ask status = %d, want 410, body = %s", expiredRecorder.Code, expiredRecorder.Body.String())
	}
}

func TestAgentRunRequiresAuthAndStreamsPersistedEvents(t *testing.T) {
	server := newTestServer(t)

	unauth := httptest.NewRequest(http.MethodPost, "/api/v1/agent/runs", strings.NewReader(`{"goal":"hello","mode":"fast"}`))
	unauth.Header.Set("Content-Type", "application/json")
	unauthRecorder := httptest.NewRecorder()
	server.ServeHTTP(unauthRecorder, unauth)
	if unauthRecorder.Code != http.StatusUnauthorized {
		t.Fatalf("unauth agent run status = %d, want 401", unauthRecorder.Code)
	}

	token := registerAndToken(t, server)
	before := billingBalance(t, server, token)
	run := createAgentRun(t, server, token, `{"goal":"总结今天的计划","mode":"fast","client_conversation_id":"conv-agent","client_message_id":"msg-agent"}`)
	if run.Status != "queued" || run.Mode != "fast" || run.ID == "" {
		t.Fatalf("agent run = %#v", run)
	}

	stream := httptest.NewRequest(http.MethodGet, "/api/v1/agent/runs/"+run.ID+"/stream", nil)
	stream.Header.Set("Authorization", "Bearer "+token)
	streamRecorder := httptest.NewRecorder()
	server.ServeHTTP(streamRecorder, stream)
	if streamRecorder.Code != http.StatusOK {
		t.Fatalf("agent stream status = %d, body = %s", streamRecorder.Code, streamRecorder.Body.String())
	}
	body := streamRecorder.Body.String()
	for _, want := range []string{"run.created", "run.started", "skill.selected", "llm.started", "llm.delta", "run.completed", "Mock SheJane response", "data: [DONE]"} {
		if !strings.Contains(body, want) {
			t.Fatalf("agent stream missing %q: %s", want, body)
		}
	}
	after := billingBalance(t, server, token)
	if after.MonthlyRemaining >= before.MonthlyRemaining {
		t.Fatalf("monthly remaining before=%d after=%d, want decrease", before.MonthlyRemaining, after.MonthlyRemaining)
	}

	events := httptest.NewRequest(http.MethodGet, "/api/v1/agent/runs/"+run.ID+"/events", nil)
	events.Header.Set("Authorization", "Bearer "+token)
	eventsRecorder := httptest.NewRecorder()
	server.ServeHTTP(eventsRecorder, events)
	if eventsRecorder.Code != http.StatusOK {
		t.Fatalf("agent events status = %d, body = %s", eventsRecorder.Code, eventsRecorder.Body.String())
	}
	if !strings.Contains(eventsRecorder.Body.String(), `"event_type":"run.completed"`) {
		t.Fatalf("persisted events missing completion: %s", eventsRecorder.Body.String())
	}
	if calls := usageRecords(t, server, token); !strings.Contains(calls, `"scene":"agent"`) {
		t.Fatalf("usage records missing agent scene: %s", calls)
	}
}

func TestAgentLLMGatewayRequiresAuthAndSettlesUsage(t *testing.T) {
	server := newTestServer(t)

	unauth := httptest.NewRequest(http.MethodPost, "/api/v1/agent/llm", strings.NewReader(`{"mode":"fast","messages":[{"role":"user","content":"hello"}]}`))
	unauth.Header.Set("Content-Type", "application/json")
	unauthRecorder := httptest.NewRecorder()
	server.ServeHTTP(unauthRecorder, unauth)
	if unauthRecorder.Code != http.StatusUnauthorized {
		t.Fatalf("unauth agent llm status = %d, want 401", unauthRecorder.Code)
	}

	token := registerAndToken(t, server)
	before := billingBalance(t, server, token)
	body := `{"run_id":"local-run-1","mode":"fast","messages":[{"role":"user","content":"hello from local harness"}],"tools":[{"name":"time.now","description":"time","inputSchema":{"type":"object"},"isReadOnly":true,"isDestructive":false,"isConcurrencySafe":true,"maxResultSize":4096,"permissionPolicy":"allow"}]}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/agent/llm", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()
	server.ServeHTTP(recorder, req)
	if recorder.Code != http.StatusOK {
		t.Fatalf("agent llm status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	var response apiResponse[struct {
		RequestID string `json:"requestId"`
		Content   string `json:"content"`
		ToolCalls []any  `json:"toolCalls"`
	}]
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatalf("decode agent llm response: %v", err)
	}
	if response.Data.RequestID == "" || !strings.Contains(response.Data.Content, "Mock SheJane response") {
		t.Fatalf("unexpected agent llm response: %#v", response.Data)
	}
	if len(response.Data.ToolCalls) != 0 {
		t.Fatalf("mock gateway should not return tool calls: %#v", response.Data.ToolCalls)
	}
	after := billingBalance(t, server, token)
	if after.MonthlyRemaining >= before.MonthlyRemaining {
		t.Fatalf("monthly remaining before=%d after=%d, want decrease", before.MonthlyRemaining, after.MonthlyRemaining)
	}
	if calls := usageRecords(t, server, token); !strings.Contains(calls, `"scene":"agent_local"`) {
		t.Fatalf("usage records missing agent_local scene: %s", calls)
	}
}

func TestAgentToolCapabilitiesRequireAuthAndHideUnconfiguredTavily(t *testing.T) {
	server := newTestServer(t)

	unauth := httptest.NewRequest(http.MethodGet, "/api/v1/agent/tool-capabilities", nil)
	unauthRecorder := httptest.NewRecorder()
	server.ServeHTTP(unauthRecorder, unauth)
	if unauthRecorder.Code != http.StatusUnauthorized {
		t.Fatalf("unauth capabilities status = %d, want 401", unauthRecorder.Code)
	}

	token := registerAndToken(t, server)
	req := httptest.NewRequest(http.MethodGet, "/api/v1/agent/tool-capabilities", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	recorder := httptest.NewRecorder()
	server.ServeHTTP(recorder, req)
	if recorder.Code != http.StatusOK {
		t.Fatalf("capabilities status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if strings.Contains(recorder.Body.String(), "tvly") || strings.Contains(recorder.Body.String(), "api_key") {
		t.Fatalf("capabilities leaked secret-like data: %s", recorder.Body.String())
	}
	if !strings.Contains(recorder.Body.String(), `"web.search"`) || !strings.Contains(recorder.Body.String(), `"configured":false`) {
		t.Fatalf("capabilities missing disabled web.search: %s", recorder.Body.String())
	}
}

func TestAgentToolGatewayExecutesTavilySearchAndChargesCredits(t *testing.T) {
	var tavilyRequests int
	var authHeader string
	tavily := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		tavilyRequests++
		authHeader = r.Header.Get("Authorization")
		if r.Method != http.MethodPost || r.URL.Path != "/search" {
			t.Fatalf("unexpected Tavily request %s %s", r.Method, r.URL.Path)
		}
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatalf("decode Tavily body: %v", err)
		}
		if body["query"] != "agent harness" || body["max_results"] != float64(2) {
			t.Fatalf("Tavily body = %#v", body)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"answer": "Agent harnesses wrap models with tools.",
			"results": []map[string]any{
				{"title": "Harness docs", "url": "https://example.com/harness", "content": "Tools and state.", "score": 0.9},
				{"title": "Agent docs", "url": "https://example.com/agent", "content": "Loops and guardrails.", "score": 0.8},
			},
		})
	}))
	defer tavily.Close()
	server := newTestServerWithConfig(t, func(cfg *config.Config) {
		cfg.AdminEmails = []string{"admin@example.com"}
		cfg.TavilyAPIKey = "tvly-cloud-secret"
		cfg.TavilyBaseURL = tavily.URL
		cfg.TavilySearchCredits = 20
	})
	token := registerAndToken(t, server)
	before := billingBalance(t, server, token)

	body := `{"run_id":"local-run-1","tool_call_id":"call-search-1","tool":"web.search","arguments":{"query":"agent harness","maxResults":2},"idempotency_key":"local-run-1:call-search-1"}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/agent/tools/execute", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()
	server.ServeHTTP(recorder, req)
	if recorder.Code != http.StatusOK {
		t.Fatalf("tool execute status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if authHeader != "Bearer tvly-cloud-secret" {
		t.Fatalf("Tavily auth header = %q", authHeader)
	}
	if tavilyRequests != 1 {
		t.Fatalf("Tavily requests = %d, want 1", tavilyRequests)
	}
	if strings.Contains(recorder.Body.String(), "tvly-cloud-secret") {
		t.Fatalf("tool response leaked Tavily key: %s", recorder.Body.String())
	}
	if !strings.Contains(recorder.Body.String(), `"provider":"tavily"`) || !strings.Contains(recorder.Body.String(), `"credits_cost":20`) {
		t.Fatalf("tool response missing provider/usage: %s", recorder.Body.String())
	}
	after := billingBalance(t, server, token)
	if before.MonthlyRemaining-after.MonthlyRemaining != 20 {
		t.Fatalf("monthly remaining before=%d after=%d, want cost 20", before.MonthlyRemaining, after.MonthlyRemaining)
	}
	adminToken := registerAndTokenWithEmail(t, server, "admin@example.com")
	adminBody := adminToolCallsBody(t, server, adminToken)
	if !strings.Contains(adminBody, `"tool":"web.search"`) || !strings.Contains(adminBody, `"provider":"tavily"`) {
		t.Fatalf("admin tool calls missing web.search record: %s", adminBody)
	}
}

func TestAgentToolGatewayDoesNotDoubleChargeIdempotentRetry(t *testing.T) {
	var tavilyRequests int
	tavily := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		tavilyRequests++
		_ = json.NewEncoder(w).Encode(map[string]any{
			"results": []map[string]any{{"title": "Once", "url": "https://example.com/once", "content": "One result."}},
		})
	}))
	defer tavily.Close()
	server := newTestServerWithConfig(t, func(cfg *config.Config) {
		cfg.TavilyAPIKey = "tvly-cloud-secret"
		cfg.TavilyBaseURL = tavily.URL
		cfg.TavilySearchCredits = 20
	})
	token := registerAndToken(t, server)
	body := `{"run_id":"local-run-2","tool_call_id":"call-search-2","tool":"web.search","arguments":{"query":"agent harness"},"idempotency_key":"same-call"}`

	before := billingBalance(t, server, token)
	for i := 0; i < 2; i++ {
		req := httptest.NewRequest(http.MethodPost, "/api/v1/agent/tools/execute", strings.NewReader(body))
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set("Content-Type", "application/json")
		recorder := httptest.NewRecorder()
		server.ServeHTTP(recorder, req)
		if recorder.Code != http.StatusOK {
			t.Fatalf("retry %d status = %d, body = %s", i, recorder.Code, recorder.Body.String())
		}
	}
	after := billingBalance(t, server, token)
	if tavilyRequests != 1 {
		t.Fatalf("Tavily requests = %d, want 1", tavilyRequests)
	}
	if before.MonthlyRemaining-after.MonthlyRemaining != 20 {
		t.Fatalf("monthly remaining before=%d after=%d, want one charge", before.MonthlyRemaining, after.MonthlyRemaining)
	}
}

func TestAgentToolGatewayReleasesCreditsWhenTavilyFails(t *testing.T) {
	tavily := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, strings.Repeat("provider failed ", 100), http.StatusBadGateway)
	}))
	defer tavily.Close()
	server := newTestServerWithConfig(t, func(cfg *config.Config) {
		cfg.TavilyAPIKey = "tvly-cloud-secret"
		cfg.TavilyBaseURL = tavily.URL
		cfg.TavilySearchCredits = 20
	})
	token := registerAndToken(t, server)
	before := billingBalance(t, server, token)

	body := `{"run_id":"local-run-3","tool_call_id":"call-search-3","tool":"web.search","arguments":{"query":"agent harness"},"idempotency_key":"failing-call"}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/agent/tools/execute", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()
	server.ServeHTTP(recorder, req)
	if recorder.Code != http.StatusBadGateway {
		t.Fatalf("tool execute status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if strings.Contains(recorder.Body.String(), strings.Repeat("provider failed ", 20)) {
		t.Fatalf("provider error body was not truncated: %s", recorder.Body.String())
	}
	after := billingBalance(t, server, token)
	if after.MonthlyRemaining != before.MonthlyRemaining {
		t.Fatalf("monthly remaining before=%d after=%d, want release", before.MonthlyRemaining, after.MonthlyRemaining)
	}
}

func TestAgentLLMGatewayReturnsPaymentRequiredWhenSettlementExceedsBalance(t *testing.T) {
	cfg := config.Default()
	cfg.JWTSecret = "test-secret"
	cfg.MockLLM = true
	cfg.MonthlyCredits = 400
	memory := store.NewMemoryStore()
	service := app.New(cfg, memory)
	highUsage := highUsageProvider{name: "deepseek-fast"}
	service.Router = llm.NewRouterWithModels(highUsage, "deepseek-test", highUsage, "deepseek-test")
	server := NewServer(service)

	token := registerAndToken(t, server)
	body := `{"run_id":"local-run-1","mode":"fast","messages":[{"role":"user","content":"hello"}],"tools":[]}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/agent/llm", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()

	server.ServeHTTP(recorder, req)

	if recorder.Code != http.StatusPaymentRequired {
		t.Fatalf("agent llm status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if !strings.Contains(recorder.Body.String(), "额度不足") {
		t.Fatalf("agent llm body missing quota message: %s", recorder.Body.String())
	}
}

func TestAgentToolEventsRequiresAuthAndAcceptsRedactedSummaries(t *testing.T) {
	server := newTestServer(t)

	unauth := httptest.NewRequest(http.MethodPost, "/api/v1/agent/tool-events", strings.NewReader(`{"events":[]}`))
	unauth.Header.Set("Content-Type", "application/json")
	unauthRecorder := httptest.NewRecorder()
	server.ServeHTTP(unauthRecorder, unauth)
	if unauthRecorder.Code != http.StatusUnauthorized {
		t.Fatalf("unauth tool events status = %d, want 401", unauthRecorder.Code)
	}

	token := registerAndToken(t, server)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/agent/tool-events", strings.NewReader(`{"run_id":"local-run-1","events":[{"tool":"file.read","status":"failed","error_code":"path_outside_workspace","duration_ms":12}]}`))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()
	server.ServeHTTP(recorder, req)
	if recorder.Code != http.StatusAccepted {
		t.Fatalf("tool events status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if !strings.Contains(recorder.Body.String(), `"accepted":true`) || !strings.Contains(recorder.Body.String(), `"count":1`) {
		t.Fatalf("tool events response should acknowledge count without echoing payload: %s", recorder.Body.String())
	}
}

func TestAgentRunWithDocumentAttachmentEmitsDocumentToolEvents(t *testing.T) {
	server, objects := newDocumentTestServer(t, nil)
	token := registerAndToken(t, server)
	upload := createDocumentUpload(t, server, token, "brief.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", 512)
	if err := objects.PutObject(t.Context(), upload.Document.SourceObjectKey, upload.Document.ContentType, minimalDocx("The roadmap risk is delayed billing.")); err != nil {
		t.Fatalf("put source object: %v", err)
	}
	completeDocument(t, server, token, upload.Document.ID)

	run := createAgentRun(t, server, token, `{"goal":"这份文档最大的风险是什么？","mode":"fast","attachments":[{"type":"document","document_id":"`+upload.Document.ID+`","name":"brief.docx"}]}`)
	stream := httptest.NewRequest(http.MethodGet, "/api/v1/agent/runs/"+run.ID+"/stream", nil)
	stream.Header.Set("Authorization", "Bearer "+token)
	streamRecorder := httptest.NewRecorder()
	server.ServeHTTP(streamRecorder, stream)
	if streamRecorder.Code != http.StatusOK {
		t.Fatalf("agent document stream status = %d, body = %s", streamRecorder.Code, streamRecorder.Body.String())
	}
	body := streamRecorder.Body.String()
	for _, want := range []string{"document-analysis", "document.read", "tool.requested", "tool.completed", "run.completed"} {
		if !strings.Contains(body, want) {
			t.Fatalf("agent document stream missing %q: %s", want, body)
		}
	}
}

func TestAgentRunCanBeCanceledBeforeStream(t *testing.T) {
	server := newTestServer(t)
	token := registerAndToken(t, server)
	run := createAgentRun(t, server, token, `{"goal":"稍后再做","mode":"fast"}`)

	cancel := httptest.NewRequest(http.MethodPost, "/api/v1/agent/runs/"+run.ID+"/cancel", nil)
	cancel.Header.Set("Authorization", "Bearer "+token)
	cancelRecorder := httptest.NewRecorder()
	server.ServeHTTP(cancelRecorder, cancel)
	if cancelRecorder.Code != http.StatusOK {
		t.Fatalf("cancel status = %d, body = %s", cancelRecorder.Code, cancelRecorder.Body.String())
	}
	if !strings.Contains(cancelRecorder.Body.String(), `"status":"canceled"`) {
		t.Fatalf("cancel response missing status: %s", cancelRecorder.Body.String())
	}

	stream := httptest.NewRequest(http.MethodGet, "/api/v1/agent/runs/"+run.ID+"/stream", nil)
	stream.Header.Set("Authorization", "Bearer "+token)
	streamRecorder := httptest.NewRecorder()
	server.ServeHTTP(streamRecorder, stream)
	if streamRecorder.Code != http.StatusOK {
		t.Fatalf("canceled stream status = %d, body = %s", streamRecorder.Code, streamRecorder.Body.String())
	}
	if strings.Contains(streamRecorder.Body.String(), "llm.delta") || !strings.Contains(streamRecorder.Body.String(), "run.canceled") {
		t.Fatalf("canceled stream should replay cancel without llm: %s", streamRecorder.Body.String())
	}
}

func TestAdminCanObserveAgentRunsReadOnly(t *testing.T) {
	server := newTestServerWithConfig(t, func(cfg *config.Config) {
		cfg.AdminEmails = []string{"admin@example.com"}
	})
	adminToken := registerAndTokenWithEmail(t, server, "admin@example.com")
	userToken := registerAndTokenWithEmail(t, server, "agent-user@example.com")
	run := createAgentRun(t, server, userToken, `{"goal":"给我一个摘要，但不要在后台暴露完整正文","mode":"fast"}`)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/admin/agent-runs", nil)
	req.Header.Set("Authorization", "Bearer "+adminToken)
	recorder := httptest.NewRecorder()
	server.ServeHTTP(recorder, req)
	if recorder.Code != http.StatusOK {
		t.Fatalf("admin agent runs status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	body := recorder.Body.String()
	if !strings.Contains(body, run.ID) || !strings.Contains(body, "agent-user@example.com") || !strings.Contains(body, `"status":"queued"`) {
		t.Fatalf("admin agent runs missing run summary: %s", body)
	}
	if strings.Contains(body, "完整正文") {
		t.Fatalf("admin agent runs should expose summaries, not full raw goal: %s", body)
	}
}

func TestAdminOriginAllowedByCORS(t *testing.T) {
	server := newTestServerWithConfig(t, func(cfg *config.Config) {
		cfg.ClientBaseURL = "https://app.example.com"
		cfg.AdminBaseURL = "https://admin.example.com"
	})

	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	req.Header.Set("Origin", "https://admin.example.com")
	recorder := httptest.NewRecorder()

	server.ServeHTTP(recorder, req)

	if got := recorder.Header().Get("Access-Control-Allow-Origin"); got != "https://admin.example.com" {
		t.Fatalf("admin cors origin = %q, want admin origin", got)
	}
}

func TestAdminOverviewRequiresAdminRole(t *testing.T) {
	server := newTestServer(t)
	token := registerAndToken(t, server)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/admin/overview", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	recorder := httptest.NewRecorder()

	server.ServeHTTP(recorder, req)

	if recorder.Code != http.StatusForbidden {
		t.Fatalf("admin overview status = %d, want 403, body = %s", recorder.Code, recorder.Body.String())
	}
}

func TestAdminEmailCanAccessOverviewAndProviderStatusDoesNotExposeSecrets(t *testing.T) {
	server := newTestServerWithConfig(t, func(cfg *config.Config) {
		cfg.AdminEmails = []string{"admin@example.com"}
		cfg.MockLLM = false
		cfg.FastProviderKind = string(llm.ProviderKindDeepSeekV4)
		cfg.FastProviderAPIKey = "secret-fast-key"
		cfg.DeepProviderKind = string(llm.ProviderKindOpenAICompatible)
		cfg.DeepProviderBaseURL = "https://api.deepseek.com"
		cfg.DeepProviderAPIKey = "secret-deep-key"
		cfg.DeepModel = "deepseek-v4-pro"
	})
	token := registerAndTokenWithEmail(t, server, "admin@example.com")

	overview := httptest.NewRequest(http.MethodGet, "/api/v1/admin/overview", nil)
	overview.Header.Set("Authorization", "Bearer "+token)
	overviewRecorder := httptest.NewRecorder()
	server.ServeHTTP(overviewRecorder, overview)
	if overviewRecorder.Code != http.StatusOK {
		t.Fatalf("admin overview status = %d, body = %s", overviewRecorder.Code, overviewRecorder.Body.String())
	}

	providers := httptest.NewRequest(http.MethodGet, "/api/v1/admin/providers", nil)
	providers.Header.Set("Authorization", "Bearer "+token)
	providersRecorder := httptest.NewRecorder()
	server.ServeHTTP(providersRecorder, providers)
	if providersRecorder.Code != http.StatusOK {
		t.Fatalf("admin providers status = %d, body = %s", providersRecorder.Code, providersRecorder.Body.String())
	}
	body := providersRecorder.Body.String()
	if strings.Contains(body, "secret-fast-key") || strings.Contains(body, "secret-deep-key") {
		t.Fatalf("provider status leaked API key: %s", body)
	}
	if !strings.Contains(body, `"api_key_configured":true`) {
		t.Fatalf("provider status missing key configured flag: %s", body)
	}
	if !strings.Contains(body, `"kind":"deepseek-v4"`) || !strings.Contains(body, `"kind":"openai-compatible"`) {
		t.Fatalf("provider status missing provider kind: %s", body)
	}
}

func TestExistingAdminEmailPromotesOnLoginAndRefresh(t *testing.T) {
	cfg := config.Default()
	cfg.JWTSecret = "test-secret"
	cfg.MockLLM = true
	cfg.MonthlyCredits = 10_000
	memory := store.NewMemoryStore()
	server := NewServer(app.New(cfg, memory))

	registerCookie := func(email string) *http.Cookie {
		t.Helper()
		register := httptest.NewRequest(http.MethodPost, "/api/v1/auth/register", strings.NewReader(`{"email":"`+email+`","password":"secret123","name":"Ops"}`))
		register.Header.Set("Content-Type", "application/json")
		registerRecorder := httptest.NewRecorder()
		server.ServeHTTP(registerRecorder, register)
		if registerRecorder.Code != http.StatusCreated {
			t.Fatalf("register %s status = %d, body = %s", email, registerRecorder.Code, registerRecorder.Body.String())
		}
		for _, cookie := range registerRecorder.Result().Cookies() {
			if cookie.Name == refreshCookieName {
				return cookie
			}
		}
		t.Fatalf("register %s did not set refresh cookie", email)
		return nil
	}
	refreshCookie := registerCookie("ops-refresh@example.com")
	registerCookie("ops-login@example.com")

	cfg.AdminEmails = []string{"ops-login@example.com", "ops-refresh@example.com"}
	server = NewServer(app.New(cfg, memory))

	login := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login", strings.NewReader(`{"email":"ops-login@example.com","password":"secret123"}`))
	login.Header.Set("Content-Type", "application/json")
	loginRecorder := httptest.NewRecorder()
	server.ServeHTTP(loginRecorder, login)
	if loginRecorder.Code != http.StatusOK {
		t.Fatalf("login status = %d, body = %s", loginRecorder.Code, loginRecorder.Body.String())
	}
	var loginBody apiResponse[authPayload]
	if err := json.Unmarshal(loginRecorder.Body.Bytes(), &loginBody); err != nil {
		t.Fatalf("decode login response: %v", err)
	}
	if loginBody.Data.User.Role != "admin" {
		t.Fatalf("login role = %q, want admin", loginBody.Data.User.Role)
	}

	refresh := httptest.NewRequest(http.MethodPost, "/api/v1/auth/refresh", nil)
	refresh.AddCookie(refreshCookie)
	refreshRecorder := httptest.NewRecorder()
	server.ServeHTTP(refreshRecorder, refresh)
	if refreshRecorder.Code != http.StatusOK {
		t.Fatalf("refresh status = %d, body = %s", refreshRecorder.Code, refreshRecorder.Body.String())
	}
	var refreshBody apiResponse[authPayload]
	if err := json.Unmarshal(refreshRecorder.Body.Bytes(), &refreshBody); err != nil {
		t.Fatalf("decode refresh response: %v", err)
	}
	if refreshBody.Data.User.Role != "admin" {
		t.Fatalf("refresh role = %q, want admin", refreshBody.Data.User.Role)
	}
}

func TestAdminCanDisableUserAndDisabledTokenIsRejected(t *testing.T) {
	server := newTestServerWithConfig(t, func(cfg *config.Config) {
		cfg.AdminEmails = []string{"admin@example.com"}
	})
	adminToken := registerAndTokenWithEmail(t, server, "admin@example.com")
	userToken := registerAndTokenWithEmail(t, server, "disabled@example.com")
	user := currentUser(t, server, userToken)

	disable := httptest.NewRequest(http.MethodPatch, "/api/v1/admin/users/"+user.ID+"/status", strings.NewReader(`{"status":"disabled","reason":"abuse report"}`))
	disable.Header.Set("Authorization", "Bearer "+adminToken)
	disable.Header.Set("Content-Type", "application/json")
	disableRecorder := httptest.NewRecorder()
	server.ServeHTTP(disableRecorder, disable)
	if disableRecorder.Code != http.StatusOK {
		t.Fatalf("disable user status = %d, body = %s", disableRecorder.Code, disableRecorder.Body.String())
	}

	me := httptest.NewRequest(http.MethodGet, "/api/v1/user/me", nil)
	me.Header.Set("Authorization", "Bearer "+userToken)
	meRecorder := httptest.NewRecorder()
	server.ServeHTTP(meRecorder, me)
	if meRecorder.Code != http.StatusUnauthorized {
		t.Fatalf("disabled user me status = %d, want 401, body = %s", meRecorder.Code, meRecorder.Body.String())
	}

	login := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login", strings.NewReader(`{"email":"disabled@example.com","password":"secret123"}`))
	login.Header.Set("Content-Type", "application/json")
	loginRecorder := httptest.NewRecorder()
	server.ServeHTTP(loginRecorder, login)
	if loginRecorder.Code != http.StatusUnauthorized {
		t.Fatalf("disabled user login status = %d, want 401, body = %s", loginRecorder.Code, loginRecorder.Body.String())
	}
}

func TestAdminCannotDisableSelf(t *testing.T) {
	server := newTestServerWithConfig(t, func(cfg *config.Config) {
		cfg.AdminEmails = []string{"admin@example.com"}
	})
	adminToken := registerAndTokenWithEmail(t, server, "admin@example.com")
	admin := currentUser(t, server, adminToken)

	req := httptest.NewRequest(http.MethodPatch, "/api/v1/admin/users/"+admin.ID+"/status", strings.NewReader(`{"status":"disabled","reason":"mistake"}`))
	req.Header.Set("Authorization", "Bearer "+adminToken)
	req.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()
	server.ServeHTTP(recorder, req)

	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("disable self status = %d, want 400, body = %s", recorder.Code, recorder.Body.String())
	}
}

func TestAdminAdjustsExtraCreditsWithTransactionAndAudit(t *testing.T) {
	server, memory := newTestServerAndStore(t, func(cfg *config.Config) {
		cfg.AdminEmails = []string{"admin@example.com"}
	})
	adminToken := registerAndTokenWithEmail(t, server, "admin@example.com")
	userToken := registerAndTokenWithEmail(t, server, "credits@example.com")
	user := currentUser(t, server, userToken)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/admin/users/"+user.ID+"/credits/adjust", strings.NewReader(`{"delta":1500,"reason":"customer support credit"}`))
	req.Header.Set("Authorization", "Bearer "+adminToken)
	req.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()
	server.ServeHTTP(recorder, req)
	if recorder.Code != http.StatusOK {
		t.Fatalf("adjust credits status = %d, body = %s", recorder.Code, recorder.Body.String())
	}

	detail := adminUserDetail(t, server, adminToken, user.ID)
	if detail.Wallet.ExtraCreditsBalance != 1500 {
		t.Fatalf("extra credits = %d, want 1500", detail.Wallet.ExtraCreditsBalance)
	}
	if len(detail.Transactions) == 0 || detail.Transactions[0].Type != "admin_adjust" {
		t.Fatalf("missing admin_adjust transaction: %#v", detail.Transactions)
	}
	if !memory.HasAuditLog("admin.extra_credit_adjust", user.ID) {
		t.Fatal("missing admin.extra_credit_adjust audit log")
	}

	negative := httptest.NewRequest(http.MethodPost, "/api/v1/admin/users/"+user.ID+"/credits/adjust", strings.NewReader(`{"delta":-2000,"reason":"correction"}`))
	negative.Header.Set("Authorization", "Bearer "+adminToken)
	negative.Header.Set("Content-Type", "application/json")
	negativeRecorder := httptest.NewRecorder()
	server.ServeHTTP(negativeRecorder, negative)
	if negativeRecorder.Code != http.StatusBadRequest {
		t.Fatalf("negative adjust status = %d, want 400, body = %s", negativeRecorder.Code, negativeRecorder.Body.String())
	}
	unchanged := adminUserDetail(t, server, adminToken, user.ID)
	if unchanged.Wallet.ExtraCreditsBalance != 1500 {
		t.Fatalf("extra credits after rejected adjust = %d, want 1500", unchanged.Wallet.ExtraCreditsBalance)
	}
}

func TestStripeCheckoutCompletedStoresSubscriptionAndIsIdempotent(t *testing.T) {
	server := newTestServerWithConfig(t, func(cfg *config.Config) {
		cfg.AdminEmails = []string{"admin@example.com"}
		cfg.MonthlyCredits = 12345
	})
	adminToken := registerAndTokenWithEmail(t, server, "admin@example.com")
	userToken := registerAndTokenWithEmail(t, server, "paid@example.com")

	order := createSubscriptionCheckout(t, server, userToken)
	postStripeWebhook(t, server, stripeEvent("evt_checkout_1", "checkout.session.completed", map[string]any{
		"id":             order.StripeSessionID,
		"subscription":   "sub_test_123",
		"payment_status": "paid",
		"status":         "complete",
	}))
	postStripeWebhook(t, server, stripeEvent("evt_checkout_1", "checkout.session.completed", map[string]any{
		"id":             order.StripeSessionID,
		"subscription":   "sub_test_123",
		"payment_status": "paid",
		"status":         "complete",
	}))

	balance := billingBalance(t, server, userToken)
	if balance.PlanCode != "pro" {
		t.Fatalf("plan code = %q, want pro", balance.PlanCode)
	}
	if balance.Status != "active" {
		t.Fatalf("wallet status = %q, want active", balance.Status)
	}
	if balance.MonthlyCreditLimit != 12345 {
		t.Fatalf("monthly credit limit = %d, want 12345", balance.MonthlyCreditLimit)
	}

	transactions := walletTransactions(t, server, userToken)
	grants := 0
	for _, tx := range transactions {
		if tx.Type == "subscription_grant" {
			grants++
		}
	}
	if grants != 1 {
		t.Fatalf("subscription grants = %d, want 1, transactions = %#v", grants, transactions)
	}

	orders := adminOrdersBody(t, server, adminToken)
	if !strings.Contains(orders, `"stripe_subscription_id":"sub_test_123"`) {
		t.Fatalf("admin orders missing subscription id: %s", orders)
	}
	if !strings.Contains(orders, `"status":"paid"`) {
		t.Fatalf("admin orders missing paid status: %s", orders)
	}
}

func TestStripeWebhookRejectsMissingEventIdentity(t *testing.T) {
	server := newTestServer(t)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/payment/webhook", strings.NewReader(`{"data":{"object":{"id":"cs_missing_event"}}}`))
	req.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()

	server.ServeHTTP(recorder, req)

	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("webhook status = %d, want 400, body = %s", recorder.Code, recorder.Body.String())
	}
}

func TestStripeInvoicePaidRenewsMonthlyCreditsOnce(t *testing.T) {
	server := newTestServerWithConfig(t, func(cfg *config.Config) {
		cfg.MonthlyCredits = 9000
	})
	userToken := registerAndTokenWithEmail(t, server, "renew@example.com")
	order := createSubscriptionCheckout(t, server, userToken)
	postStripeWebhook(t, server, stripeEvent("evt_checkout_renew", "checkout.session.completed", map[string]any{
		"id":           order.StripeSessionID,
		"subscription": "sub_renew_123",
	}))

	sendTestChat(t, server, userToken)
	usedBeforeRenewal := billingBalance(t, server, userToken).MonthlyCreditsUsed
	if usedBeforeRenewal == 0 {
		t.Fatal("expected chat to consume monthly credits before renewal")
	}

	postStripeWebhook(t, server, stripeEvent("evt_invoice_cycle_1", "invoice.paid", map[string]any{
		"id":             "in_cycle_1",
		"subscription":   "sub_renew_123",
		"billing_reason": "subscription_cycle",
		"period_end":     1780000000,
	}))
	postStripeWebhook(t, server, stripeEvent("evt_invoice_cycle_1", "invoice.paid", map[string]any{
		"id":             "in_cycle_1",
		"subscription":   "sub_renew_123",
		"billing_reason": "subscription_cycle",
		"period_end":     1780000000,
	}))

	balance := billingBalance(t, server, userToken)
	if balance.MonthlyCreditsUsed != 0 {
		t.Fatalf("monthly credits used after renewal = %d, want 0", balance.MonthlyCreditsUsed)
	}
	if balance.Status != "active" {
		t.Fatalf("wallet status after renewal = %q, want active", balance.Status)
	}
	if balance.MonthlyCreditLimit != 9000 {
		t.Fatalf("monthly credit limit after renewal = %d, want 9000", balance.MonthlyCreditLimit)
	}

	transactions := walletTransactions(t, server, userToken)
	grants := 0
	for _, tx := range transactions {
		if tx.Type == "subscription_grant" {
			grants++
		}
	}
	if grants != 2 {
		t.Fatalf("subscription grants = %d, want checkout + one renewal, transactions = %#v", grants, transactions)
	}
}

func TestStripeSubscriptionFailureAndCancellationUpdateWalletStatus(t *testing.T) {
	server := newTestServer(t)
	userToken := registerAndTokenWithEmail(t, server, "status@example.com")
	order := createSubscriptionCheckout(t, server, userToken)
	postStripeWebhook(t, server, stripeEvent("evt_checkout_status", "checkout.session.completed", map[string]any{
		"id":           order.StripeSessionID,
		"subscription": "sub_status_123",
	}))

	postStripeWebhook(t, server, stripeEvent("evt_invoice_failed_1", "invoice.payment_failed", map[string]any{
		"id":           "in_failed_1",
		"subscription": "sub_status_123",
	}))
	if got := billingBalance(t, server, userToken).Status; got != "past_due" {
		t.Fatalf("wallet status after payment failure = %q, want past_due", got)
	}

	postStripeWebhook(t, server, stripeEvent("evt_sub_deleted_1", "customer.subscription.deleted", map[string]any{
		"id":     "sub_status_123",
		"status": "canceled",
	}))
	if got := billingBalance(t, server, userToken).Status; got != "canceled" {
		t.Fatalf("wallet status after cancellation = %q, want canceled", got)
	}
}

func TestStripeSubscriptionDeletedRevokesMonthlyCreditsButKeepsExtra(t *testing.T) {
	server, _ := newTestServerAndStore(t, func(cfg *config.Config) {
		cfg.MonthlyCredits = 9000
		cfg.AdminEmails = []string{"admin@example.com"}
	})
	adminToken := registerAndTokenWithEmail(t, server, "admin@example.com")
	userToken := registerAndTokenWithEmail(t, server, "cancel-revoke@example.com")
	user := currentUser(t, server, userToken)

	order := createSubscriptionCheckout(t, server, userToken)
	postStripeWebhook(t, server, stripeEvent("evt_checkout_clawback", "checkout.session.completed", map[string]any{
		"id":           order.StripeSessionID,
		"subscription": "sub_clawback_1",
	}))

	// Grant pay-as-you-go extra credits — these must survive cancellation.
	adjust := httptest.NewRequest(http.MethodPost, "/api/v1/admin/users/"+user.ID+"/credits/adjust", strings.NewReader(`{"delta":1500,"reason":"support"}`))
	adjust.Header.Set("Authorization", "Bearer "+adminToken)
	adjust.Header.Set("Content-Type", "application/json")
	adjustRec := httptest.NewRecorder()
	server.ServeHTTP(adjustRec, adjust)
	if adjustRec.Code != http.StatusOK {
		t.Fatalf("adjust credits = %d, body = %s", adjustRec.Code, adjustRec.Body.String())
	}

	sendTestChat(t, server, userToken) // consume part of the monthly allotment
	before := billingBalance(t, server, userToken)
	if before.MonthlyCreditLimit != 9000 {
		t.Fatalf("monthly limit before cancel = %d, want 9000", before.MonthlyCreditLimit)
	}
	if before.ExtraCreditsBalance != 1500 {
		t.Fatalf("extra before cancel = %d, want 1500", before.ExtraCreditsBalance)
	}

	postStripeWebhook(t, server, stripeEvent("evt_sub_deleted_clawback", "customer.subscription.deleted", map[string]any{
		"id": "sub_clawback_1",
	}))

	after := billingBalance(t, server, userToken)
	if after.Status != "canceled" {
		t.Fatalf("status after cancel = %q, want canceled", after.Status)
	}
	if after.PlanCode != "free_trial" {
		t.Fatalf("plan after cancel = %q, want free_trial", after.PlanCode)
	}
	if after.MonthlyCreditLimit != 0 || after.MonthlyCreditsUsed != 0 {
		t.Fatalf("monthly after cancel = %d/%d, want 0/0", after.MonthlyCreditLimit, after.MonthlyCreditsUsed)
	}
	if after.ExtraCreditsBalance != 1500 {
		t.Fatalf("extra after cancel = %d, want 1500 (pay-as-you-go kept)", after.ExtraCreditsBalance)
	}

	revokes := 0
	for _, tx := range walletTransactions(t, server, userToken) {
		if tx.Type == "subscription_revoke" {
			revokes++
		}
	}
	if revokes != 1 {
		t.Fatalf("subscription_revoke ledger entries = %d, want 1", revokes)
	}
}

func TestStripeChargeRefundedWithoutSubscriptionIsAcceptedAsNoOp(t *testing.T) {
	server, _ := newTestServerAndStore(t, func(cfg *config.Config) {
		cfg.MonthlyCredits = 9000
	})
	userToken := registerAndTokenWithEmail(t, server, "refund-noop@example.com")
	order := createSubscriptionCheckout(t, server, userToken)
	postStripeWebhook(t, server, stripeEvent("evt_checkout_refund_noop", "checkout.session.completed", map[string]any{
		"id":           order.StripeSessionID,
		"subscription": "sub_refund_noop_1",
	}))

	// A charge.refunded we can't link back to a subscription must be accepted
	// (HTTP 200 — postStripeWebhook asserts it — so Stripe stops retrying) and
	// must leave the wallet untouched rather than guessing which sub to revoke.
	postStripeWebhook(t, server, stripeEvent("evt_charge_refunded_1", "charge.refunded", map[string]any{
		"id": "ch_unlinked_1",
	}))

	after := billingBalance(t, server, userToken)
	if after.Status != "active" {
		t.Fatalf("status after unlinked refund = %q, want active (unchanged)", after.Status)
	}
	if after.MonthlyCreditLimit != 9000 {
		t.Fatalf("monthly limit after unlinked refund = %d, want 9000 (unchanged)", after.MonthlyCreditLimit)
	}
}

func TestAdminAuditLogsAreReadOnlyAndOrdersExposeSubscriptionID(t *testing.T) {
	server := newTestServerWithConfig(t, func(cfg *config.Config) {
		cfg.AdminEmails = []string{"admin@example.com"}
	})
	adminToken := registerAndTokenWithEmail(t, server, "admin@example.com")
	userToken := registerAndTokenWithEmail(t, server, "audit-target@example.com")
	user := currentUser(t, server, userToken)

	statusUpdate := httptest.NewRequest(http.MethodPatch, "/api/v1/admin/users/"+user.ID+"/status", strings.NewReader(`{"status":"disabled","reason":"support test"}`))
	statusUpdate.Header.Set("Authorization", "Bearer "+adminToken)
	statusUpdate.Header.Set("Content-Type", "application/json")
	statusRecorder := httptest.NewRecorder()
	server.ServeHTTP(statusRecorder, statusUpdate)
	if statusRecorder.Code != http.StatusOK {
		t.Fatalf("status update = %d, body = %s", statusRecorder.Code, statusRecorder.Body.String())
	}

	audit := httptest.NewRequest(http.MethodGet, "/api/v1/admin/audit-logs", nil)
	audit.Header.Set("Authorization", "Bearer "+adminToken)
	auditRecorder := httptest.NewRecorder()
	server.ServeHTTP(auditRecorder, audit)
	if auditRecorder.Code != http.StatusOK {
		t.Fatalf("audit logs status = %d, body = %s", auditRecorder.Code, auditRecorder.Body.String())
	}
	if !strings.Contains(auditRecorder.Body.String(), "admin.user_status_update") {
		t.Fatalf("audit logs missing user status action: %s", auditRecorder.Body.String())
	}

	if body := adminOrdersBody(t, server, adminToken); strings.Contains(body, "secret") {
		t.Fatalf("orders should not expose secrets: %s", body)
	}
}

func newTestServer(t *testing.T) http.Handler {
	t.Helper()
	server, _ := newTestServerAndStore(t, nil)
	return server
}

type highUsageProvider struct {
	name string
}

func (p highUsageProvider) Name() string {
	return p.name
}

func (p highUsageProvider) Stream(ctx context.Context, request llm.ChatRequest, model string) (<-chan llm.Chunk, <-chan error) {
	chunks := make(chan llm.Chunk, 1)
	errs := make(chan error, 1)
	chunks <- llm.Chunk{Text: "expensive response", InputTokens: 300, OutputTokens: 500}
	close(chunks)
	close(errs)
	return chunks, errs
}

func newTestServerWithConfig(t *testing.T, mutate func(*config.Config)) http.Handler {
	t.Helper()
	server, _ := newTestServerAndStore(t, mutate)
	return server
}

func newTestServerAndStore(t *testing.T, mutate func(*config.Config)) (http.Handler, *store.MemoryStore) {
	t.Helper()
	cfg := config.Default()
	cfg.JWTSecret = "test-secret"
	cfg.MockLLM = true
	cfg.MonthlyCredits = 10_000
	if mutate != nil {
		mutate(&cfg)
	}
	memory := store.NewMemoryStore()
	service := app.New(cfg, memory)
	return NewServer(service), memory
}

func newDocumentTestServer(t *testing.T, mutate func(*config.Config)) (http.Handler, *documents.MemoryObjectStorage) {
	t.Helper()
	cfg := config.Default()
	cfg.JWTSecret = "test-secret"
	cfg.MockLLM = true
	cfg.MonthlyCredits = 10_000
	if mutate != nil {
		mutate(&cfg)
	}
	memory := store.NewMemoryStore()
	objects := documents.NewMemoryObjectStorage()
	service := app.New(cfg, memory, app.WithDocumentObjectStorage(objects))
	return NewServer(service), objects
}

func registerAndToken(t *testing.T, server http.Handler) string {
	t.Helper()
	return registerAndTokenWithEmail(t, server, "grace@example.com")
}

func registerAndTokenWithEmail(t *testing.T, server http.Handler, email string) string {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/register", strings.NewReader(`{"email":"`+email+`","password":"secret123","name":"Test User"}`))
	req.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()
	server.ServeHTTP(recorder, req)
	if recorder.Code != http.StatusCreated {
		t.Fatalf("register status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	var body apiResponse[authPayload]
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode register response: %v", err)
	}
	return body.Data.AccessToken
}

func currentUser(t *testing.T, server http.Handler, token string) store.User {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/user/me", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	recorder := httptest.NewRecorder()
	server.ServeHTTP(recorder, req)
	if recorder.Code != http.StatusOK {
		t.Fatalf("me status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	var body apiResponse[store.User]
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode me response: %v", err)
	}
	return body.Data
}

func adminUserDetail(t *testing.T, server http.Handler, token string, userID string) store.AdminUserDetail {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/admin/users/"+userID, nil)
	req.Header.Set("Authorization", "Bearer "+token)
	recorder := httptest.NewRecorder()
	server.ServeHTTP(recorder, req)
	if recorder.Code != http.StatusOK {
		t.Fatalf("admin user detail status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	var body apiResponse[store.AdminUserDetail]
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode admin user detail response: %v", err)
	}
	return body.Data
}

type agentRunTestPayload struct {
	ID     string `json:"id"`
	Status string `json:"status"`
	Mode   string `json:"mode"`
}

func createAgentRun(t *testing.T, server http.Handler, token string, body string) agentRunTestPayload {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/agent/runs", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()
	server.ServeHTTP(recorder, req)
	if recorder.Code != http.StatusCreated {
		t.Fatalf("create agent run status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	var response apiResponse[agentRunTestPayload]
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatalf("decode agent run response: %v", err)
	}
	return response.Data
}

func createSubscriptionCheckout(t *testing.T, server http.Handler, token string) store.PaymentOrder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/billing/subscription/checkout", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	recorder := httptest.NewRecorder()
	server.ServeHTTP(recorder, req)
	if recorder.Code != http.StatusOK {
		t.Fatalf("checkout status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	var body apiResponse[store.PaymentOrder]
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode checkout response: %v", err)
	}
	if body.Data.StripeSessionID == "" {
		t.Fatalf("checkout response missing stripe session id: %#v", body.Data)
	}
	return body.Data
}

func usageRecords(t *testing.T, server http.Handler, token string) string {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/billing/usage", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	recorder := httptest.NewRecorder()
	server.ServeHTTP(recorder, req)
	if recorder.Code != http.StatusOK {
		t.Fatalf("usage status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	return recorder.Body.String()
}

func postStripeWebhook(t *testing.T, server http.Handler, payload string) {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/payment/webhook", strings.NewReader(payload))
	req.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()
	server.ServeHTTP(recorder, req)
	if recorder.Code != http.StatusOK {
		t.Fatalf("webhook status = %d, body = %s, payload = %s", recorder.Code, recorder.Body.String(), payload)
	}
}

func stripeEvent(eventID string, eventType string, object map[string]any) string {
	payload, err := json.Marshal(map[string]any{
		"id":   eventID,
		"type": eventType,
		"data": map[string]any{
			"object": object,
		},
	})
	if err != nil {
		panic(err)
	}
	return string(payload)
}

func billingBalance(t *testing.T, server http.Handler, token string) billing.WalletSnapshot {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/billing/balance", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	recorder := httptest.NewRecorder()
	server.ServeHTTP(recorder, req)
	if recorder.Code != http.StatusOK {
		t.Fatalf("balance status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	var body apiResponse[billing.WalletSnapshot]
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode balance response: %v", err)
	}
	return body.Data
}

func walletTransactions(t *testing.T, server http.Handler, token string) []billing.Transaction {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/billing/transactions", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	recorder := httptest.NewRecorder()
	server.ServeHTTP(recorder, req)
	if recorder.Code != http.StatusOK {
		t.Fatalf("transactions status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	var body apiResponse[[]billing.Transaction]
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode transactions response: %v", err)
	}
	return body.Data
}

func adminOrdersBody(t *testing.T, server http.Handler, token string) string {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/admin/orders", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	recorder := httptest.NewRecorder()
	server.ServeHTTP(recorder, req)
	if recorder.Code != http.StatusOK {
		t.Fatalf("admin orders status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	return recorder.Body.String()
}

func adminToolCallsBody(t *testing.T, server http.Handler, token string) string {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/admin/tool-calls", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	recorder := httptest.NewRecorder()
	server.ServeHTTP(recorder, req)
	if recorder.Code != http.StatusOK {
		t.Fatalf("admin tool calls status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	return recorder.Body.String()
}

func sendTestChat(t *testing.T, server http.Handler, token string) {
	t.Helper()
	body := `{"model":"fast","stream":true,"client_conversation_id":"conv-renew","client_message_id":"msg-renew","scene":"chat","messages":[{"role":"user","content":"hello"}]}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/chat/completions", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()
	server.ServeHTTP(recorder, req)
	if recorder.Code != http.StatusOK {
		t.Fatalf("chat status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
}

type documentUploadPayload struct {
	Document documents.Document     `json:"document"`
	Upload   documents.UploadTarget `json:"upload"`
}

func documentUploadRequest(filename string, contentType string, sizeBytes int64) *http.Request {
	body := fmt.Sprintf(`{"filename":%q,"content_type":%q,"size_bytes":%d}`, filename, contentType, sizeBytes)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/documents/uploads", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	return req
}

func createDocumentUpload(t *testing.T, server http.Handler, token string, filename string, contentType string, sizeBytes int64) documentUploadPayload {
	t.Helper()
	req := documentUploadRequest(filename, contentType, sizeBytes)
	req.Header.Set("Authorization", "Bearer "+token)
	recorder := httptest.NewRecorder()
	server.ServeHTTP(recorder, req)
	if recorder.Code != http.StatusCreated {
		t.Fatalf("create document upload status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	var body apiResponse[documentUploadPayload]
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode document upload: %v", err)
	}
	return body.Data
}

func completeDocument(t *testing.T, server http.Handler, token string, documentID string) documents.Document {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/documents/"+documentID+"/complete", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	recorder := httptest.NewRecorder()
	server.ServeHTTP(recorder, req)
	if recorder.Code != http.StatusOK {
		t.Fatalf("complete document status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	var body apiResponse[documents.Document]
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode complete document: %v", err)
	}
	return body.Data
}

func minimalDocx(text string) []byte {
	var buffer bytes.Buffer
	writer := zip.NewWriter(&buffer)
	file, err := writer.Create("word/document.xml")
	if err != nil {
		panic(err)
	}
	_, _ = file.Write([]byte(`<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>` + text + `</w:t></w:r></w:p></w:body></w:document>`))
	if err := writer.Close(); err != nil {
		panic(err)
	}
	return buffer.Bytes()
}
