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

// ssrf.go — outbound-URL gate for user-supplied datasheet URLs.
//
// The ocr-service sidecar fetches whatever URL we forward, from INSIDE
// the Docker network. Without a real gate a signed-in user could make it
// fetch http://backend:8090/_/…, http://pdf-service:3002/…, cloud
// metadata at 169.254.169.254, or anything on the host's LAN, and get
// (parts of) the response back through the LLM output. The previous
// gate was a string-prefix blocklist that missed Docker service names,
// link-local, CGNAT, 127.0.0.0/8 beyond 127.0.0.1, every IPv6 trick, and
// any DNS name that simply resolves to a private address (audit H5).
//
// Rules (all must pass):
//   - scheme http/https, no userinfo, port empty/80/443
//   - hostname is a dotted name whose last label isn't numeric (kills
//     single-label Docker/LAN names like "backend" or "ocr-service", plus
//     legacy IPv4 spellings such as "127.1", "0x7f.1", "2130706433" that
//     some resolvers expand), and not under an internal-only suffix
//   - OR an IP literal that is publicly routable
//   - the hostname resolves, and EVERY resolved address is publicly
//     routable (one bad A/AAAA record is enough to reject — an attacker
//     controls their own DNS and could return [public, 127.0.0.1])
//
// Residual risk (documented, owned by ocr-service): DNS rebinding between
// this check and the sidecar's own resolution, and redirects to internal
// hosts. The sidecar must re-validate every hop (or connect to the IP we
// validated). This gate is necessary but not sufficient on its own.

import (
	"context"
	"errors"
	"net"
	"net/netip"
	"net/url"
	"strings"
	"time"
)

// errNotPublicURL is the single user-facing error. Specific reasons are
// deliberately not echoed back: they'd help an attacker map which
// internal names/addresses exist.
var errNotPublicURL = errors.New("URL must be a public http(s) address")

// hostResolver is swappable in tests so the suite doesn't depend on real
// DNS. Production uses the system resolver with a short timeout.
var hostResolver = func(ctx context.Context, host string) ([]netip.Addr, error) {
	return net.DefaultResolver.LookupNetIP(ctx, "ip", host)
}

const resolveTimeout = 3 * time.Second

// blockedPrefixes covers special-purpose ranges that netip's Is* helpers
// don't (IANA IPv4/IPv6 special-purpose registries).
var blockedPrefixes = mustPrefixes(
	"0.0.0.0/8",       // "this network"
	"100.64.0.0/10",   // CGNAT (RFC 6598) — often cloud-internal
	"192.0.0.0/24",    // IETF protocol assignments
	"192.0.2.0/24",    // TEST-NET-1
	"198.18.0.0/15",   // benchmarking
	"198.51.100.0/24", // TEST-NET-2
	"203.0.113.0/24",  // TEST-NET-3
	"240.0.0.0/4",     // reserved + broadcast
	"::/96",           // IPv4-compatible (deprecated) — embeds v4
	"64:ff9b::/96",    // NAT64 — embeds an arbitrary v4 address
	"64:ff9b:1::/48",  // local-use NAT64
	"100::/64",        // discard-only
	"2001::/32",       // Teredo — embeds v4
	"2001:db8::/32",   // documentation
	"2002::/16",       // 6to4 — embeds v4
	"fec0::/10",       // deprecated site-local
	"fc00::/7",        // ULA (also covered by IsPrivate; explicit for clarity)
)

// Suffixes that are internal by convention/standard. Any dotted name under
// these is rejected even if it happens to resolve publicly.
var blockedHostSuffixes = []string{
	".localhost", ".local", ".internal", ".lan", ".home", ".corp",
	".intranet", ".home.arpa", ".localdomain", ".test", ".invalid",
	".example",
}

func mustPrefixes(ss ...string) []netip.Prefix {
	out := make([]netip.Prefix, len(ss))
	for i, s := range ss {
		out[i] = netip.MustParsePrefix(s)
	}
	return out
}

