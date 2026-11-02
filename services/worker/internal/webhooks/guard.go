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
// metadata), CGNAT, multicast, unspecified or otherwise reserved. IPv6 forms that carry an
// IPv4 address (IPv4-mapped, NAT64, 6to4) are judged by that IPv4 address, so a NAT64 network
// can't be used to reach a private IPv4 host.
func blocked(ip netip.Addr) bool {
	ip = ip.Unmap()
	if embedded, ok := embeddedIPv4(ip); ok {
		return blocked(embedded)
	}
	if ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() ||
		ip.IsMulticast() || ip.IsUnspecified() || ip.IsInterfaceLocalMulticast() {
		return true
	}
	for _, prefix := range reserved {
		if prefix.Contains(ip) {
			return true
		}
	}
	return false
}

var reserved = []netip.Prefix{
	netip.MustParsePrefix("0.0.0.0/8"),      // "this network"
	netip.MustParsePrefix("100.64.0.0/10"),  // CGNAT
	netip.MustParsePrefix("192.0.0.0/24"),   // IETF protocol assignments
	netip.MustParsePrefix("198.18.0.0/15"),  // benchmarking
	netip.MustParsePrefix("240.0.0.0/4"),    // reserved, incl. broadcast
	netip.MustParsePrefix("2001::/32"),      // Teredo (tunnels to an obfuscated IPv4)
	netip.MustParsePrefix("2001:db8::/32"),  // documentation
	netip.MustParsePrefix("64:ff9b:1::/48"), // local-use NAT64
}

var (
	nat64     = netip.MustParsePrefix("64:ff9b::/96")
	sixToFour = netip.MustParsePrefix("2002::/16")
)

// embeddedIPv4 returns the IPv4 address inside a NAT64 (last 32 bits) or 6to4 (bits 16–47)
// address.
func embeddedIPv4(ip netip.Addr) (netip.Addr, bool) {
	b := ip.As16()
	switch {
	case ip.Is6() && nat64.Contains(ip):
		return netip.AddrFrom4([4]byte{b[12], b[13], b[14], b[15]}), true
	case ip.Is6() && sixToFour.Contains(ip):
		return netip.AddrFrom4([4]byte{b[2], b[3], b[4], b[5]}), true
	}
	return netip.Addr{}, false
}

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
