package documents

import (
	"archive/zip"
	"bufio"
	"bytes"
	"context"
	"encoding/xml"
	"fmt"
	"io"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/ledongthuc/pdf"
)

// popplerTimeout caps how long pdftotext / pdfinfo may run on one
// document. Real-world parses finish in well under a second; a hung
// subprocess (corrupt PDF, OOM-killed) shouldn't block an HTTP
// request indefinitely. 30s is generous for very large PDFs while
// still being a hard upper bound.
const popplerTimeout = 30 * time.Second

const (
	maxOOXMLPartBytes = 4 * 1024 * 1024
	maxXLSXSheets     = 64
)

// pdftotextPath / pdfinfoPath are exposed as package vars so tests
// can swap them to "" and exercise the Go-native fallback path
// without depending on Poppler being installed in CI. Production
// containers ship with poppler-utils (see api/Dockerfile).
var (
	pdftotextPath = "pdftotext"
	pdfinfoPath   = "pdfinfo"
)

func ExtractText(filename string, contentType string, data []byte, limit int) (string, error) {
	normalized, _, err := NormalizeContentType(filename, contentType)
	if err != nil {
		return "", err
	}
	var text string
	switch normalized {
	case "application/pdf":
		text, err = extractPDF(data)
	case "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
		text, err = extractDOCX(data)
	case "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
		text, err = extractXLSX(data)
	default:
		return "", ErrUnsupportedType
	}
	if err != nil {
		return "", err
	}
	text = normalizeWhitespace(text)
	if text == "" {
		return "", fmt.Errorf("document contains no readable text")
	}
	return truncateRunes(text, limit), nil
}

// ExtractMetadata returns a structured metadata map for the source
// document. PDFs go through `pdfinfo` (page count, title, author,
// creator, producer, encrypted flag, …). Other types currently
// return nil — they can grow their own extractor later (DOCX has
// word counts in app.xml, XLSX has sheet counts in workbook.xml).
//
// Errors are *non-fatal* in the caller's eyes — the document upload
// still succeeds even if metadata extraction fails (corrupt PDF,
// missing pdfinfo binary, encrypted document we can't introspect).
// Callers should log + continue. Returning (nil, nil) means "no
// metadata available, don't store anything."
func ExtractMetadata(filename string, contentType string, data []byte) (map[string]any, error) {
	normalized, _, err := NormalizeContentType(filename, contentType)
	if err != nil {
		return nil, err
	}
	if normalized != "application/pdf" {
		// Non-PDF types — no metadata path defined yet. Returning
		// (nil, nil) is a "no-op" signal to the caller.
		return nil, nil
	}
	return extractPDFMetadata(data)
}

// extractPDF tries Poppler's pdftotext first (better quality —
// preserves layout, handles custom fonts) and falls back to the
// pure-Go ledongthuc/pdf library if pdftotext is missing or fails.
// The fallback path also covers the dev/test scenario where Poppler
// isn't installed.
func extractPDF(data []byte) (string, error) {
	if text, err := extractPDFViaPoppler(data); err == nil {
		return text, nil
	}
	return extractPDFViaGo(data)
}

func extractPDFViaPoppler(data []byte) (string, error) {
	if pdftotextPath == "" {
		return "", fmt.Errorf("pdftotext disabled")
	}
	ctx, cancel := context.WithTimeout(context.Background(), popplerTimeout)
	defer cancel()
	// `pdftotext - -`: read PDF from stdin, write text to stdout.
	// -layout preserves columnar layout (better for tables); -nopgbrk
	// drops the form-feed page separators that confuse downstream
	// LLM tokenizers.
	cmd := exec.CommandContext(ctx, pdftotextPath, "-layout", "-nopgbrk", "-", "-")
	cmd.Stdin = bytes.NewReader(data)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		// Don't surface stderr — pdftotext prints "Syntax Warning"
		// noise for many otherwise-readable PDFs and we don't want
		// to fail the extract over warnings.
		return "", fmt.Errorf("pdftotext: %w", err)
	}
	return stdout.String(), nil
}

func extractPDFViaGo(data []byte) (string, error) {
	reader, err := pdf.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return "", err
	}
	var builder strings.Builder
	fonts := map[string]*pdf.Font{}
	for index := 1; index <= reader.NumPage(); index++ {
		page := reader.Page(index)
		if page.V.IsNull() {
			continue
		}
		text, err := page.GetPlainText(fonts)
		if err != nil {
			return "", err
		}
		builder.WriteString(text)
		builder.WriteByte('\n')
	}
	return builder.String(), nil
}