// isPublicAddr reports whether addr is a globally routable unicast address.
func isPublicAddr(addr netip.Addr) bool {
	if !addr.IsValid() {
		return false
	}
	// IPv4-mapped IPv6 (::ffff:127.0.0.1) must be judged as the IPv4 it is.
	addr = addr.Unmap()
	// Zones (fe80::1%eth0) only exist on link-local scopes.
	if addr.Zone() != "" {
		return false
	}
	if !addr.IsGlobalUnicast() || // rejects loopback, multicast, link-local, unspecified, 255.255.255.255
		addr.IsPrivate() || // 10/8, 172.16/12, 192.168/16, fc00::/7
		addr.IsLoopback() ||
		addr.IsLinkLocalUnicast() || // 169.254/16 (cloud metadata), fe80::/10
		addr.IsLinkLocalMulticast() ||
		addr.IsInterfaceLocalMulticast() ||
		addr.IsMulticast() ||
		addr.IsUnspecified() {
		return false
	}
	for _, p := range blockedPrefixes {
		if p.Contains(addr) {
			return false
		}
	}
	return true
}

// validatePublicURL implements the rules in the file header. It performs
// DNS resolution, so call it with a request-scoped context.
func validatePublicURL(ctx context.Context, raw string) error {
	if len(raw) == 0 || len(raw) > 2048 {
		return errNotPublicURL
	}
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Opaque != "" {
		return errNotPublicURL
	}
	// `http://good.com@127.0.0.1/` — userinfo is the classic confusion
	// vector between parsers; datasheet URLs never need it.
	if u.User != nil {
		return errNotPublicURL
	}
	if p := u.Port(); p != "" && p != "80" && p != "443" {
		return errNotPublicURL
	}

	host := strings.TrimSuffix(strings.ToLower(u.Hostname()), ".")
	if host == "" {
		return errNotPublicURL
	}

	// IP literal (u.Hostname strips IPv6 brackets). netip rejects legacy
	// shorthand like "127.1" — those fall through to the hostname rules
	// below and are rejected there.
	if addr, err := netip.ParseAddr(host); err == nil {
		if !isPublicAddr(addr) {
			return errNotPublicURL
		}
		return nil
	}
	if strings.ContainsAny(host, "%[]:") {
		return errNotPublicURL // zone ids / malformed IPv6
	}

	labels := strings.Split(host, ".")
	if len(labels) < 2 {
		return errNotPublicURL // single label: backend, ocr-service, localhost, …
	}
	last := labels[len(labels)-1]
	if last == "" || isNumericLabel(last) {
		return errNotPublicURL // "127.1", "0x7f.0x1", trailing "..", …
	}
	for _, l := range labels {
		if l == "" {
			return errNotPublicURL
		}
	}
	if host == "localhost" {
		return errNotPublicURL
	}
	for _, sfx := range blockedHostSuffixes {
		if strings.HasSuffix(host, sfx) || host == strings.TrimPrefix(sfx, ".") {
			return errNotPublicURL
		}
	}

	rctx, cancel := context.WithTimeout(ctx, resolveTimeout)
	defer cancel()
	addrs, err := hostResolver(rctx, host)
	if err != nil || len(addrs) == 0 {
		return errNotPublicURL
	}
	for _, a := range addrs {
		if !isPublicAddr(a) {
			return errNotPublicURL
		}
	}
	return nil
}

// isNumericLabel: all decimal digits, or a 0x-prefixed hex number. Real
// TLDs are alphabetic, so a numeric last label means someone is spelling
// an IPv4 address in a resolver-dependent legacy form.
func isNumericLabel(l string) bool {
	if strings.HasPrefix(l, "0x") {
		return true
	}
	for _, c := range l {
		if c < '0' || c > '9' {
			return false
		}
	}
	return true
}
