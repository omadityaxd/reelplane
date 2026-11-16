package queue

import (
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
)

func parsed(t *testing.T, databaseURL string) *pgconn.Config {
	t.Helper()
	cc, err := pgconn.ParseConfig(databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	if err := requireVerifiedTLS(cc, databaseURL); err != nil {
		t.Fatal(err)
	}
	return cc
}

func TestRequireVerifiedTLS(t *testing.T) {
	t.Run("local database as given", func(t *testing.T) {
		cc := parsed(t, "postgres://reelplane:reelplane@localhost:54320/reelplane?sslmode=disable")
		if cc.TLSConfig != nil {
			t.Fatal("local database got TLS")
		}
	})

	t.Run("supabase pooler: verified TLS against Supabase's CA, no plain-text fallback", func(t *testing.T) {
		for _, url := range []string{
			"postgresql://postgres.ref:pw@aws-1-eu-central-1.pooler.supabase.com:5432/postgres",
			"postgresql://postgres:pw@db.ref.supabase.co:5432/postgres?sslmode=require",
		} {
			cc := parsed(t, url)
			if cc.TLSConfig == nil || cc.TLSConfig.InsecureSkipVerify || cc.TLSConfig.ServerName != cc.Host {
				t.Fatalf("%s: TLS not verified: %+v", url, cc.TLSConfig)
			}
			if cc.TLSConfig.RootCAs == nil || len(cc.Fallbacks) != 0 {
				t.Fatalf("%s: roots %v, fallbacks %d", url, cc.TLSConfig.RootCAs, len(cc.Fallbacks))
			}
		}
	})

	t.Run("other remote host: verified against system CAs", func(t *testing.T) {
		cc := parsed(t, "postgres://u:p@db.example.com/app")
		if cc.TLSConfig == nil || cc.TLSConfig.InsecureSkipVerify || len(cc.Fallbacks) != 0 {
			t.Fatalf("TLS not verified: %+v", cc.TLSConfig)
		}
	})

	t.Run("explicit sslmode=disable is kept", func(t *testing.T) {
		if cc := parsed(t, "postgres://u:p@postgres:5432/app?sslmode=disable"); cc.TLSConfig != nil {
			t.Fatal("sslmode=disable got TLS")
		}
	})
}
