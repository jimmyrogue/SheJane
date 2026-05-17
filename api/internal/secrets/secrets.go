// Package secrets provides at-rest encryption for sensitive config values
// (model API keys). When no key is configured it degrades to a transparent
// pass-through so the system still works in dev / MVP.
package secrets

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"io"
	"strings"
)

const cipherPrefix = "enc:v1:"

// Cipher encrypts/decrypts short secrets with AES-256-GCM. The 32-byte key is
// derived from the configured passphrase via SHA-256 so any-length input works.
type Cipher struct {
	key     []byte
	enabled bool
}

func New(passphrase string) *Cipher {
	if strings.TrimSpace(passphrase) == "" {
		return &Cipher{}
	}
	sum := sha256.Sum256([]byte(passphrase))
	return &Cipher{key: sum[:], enabled: true}
}

// Enabled reports whether real encryption is active.
func (c *Cipher) Enabled() bool { return c.enabled }

// Encrypt returns ciphertext for storage. Empty input stays empty. When no key
// is configured the plaintext is returned unchanged (and stored as-is).
func (c *Cipher) Encrypt(plaintext string) string {
	if plaintext == "" || !c.enabled {
		return plaintext
	}
	block, err := aes.NewCipher(c.key)
	if err != nil {
		return plaintext
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return plaintext
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return plaintext
	}
	sealed := gcm.Seal(nonce, nonce, []byte(plaintext), nil)
	return cipherPrefix + base64.StdEncoding.EncodeToString(sealed)
}

// Decrypt reverses Encrypt. Values without the cipher prefix are treated as
// legacy/plaintext and returned unchanged. A value that cannot be decrypted
// (wrong/missing key) yields an empty string rather than leaking ciphertext.
func (c *Cipher) Decrypt(stored string) string {
	if !strings.HasPrefix(stored, cipherPrefix) {
		return stored
	}
	if !c.enabled {
		return ""
	}
	raw, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(stored, cipherPrefix))
	if err != nil {
		return ""
	}
	block, err := aes.NewCipher(c.key)
	if err != nil {
		return ""
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return ""
	}
	if len(raw) < gcm.NonceSize() {
		return ""
	}
	nonce, ct := raw[:gcm.NonceSize()], raw[gcm.NonceSize():]
	plain, err := gcm.Open(nil, nonce, ct, nil)
	if err != nil {
		return ""
	}
	return string(plain)
}

// IsCiphertext reports whether the stored value is an encrypted blob.
func IsCiphertext(stored string) bool {
	return strings.HasPrefix(stored, cipherPrefix)
}