// extractPDFMetadata shells out to `pdfinfo -` (read from stdin)
// and parses the colon-delimited key:value lines into a typed map.
// Returns (nil, nil) when pdfinfo is unavailable or fails — the
// caller treats absent metadata as "nothing to store" rather than
// a hard error so document uploads stay resilient.
func extractPDFMetadata(data []byte) (map[string]any, error) {
	if pdfinfoPath == "" {
		return nil, nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), popplerTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, pdfinfoPath, "-")
	cmd.Stdin = bytes.NewReader(data)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		// Soft-fail: log + keep going. Encrypted PDFs are the
		// common case here — pdfinfo refuses without a password.
		return nil, nil
	}
	return parsePDFInfo(stdout.Bytes()), nil
}

// ParsePDFInfoBytes is the exported entry point for callers outside
// this package (the pdf.inspect gateway in httpapi runs pdfinfo
// itself and needs to parse the same shape). Internal callers stay
// on parsePDFInfo for the shorter name.
func ParsePDFInfoBytes(out []byte) map[string]any { return parsePDFInfo(out) }

// parsePDFInfo reads `pdfinfo` stdout (colon-delimited key:value
// per line) into a sparse map keyed by snake_case. Numeric and
// boolean fields are typed so the JSON shape on the wire stays
// useful (clients can render "12 pages" instead of "12 pages\n").
// Unknown / unparseable keys are dropped — pdfinfo emits a stable
// header set across versions, and unknown lines (custom XMP) are
// not worth surfacing.
func parsePDFInfo(out []byte) map[string]any {
	meta := make(map[string]any)
	scanner := bufio.NewScanner(bytes.NewReader(out))
	for scanner.Scan() {
		line := scanner.Text()
		colon := strings.Index(line, ":")
		if colon < 0 {
			continue
		}
		key := strings.TrimSpace(line[:colon])
		value := strings.TrimSpace(line[colon+1:])
		if value == "" {
			continue
		}
		switch key {
		case "Title":
			meta["title"] = value
		case "Author":
			meta["author"] = value
		case "Creator":
			meta["creator"] = value
		case "Producer":
			meta["producer"] = value
		case "Subject":
			meta["subject"] = value
		case "Keywords":
			meta["keywords"] = value
		case "Pages":
			if n, err := strconv.Atoi(value); err == nil {
				meta["pages"] = n
			}
		case "Encrypted":
			// Pdfinfo emits "yes" / "no" / "yes (print:yes copy:no…)".
			// We only care about the boolean lead.
			meta["encrypted"] = strings.HasPrefix(strings.ToLower(value), "yes")
		case "PDF version":
			meta["pdf_version"] = value
		case "Page size":
			meta["page_size"] = value
		}
	}
	return meta
}

func extractDOCX(data []byte) (string, error) {
	reader, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return "", err
	}
	file := zipFile(reader, "word/document.xml")
	if file == nil {
		return "", fmt.Errorf("docx missing word/document.xml")
	}
	return xmlText(file, map[string]bool{"t": true}, map[string]bool{"p": true})
}

func extractXLSX(data []byte) (string, error) {
	reader, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return "", err
	}
	sharedStrings := []string{}
	if shared := zipFile(reader, "xl/sharedStrings.xml"); shared != nil {
		text, err := xlsxSharedStrings(shared)
		if err != nil {
			return "", err
		}
		sharedStrings = text
	}
	sheets := make([]*zip.File, 0)
	for _, file := range reader.File {
		if strings.HasPrefix(file.Name, "xl/worksheets/sheet") && filepath.Ext(file.Name) == ".xml" {
			if len(sheets) >= maxXLSXSheets {
				return "", fmt.Errorf("xlsx contains too many worksheets")
			}
			sheets = append(sheets, file)
		}
	}
	sort.Slice(sheets, func(i, j int) bool { return sheets[i].Name < sheets[j].Name })
	var builder strings.Builder
	for _, sheet := range sheets {
		text, err := xlsxSheetText(sheet, sharedStrings)
		if err != nil {
			return "", err
		}
		if strings.TrimSpace(text) != "" {
			builder.WriteString(text)
			builder.WriteByte('\n')
		}
	}
	return builder.String(), nil
}

func zipFile(reader *zip.Reader, name string) *zip.File {
	for _, file := range reader.File {
		if file.Name == name {
			return file
		}
	}
	return nil
}

