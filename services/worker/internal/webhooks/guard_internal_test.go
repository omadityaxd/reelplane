package webhooks

import (
	"net/netip"
	"testing"
)

func TestBlocked(t *testing.T) {
	for address, want := range map[string]bool{
		"8.8.8.8":              false,
		"2606:4700:4700::1111": false,
		"127.0.0.1":            true,
		"10.1.2.3":             true,
		"192.168.1.12":         true,
		"169.254.169.254":      true,
		"100.64.0.1":           true,
		"0.0.0.1":              true,
		"198.18.0.1":           true,
		"255.255.255.255":      true,
		"::1":                  true,
		"fd00::1":              true,
		"fe80::1":              true,
		"::ffff:10.0.0.1":      true,  // IPv4-mapped
		"64:ff9b::a00:1":       true,  // NAT64 of 10.0.0.1
		"64:ff9b::808:808":     false, // NAT64 of 8.8.8.8
		"2002:a9fe:a9fe::1":    true,  // 6to4 of 169.254.169.254
		"2002:808:808::1":      false, // 6to4 of 8.8.8.8
		"2001:0:4136:e378::1":  true,  // Teredo
	} {
		if got := blocked(netip.MustParseAddr(address)); got != want {
			t.Errorf("blocked(%s) = %v, want %v", address, got, want)
		}
	}
}
