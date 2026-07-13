package secrets

import "testing"

func TestEncryptDecryptRoundTrip(t *testing.T) {
	c := New("a-strong-passphrase")
	if !c.Enabled() {
		t.Fatal("cipher should be enabled with a passphrase")
	}
	ct := c.Encrypt("sk-secret-key")
	if ct == "sk-secret-key" || !IsCiphertext(ct) {
		t.Fatalf("expected ciphertext, got %q", ct)
	}
	if got := c.Decrypt(ct); got != "sk-secret-key" {
		t.Fatalf("decrypt = %q, want sk-secret-key", got)
	}
}

func TestDisabledCipherIsPassthrough(t *testing.T) {
	c := New("")
	if c.Enabled() {
		t.Fatal("cipher should be disabled without a passphrase")
	}
	if got := c.Encrypt("plain"); got != "plain" {
		t.Fatalf("encrypt passthrough = %q", got)
	}
	if got := c.Decrypt("plain"); got != "plain" {
		t.Fatalf("decrypt legacy plaintext = %q", got)
	}
}

func TestWrongKeyDoesNotLeakCiphertext(t *testing.T) {
	ct := New("right-key").Encrypt("sk-secret")
	if got := New("wrong-key").Decrypt(ct); got != "" {
		t.Fatalf("decrypt with wrong key = %q, want empty", got)
	}
	if got := New("").Decrypt(ct); got != "" {
		t.Fatalf("decrypt with disabled cipher = %q, want empty", got)
	}
}

func TestEmptyStaysEmpty(t *testing.T) {
	c := New("key")
	if got := c.Encrypt(""); got != "" {
		t.Fatalf("encrypt empty = %q", got)
	}
}