func xmlText(file *zip.File, textTags map[string]bool, breakTags map[string]bool) (string, error) {
	handle, limited, err := openLimitedZipXML(file)
	if err != nil {
		return "", err
	}
	defer handle.Close()
	decoder := xml.NewDecoder(limited)
	var builder strings.Builder
	capturing := false
	for {
		token, err := decoder.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			return "", err
		}
		switch item := token.(type) {
		case xml.StartElement:
			capturing = textTags[item.Name.Local]
		case xml.EndElement:
			if textTags[item.Name.Local] {
				capturing = false
			}
			if breakTags[item.Name.Local] {
				builder.WriteByte('\n')
			}
		case xml.CharData:
			if capturing {
				builder.Write([]byte(item))
				builder.WriteByte(' ')
			}
		}
	}
	if limited.N == 0 {
		return "", fmt.Errorf("xml part too large: %s", file.Name)
	}
	return builder.String(), nil
}

func xlsxSharedStrings(file *zip.File) ([]string, error) {
	handle, limited, err := openLimitedZipXML(file)
	if err != nil {
		return nil, err
	}
	defer handle.Close()
	decoder := xml.NewDecoder(limited)
	stringsList := make([]string, 0)
	var current strings.Builder
	capturing := false
	inString := false
	for {
		token, err := decoder.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, err
		}
		switch item := token.(type) {
		case xml.StartElement:
			if item.Name.Local == "si" {
				inString = true
				current.Reset()
			}
			if item.Name.Local == "t" && inString {
				capturing = true
			}
		case xml.EndElement:
			if item.Name.Local == "t" {
				capturing = false
			}
			if item.Name.Local == "si" {
				inString = false
				stringsList = append(stringsList, current.String())
			}
		case xml.CharData:
			if capturing {
				current.Write([]byte(item))
			}
		}
	}
	if limited.N == 0 {
		return nil, fmt.Errorf("xml part too large: %s", file.Name)
	}
	return stringsList, nil
}

func xlsxSheetText(file *zip.File, sharedStrings []string) (string, error) {
	handle, limited, err := openLimitedZipXML(file)
	if err != nil {
		return "", err
	}
	defer handle.Close()
	decoder := xml.NewDecoder(limited)
	var builder strings.Builder
	var cellType string
	var cellValue strings.Builder
	var inlineValue strings.Builder
	var currentTag string
	inCell := false
	inInlineString := false
	for {
		token, err := decoder.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			return "", err
		}
		switch item := token.(type) {
		case xml.StartElement:
			currentTag = item.Name.Local
			if item.Name.Local == "c" {
				inCell = true
				cellType = ""
				cellValue.Reset()
				inlineValue.Reset()
				for _, attr := range item.Attr {
					if attr.Name.Local == "t" {
						cellType = attr.Value
						break
					}
				}
			}
			if item.Name.Local == "is" {
				inInlineString = true
			}
		case xml.EndElement:
			if item.Name.Local == "is" {
				inInlineString = false
			}
			if item.Name.Local == "c" && inCell {
				value := strings.TrimSpace(cellValue.String())
				if cellType == "s" {
					if index, err := strconv.Atoi(value); err == nil && index >= 0 && index < len(sharedStrings) {
						value = sharedStrings[index]
					}
				}
				if cellType == "inlineStr" {
					value = inlineValue.String()
				}
				if value != "" {
					builder.WriteString(value)
					builder.WriteByte('\t')
				}
				inCell = false
			}
			if item.Name.Local == "row" {
				builder.WriteByte('\n')
			}
			currentTag = ""
		case xml.CharData:
			if inCell && currentTag == "v" {
				cellValue.Write([]byte(item))
			}
			if inInlineString && currentTag == "t" {
				inlineValue.Write([]byte(item))
			}
		}
	}
	if limited.N == 0 {
		return "", fmt.Errorf("xml part too large: %s", file.Name)
	}
	return builder.String(), nil
}

func openLimitedZipXML(file *zip.File) (io.ReadCloser, *io.LimitedReader, error) {
	if file.UncompressedSize64 > uint64(maxOOXMLPartBytes) {
		return nil, nil, fmt.Errorf("xml part too large: %s", file.Name)
	}
	handle, err := file.Open()
	if err != nil {
		return nil, nil, err
	}
	return handle, &io.LimitedReader{R: handle, N: maxOOXMLPartBytes + 1}, nil
}

func normalizeWhitespace(text string) string {
	lines := strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n")
	out := make([]string, 0, len(lines))
	for _, line := range lines {
		line = strings.Join(strings.Fields(line), " ")
		if line != "" {
			out = append(out, line)
		}
	}
	return strings.Join(out, "\n")
}

func truncateRunes(text string, limit int) string {
	if limit <= 0 {
		return text
	}
	runes := []rune(text)
	if len(runes) <= limit {
		return text
	}
	return string(runes[:limit])
}
