package httpapi

import (
	"context"
	"strings"
	"testing"
)

// TestParsePdfgrepOutputLineFormat — pin the line parser against the
// known pdfgrep -n format ("PAGE:snippet"). Documents the contract
// the gateway expects from pdfgrep.
func TestParsePdfgrepOutputLineFormat(t *testing.T) {
	raw := []byte(`1:We propose a new architecture, the Transformer
12:our model achieves a new state of the art
12:in the attention mechanism we used
random-line-without-colon
`)
	got := parsePdfgrepOutput(raw, 20)
	if len(got) != 4 {
		t.Fatalf("got %d matches, want 4", len(got))
	}
	if got[0]["page"] != 1 || !strings.Contains(got[0]["snippet"].(string), "Transformer") {
		t.Fatalf("first match wrong: %+v", got[0])
	}
	if got[1]["page"] != 12 || got[2]["page"] != 12 {
		t.Fatalf("page numbers wrong: %+v %+v", got[1], got[2])
	}
	// Line without colon falls through with page=0 and the raw text
	// as snippet — we don't drop unparseable lines, just degrade.
	if got[3]["page"] != 0 || got[3]["snippet"] != "random-line-without-colon" {
		t.Fatalf("fallback line not preserved: %+v", got[3])
	}
}

// TestParsePdfgrepOutputRespectsLimit — bounds the payload so a
// pathologically common search term doesn't return 10k matches.
func TestParsePdfgrepOutputRespectsLimit(t *testing.T) {
	var b strings.Builder
	for i := 0; i < 50; i++ {
		b.WriteString("1:line\n")
	}
	got := parsePdfgrepOutput([]byte(b.String()), 20)
	if len(got) != 20 {
		t.Fatalf("limit not enforced: got %d, want 20", len(got))
	}
}

// TestRunPdfSearchEmptyQuery — surface a clear error envelope for
// the agent's most likely "I didn't pass query" bug rather than
// shelling out with an empty -F arg (which pdfgrep would interpret
// as "match every line").
func TestRunPdfSearchEmptyQuery(t *testing.T) {
	res := runPdfSearch(context.Background(), []byte("not actually a pdf"), "   ")
	if res.OK {
		t.Fatalf("empty query should return OK=false, got %+v", res)
	}
	if res.ErrorCode != "missing_query" {
		t.Fatalf("wrong errorCode: %q", res.ErrorCode)
	}
}
