package queue

import (
	"crypto/tls"
	"crypto/x509"
	_ "embed"
	"errors"
	"fmt"
	"net/url"
	"strings"

	"github.com/jackc/pgx/v5/pgconn"
)

// supabaseRootCA signs Supabase's Postgres and pooler certificates; it is not a public CA.
// The same file as packages/db/src/supabase-ca.ts (a test there keeps the two identical).
//
//go:embed supabase-ca.pem
var supabaseRootCA []byte

var localHosts = map[string]bool{"localhost": true, "127.0.0.1": true, "::1": true}

// requireVerifiedTLS makes a remote database reachable only over TLS with a verified certificate.
// pgx's default (sslmode=prefer) encrypts without checking who answers, and falls back to plain
// text. A database on this machine, or a URL with an explicit sslmode=disable, is left as is.
// Mirrors connectionConfig in packages/db/src/pool.ts.
func requireVerifiedTLS(cc *pgconn.Config, databaseURL string) error {
	if u, err := url.Parse(databaseURL); err == nil && u.Query().Get("sslmode") == "disable" {
		return nil
	}
	if localHosts[cc.Host] || strings.HasPrefix(cc.Host, "/") {
		return nil
	}
	var roots *x509.CertPool
	if strings.HasSuffix(cc.Host, ".supabase.co") || strings.HasSuffix(cc.Host, ".supabase.com") {
		roots = x509.NewCertPool()
		if !roots.AppendCertsFromPEM(supabaseRootCA) {
			return errors.New("embedded Supabase root CA is not a valid certificate")
		}
	} else {
		var err error
		if roots, err = x509.SystemCertPool(); err != nil {
			return fmt.Errorf("load system CAs for %s: %w", cc.Host, err)
		}
	}
	cc.TLSConfig = &tls.Config{RootCAs: roots, ServerName: cc.Host, MinVersion: tls.VersionTLS12}
	cc.Fallbacks = nil // no plain-text retry
	return nil
}
