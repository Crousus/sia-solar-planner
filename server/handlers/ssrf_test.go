// Solar Planner - Frontend web application for designing and planning rooftop solar panel installations
// Copyright (C) 2026  Johannes Wenz github.com/Crousus
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.

package handlers

// ssrf_test.go — audit finding H5. DNS is stubbed so the suite is hermetic.

import (
	"context"
	"errors"
	"net/http"
	"net/netip"
	"strings"
	"testing"
)

func stubDNS(t *testing.T, table map[string][]string) {
	t.Helper()
	orig := hostResolver
	t.Cleanup(func() { hostResolver = orig })
	hostResolver = func(_ context.Context, host string) ([]netip.Addr, error) {
		ips, ok := table[host]
		if !ok {
			return nil, errors.New("no such host")
		}
		out := make([]netip.Addr, len(ips))
		for i, s := range ips {
			out[i] = netip.MustParseAddr(s)
		}
		return out, nil
	}
}

func TestValidatePublicURL(t *testing.T) {
	stubDNS(t, map[string][]string{
		"datasheets.example-solar.com": {"93.184.215.14"},
		"cdn.vendor.de":                {"2a00:1450:4001:82b::200e", "142.250.185.78"},
		"rebind.attacker.com":          {"93.184.215.14", "127.0.0.1"}, // one bad record is enough
		"meta.attacker.com":            {"169.254.169.254"},
		"lan.attacker.com":             {"192.168.1.10"},
		"cgnat.attacker.com":           {"100.64.0.1"},
		"ula.attacker.com":             {"fd00::1"},
		"mapped.attacker.com":          {"::ffff:10.0.0.1"},
		"v6lo.attacker.com":            {"::1"},
	})

	allowed := []string{
		"https://datasheets.example-solar.com/panel.pdf",
		"http://datasheets.example-solar.com:80/x.pdf",
		"https://cdn.vendor.de:443/a/b.pdf?x=1",
		"https://93.184.215.14/ds.pdf",
		"https://[2a00:1450:4001:82b::200e]/ds.pdf",
		"https://DataSheets.Example-Solar.com./panel.pdf", // case + trailing dot
	}
	for _, u := range allowed {
		if err := validatePublicURL(context.Background(), u); err != nil {
			t.Errorf("expected allowed: %s (%v)", u, err)
		}
	}

	blocked := []string{
		// scheme / structure
		"ftp://datasheets.example-solar.com/x.pdf",
		"file:///etc/passwd",
		"gopher://datasheets.example-solar.com/",
		"javascript:alert(1)",
		"//datasheets.example-solar.com/x.pdf",
		"https://user:pass@datasheets.example-solar.com/x.pdf",
		"https://datasheets.example-solar.com@127.0.0.1/x.pdf",
		"https://datasheets.example-solar.com:8090/x.pdf",
		"https:///x.pdf",
		"https://" + strings.Repeat("a", 2100) + ".com/",
		// Docker service names / single-label hosts
		"http://backend:8090/api/health",
		"http://backend/_/",
		"http://pdf-service:3002/",
		"http://ocr-service:8001/parse",
		"http://localhost/",
		"http://LOCALHOST./",
		"http://frontend/",
		// internal suffixes
		"http://foo.localhost/",
		"http://printer.local/",
		"http://metadata.google.internal/",
		"http://nas.lan/",
		"http://router.home.arpa/",
		// IPv4 literals
		"http://127.0.0.1/",
		"http://127.0.0.2/",
		"http://127.255.255.254/",
		"http://0.0.0.0/",
		"http://10.0.0.5/",
		"http://172.16.0.1/",
		"http://172.31.255.255/",
		"http://192.168.0.1/",
		"http://169.254.169.254/latest/meta-data/",
		"http://100.64.0.1/",
		"http://100.127.255.255/",
		"http://192.0.0.8/",
		"http://198.18.0.1/",
		"http://224.0.0.1/",
		"http://255.255.255.255/",
		// legacy / shorthand IPv4 spellings
		"http://127.1/",
		"http://2130706433/",
		"http://0x7f000001/",
		"http://0x7f.0x0.0x0.0x1/",
		"http://017700000001/",
		"http://0177.0.0.1/",
		// IPv6 literals
		"http://[::1]/",
		"http://[0:0:0:0:0:0:0:1]/",
		"http://[::]/",
		"http://[::ffff:127.0.0.1]/",
		"http://[::ffff:7f00:1]/",
		"http://[::ffff:169.254.169.254]/",
		"http://[::ffff:10.0.0.1]/",
		"http://[::127.0.0.1]/",
		"http://[fe80::1]/",
		"http://[fe80::1%25eth0]/",
		"http://[fd00::1]/",
		"http://[fc00::1]/",
		"http://[64:ff9b::a9fe:a9fe]/", // NAT64 → 169.254.169.254
		"http://[2002:7f00:1::]/",      // 6to4 → 127.0.0.1
		"http://[2001:db8::1]/",
		"http://[ff02::1]/",
		// DNS names resolving to internal space
		"http://rebind.attacker.com/",
		"http://meta.attacker.com/",
		"http://lan.attacker.com/",
		"http://cgnat.attacker.com/",
		"http://ula.attacker.com/",
		"http://mapped.attacker.com/",
		"http://v6lo.attacker.com/",
		// unresolvable
		"http://does-not-exist.example-solar.com/",
	}
	for _, u := range blocked {
		if err := validatePublicURL(context.Background(), u); err == nil {
			t.Errorf("expected blocked: %s", u)
		}
	}
}

// The handler returns a generic message and never contacts the sidecar
// for a blocked URL.
func TestDatasheetImportHandlerGate(t *testing.T) {
	stubDNS(t, map[string][]string{})
	orig := ocrServiceURL
	ocrServiceURL = "http://127.0.0.1:1" // nothing listens; must not matter
	t.Cleanup(func() { ocrServiceURL = orig })

	e := newEnv(t, envConfig{})
	u := e.createUser("u", true)

	expectStatus(t, e.do(http.MethodPost, "/api/sp/parse-datasheet", "",
		map[string]any{"url": "https://example.org/x.pdf", "type": "panel"}), 401)

	r := e.do(http.MethodPost, "/api/sp/parse-datasheet", u.token,
		map[string]any{"url": "http://ocr-service:8001/parse", "type": "panel"})
	expectStatus(t, r, 400)
	if r.str("error") != errNotPublicURL.Error() {
		t.Fatalf("unexpected error message: %s", r.raw)
	}

	// Sidecar down → generic 502, no internal hostname/dial error leaked.
	stubDNS(t, map[string][]string{"datasheets.example-solar.com": {"93.184.215.14"}})
	r = e.do(http.MethodPost, "/api/sp/parse-datasheet", u.token,
		map[string]any{"url": "https://datasheets.example-solar.com/x.pdf", "type": "panel"})
	expectStatus(t, r, 502)
	if strings.Contains(string(r.raw), "127.0.0.1") || strings.Contains(string(r.raw), "dial") {
		t.Fatalf("internal error leaked: %s", r.raw)
	}
}
