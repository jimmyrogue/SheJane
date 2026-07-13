package httpapi

import (
	"errors"
	"net"
	"net/http"
	"syscall"
	"time"
)

// errBlockedAddress is returned when an outbound fetch targets a
// non-public address (SSRF guard).
var errBlockedAddress = errors.New("request to a non-public address is blocked")

// isPublicIP reports whether ip is a routable public address. It rejects
// loopback, private (RFC1918 / ULA), link-local (which covers the
// 169.254.169.254 cloud-metadata endpoint), unspecified and multicast
// ranges — the addresses an SSRF payload would target.
func isPublicIP(ip net.IP) bool {
	if ip == nil {
		return false
	}
	return !(ip.IsLoopback() || ip.IsPrivate() || ip.IsUnspecified() ||
		ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsMulticast())
}

// safeDialControl is a net.Dialer.Control hook that rejects connections to
// non-public IPs. It runs AFTER DNS resolution, on the exact address the
// socket will connect to, so it also defeats DNS-rebinding (a host that
// resolves to a public IP at validation time but a private one at connect
// time).
func safeDialControl(_, address string, _ syscall.RawConn) error {
	host, _, err := net.SplitHostPort(address)
	if err != nil {
		return err
	}
	if ip := net.ParseIP(host); ip == nil || !isPublicIP(ip) {
		return errBlockedAddress
	}
	return nil
}

// safeHTTPClient builds an http.Client that refuses to connect to private,
// loopback or link-local addresses. Use it for any outbound fetch of a URL
// supplied by a user or agent. Redirects are bounded and re-validated (a
// public URL can 30x to an internal one; each hop's dial is re-checked).
func safeHTTPClient(timeout time.Duration) *http.Client {
	dialer := &net.Dialer{Timeout: 10 * time.Second, Control: safeDialControl}
	return &http.Client{
		Timeout: timeout,
		Transport: &http.Transport{
			DialContext:           dialer.DialContext,
			TLSHandshakeTimeout:   10 * time.Second,
			ResponseHeaderTimeout: timeout,
		},
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 5 {
				return errors.New("too many redirects")
			}
			if req.URL.Scheme != "http" && req.URL.Scheme != "https" {
				return errBlockedAddress
			}
			return nil
		},
	}
}
