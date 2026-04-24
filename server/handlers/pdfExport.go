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

// pdfExport.go — POST /api/sp/export-pdf
//
// Auth gate + transparent proxy to the pdf-service Node.js sidecar.
//
// Why auth lives here, not in the pdf-service:
//   The pdf-service is internal to the Docker network and has no access
//   to PocketBase auth records. Validating the token here, once, before
//   forwarding is the same pattern used by datasheetImport.go for the
//   ocr-service. The pdf-service trusts all traffic that reaches it.
//
// Payload note:
//   The JSON body can be large (plan image as a base64 JPEG data URL,
//   10-30 MB). We stream the request body directly to the pdf-service
//   via io.Copy rather than buffering it in Go, keeping memory flat.

import (
	"bytes"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/core"
)

// pdfServiceURL is resolved once at startup.  Override via PDF_SERVICE_URL
// env var.  Default is localhost for plain `go run` dev; docker-compose
// sets it to http://pdf-service:3001.
var pdfServiceURL = func() string {
	if v := os.Getenv("PDF_SERVICE_URL"); v != "" {
		return strings.TrimRight(v, "/")
	}
	return "http://localhost:3002"
}()

// Generous timeout: react-pdf can take 5-15 s on a large capture with
// many strings. 90 s gives ample headroom even on a cold Node.js start.
var pdfClient = &http.Client{Timeout: 90 * time.Second}

func handlePdfExport(_ *pocketbase.PocketBase, re *core.RequestEvent) error {
	if re.Auth == nil {
		return re.JSON(http.StatusUnauthorized, map[string]string{"error": "unauthenticated"})
	}

	// Buffer the full body before forwarding. This is required to avoid
	// ECONNRESET on the client: if we stream re.Request.Body directly and
	// the pdf-service returns an error before reading all of it, Go's HTTP
	// client stops mid-read, leaving the body partially unconsumed. When
	// Go then sends the error response back, the HTTP server tries to drain
	// the remaining body and, finding it too large, resets the connection.
	// Buffering first ensures the client's TCP connection is always stable
	// regardless of what the upstream does. The cost (server RAM for the
	// duration of one export) is fine — this is a server, not a browser.
	body, err := io.ReadAll(re.Request.Body)
	if err != nil {
		return re.JSON(http.StatusBadRequest, map[string]string{"error": "failed to read request body"})
	}

	req, err := http.NewRequestWithContext(
		re.Request.Context(),
		http.MethodPost,
		pdfServiceURL+"/render",
		bytes.NewReader(body),
	)
	if err != nil {
		return re.JSON(http.StatusInternalServerError, map[string]string{"error": "failed to build upstream request"})
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := pdfClient.Do(req)
	if err != nil {
		return re.JSON(http.StatusBadGateway, map[string]string{
			"error": "pdf-service unreachable: " + err.Error(),
		})
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		// Error before the PDF started — buffer the JSON error and forward.
		raw, _ := io.ReadAll(resp.Body)
		re.Response.Header().Set("Content-Type", "application/json")
		re.Response.WriteHeader(resp.StatusCode)
		_, err = re.Response.Write(raw)
		return err
	}

	re.Response.Header().Set("Content-Type", "application/pdf")
	re.Response.WriteHeader(http.StatusOK)
	_, err = io.Copy(re.Response, resp.Body)
	return err
}
