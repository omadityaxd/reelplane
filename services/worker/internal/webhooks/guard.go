package webhooks

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/netip"
	"syscall"
	"time"
)

// ErrBlockedAddress is returned when an endpoint resolves to an address the worker must not
// call: webhook URLs are chosen by users, so without this check one could point the worker
// at its own network (cloud metadata service, the database, an admin panel). That is SSRF.
var ErrBlockedAddress = errors.New("webhook URL resolves to a private or local address")

// blocked reports whether ip is loopback, private, link-local (incl. 169.254.169.254 cloud
// metadata), CGNAT, multicast or unspecified.
func blocked(ip netip.Addr) bool {
	ip = ip.Unmap()
	return ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() ||
		ip.IsLinkLocalMulticast() || ip.IsMulticast() || ip.IsUnspecified() ||
		ip.IsInterfaceLocalMulticast() || cgnat.Contains(ip)
}

var cgnat = netip.MustParsePrefix("100.64.0.0/10")

// NewClient returns the HTTP client deliveries use. The address check runs on the IP actually
// being dialled (after DNS), so a hostname that resolves to a private address, or re-resolves
// to one later (DNS rebinding), is refused too. Redirects are not followed: a public endpoint
// could otherwise redirect the worker to a private one.
func NewClient(timeout time.Duration, allowPrivate bool) *http.Client {
	dialer := &net.Dialer{Timeout: timeout}
	if !allowPrivate {
		dialer.Control = func(_, address string, _ syscall.RawConn) error {
			host, _, err := net.SplitHostPort(address)
			if err != nil {
				return err
			}
			ip, err := netip.ParseAddr(host)
			if err != nil {
				return fmt.Errorf("unexpected dial address %q: %w", address, err)
			}
			if blocked(ip) {
				return fmt.Errorf("%w (%s)", ErrBlockedAddress, ip)
			}
			return nil
		}
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = nil // a proxy would dial on our behalf, bypassing the check
	transport.DialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
		return dialer.DialContext(ctx, network, address)
	}
	return &http.Client{
		Timeout:   timeout,
		Transport: transport,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
}
