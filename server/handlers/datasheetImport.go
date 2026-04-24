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

// datasheetImport.go — POST /api/sp/parse-datasheet
//
// Thin auth-and-SSRF gate that proxies validated requests to the
// ocr-service Python microservice, which handles the actual PDF
// download, text extraction, and LLM-based parsing.
//
// WHY split into a separate service:
//   Many manufacturer datasheets (JA Solar, Longi, …) render text as
//   vector glyphs with no Unicode font map, so Go PDF libraries return
//   empty strings.  Tesseract OCR solves this; shipping a CGo tesseract
//   binding inside the PocketBase binary adds complexity and a large C
//   dependency.  A small Python sidecar that owns pdftoppm + tesseract
//   + the Gemini API call keeps the Go binary clean.
//
// Auth and SSRF validation stay here in Go because:
//   - The ocr-service is internal (only reachable from the backend network).
//   - We never want unauthenticated callers to trigger arbitrary outbound
//     HTTP fetches or LLM API calls from our infrastructure.

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/core"
)

// ocrServiceURL is resolved once at startup.  Override via OCR_SERVICE_URL
// env var.  Default is localhost for plain `go run` dev; docker-compose
// sets it to http://ocr-service:8001.
var ocrServiceURL = func() string {
	if v := os.Getenv("OCR_SERVICE_URL"); v != "" {
		return strings.TrimRight(v, "/")
	}
	return "http://localhost:8001"
}()

var ocrClient = &http.Client{Timeout: 120 * time.Second}

// datasheetImportRequest mirrors what the Python service expects.
type datasheetImportRequest struct {
	URL  string `json:"url"`
	Type string `json:"type"` // "panel" | "inverter"
}

func handleDatasheetImport(_ *pocketbase.PocketBase, re *core.RequestEvent) error {
	if re.Auth == nil {
		return re.JSON(http.StatusUnauthorized, map[string]string{"error": "unauthenticated"})
	}

	var body datasheetImportRequest
	if err := json.NewDecoder(re.Request.Body).Decode(&body); err != nil {
		return re.JSON(http.StatusBadRequest, map[string]string{"error": "invalid request body"})
	}
	if body.Type != "panel" && body.Type != "inverter" {
		return re.JSON(http.StatusBadRequest, map[string]string{"error": `type must be "panel" or "inverter"`})
	}
	if err := validatePublicURL(body.URL); err != nil {
		return re.JSON(http.StatusBadRequest, map[string]string{"error": err.Error()})
	}

	// Forward to the OCR service.  We re-encode the body so only the
	// validated fields reach the downstream service.
	payload, _ := json.Marshal(body)
	resp, err := ocrClient.Post(
		ocrServiceURL+"/parse",
		"application/json",
		strings.NewReader(string(payload)),
	)
	if err != nil {
		return re.JSON(http.StatusBadGateway, map[string]string{
			"error": fmt.Sprintf("ocr-service unreachable: %v", err),
		})
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		// Error before streaming started — buffer and forward as-is.
		raw, _ := io.ReadAll(resp.Body)
		re.Response.Header().Set("Content-Type", "application/json")
		re.Response.WriteHeader(resp.StatusCode)
		_, err = re.Response.Write(raw)
		return err
	}

	// Success path: stream the ndjson body so the frontend receives progress
	// lines as they arrive rather than waiting for the full LLM response.
	re.Response.Header().Set("Content-Type", "application/x-ndjson")
	re.Response.Header().Set("X-Accel-Buffering", "no") // disable nginx proxy buffering
	re.Response.WriteHeader(http.StatusOK)
	flusher, canFlush := re.Response.(http.Flusher)
	buf := make([]byte, 4096)
	for {
		n, readErr := resp.Body.Read(buf)
		if n > 0 {
			if _, writeErr := re.Response.Write(buf[:n]); writeErr != nil {
				return writeErr
			}
			if canFlush {
				flusher.Flush()
			}
		}
		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			return readErr
		}
	}
	return nil
}

// validatePublicURL blocks loopback and RFC-1918 targets.
// Not a complete SSRF defence (no DNS resolution), but stops the obvious cases.
func validatePublicURL(raw string) error {
	u, err := url.ParseRequestURI(raw)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") {
		return fmt.Errorf("URL must be a valid http or https address")
	}
	host := strings.ToLower(u.Hostname())

	for _, b := range []string{"localhost", "127.0.0.1", "::1", "0.0.0.0"} {
		if host == b {
			return fmt.Errorf("URL must point to a public host")
		}
	}
	for _, p := range []string{
		"10.", "192.168.",
		"172.16.", "172.17.", "172.18.", "172.19.", "172.20.",
		"172.21.", "172.22.", "172.23.", "172.24.", "172.25.",
		"172.26.", "172.27.", "172.28.", "172.29.", "172.30.", "172.31.",
	} {
		if strings.HasPrefix(host, p) {
			return fmt.Errorf("URL must point to a public host")
		}
	}
	if strings.HasSuffix(host, ".local") || strings.HasSuffix(host, ".internal") {
		return fmt.Errorf("URL must point to a public host")
	}
	return nil
}
