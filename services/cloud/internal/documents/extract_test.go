package documents

import (
	"archive/zip"
	"bytes"
	"fmt"
	"strings"
	"testing"
)

func TestExtractTextSupportsPDFDOCXAndXLSX(t *testing.T) {
	cases := []struct {
		name        string
		filename    string
		contentType string
		data        []byte
		want        string
	}{
		{
			name:        "pdf",
			filename:    "brief.pdf",
			contentType: "application/pdf",
			data:        minimalPDF("Phase two PDF text"),
			want:        "Phase two PDF text",
		},
		{
			name:        "docx",
			filename:    "brief.docx",
			contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
			data:        minimalDocxForExtract("Phase two DOCX text"),
			want:        "Phase two DOCX text",
		},
		{
			name:        "xlsx",
			filename:    "brief.xlsx",
			contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
			data:        minimalXLSX("Phase two XLSX text"),
			want:        "Phase two XLSX text",
		},
	}

	for _, tt := range cases {
		t.Run(tt.name, func(t *testing.T) {
			text, err := ExtractText(tt.filename, tt.contentType, tt.data, 60_000)
			if err != nil {
				t.Fatalf("extract text: %v", err)
			}
			if !strings.Contains(text, tt.want) {
				t.Fatalf("text = %q, want contains %q", text, tt.want)
			}
		})
	}
}

func TestExtractTextRejectsUnsupportedAndTruncates(t *testing.T) {
	if _, err := ExtractText("legacy.doc", "application/msword", []byte("hello"), 60_000); err == nil {
		t.Fatal("expected unsupported type error")
	}
	text, err := ExtractText("brief.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", minimalDocxForExtract("abcdef"), 3)
	if err != nil {
		t.Fatalf("extract text: %v", err)
	}
	if text != "abc" {
		t.Fatalf("truncated text = %q, want abc", text)
	}
}

func TestExtractTextRejectsOversizedOOXMLPart(t *testing.T) {
	hugeText := strings.Repeat("x", maxOOXMLPartBytes+1)
	_, err := ExtractText(
		"huge.docx",
		"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		minimalDocxForExtract(hugeText),
		60_000,
	)
	if err == nil || !strings.Contains(err.Error(), "xml part too large") {
		t.Fatalf("err = %v, want xml part too large", err)
	}
}

func minimalDocxForExtract(text string) []byte {
	return zipBytes(map[string]string{
		"word/document.xml": `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>` + text + `</w:t></w:r></w:p></w:body></w:document>`,
	})
}

func minimalXLSX(text string) []byte {
	return zipBytes(map[string]string{
		"xl/sharedStrings.xml":       `<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>` + text + `</t></si></sst>`,
		"xl/worksheets/sheet1.xml":   `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row></sheetData></worksheet>`,
		"[Content_Types].xml":        `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>`,
		"_rels/.rels":                `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`,
		"xl/workbook.xml":            `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"></workbook>`,
		"xl/_rels/workbook.xml.rels": `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`,
	})
}

func zipBytes(files map[string]string) []byte {
	var buffer bytes.Buffer
	writer := zip.NewWriter(&buffer)
	for name, content := range files {
		file, err := writer.Create(name)
		if err != nil {
			panic(err)
		}
		_, _ = file.Write([]byte(content))
	}
	if err := writer.Close(); err != nil {
		panic(err)
	}
	return buffer.Bytes()
}

func TestParsePDFInfoMapsKnownKeys(t *testing.T) {
	// Snapshot of `pdfinfo -` output from Poppler 24.x. Whitespace
	// preserved verbatim — parsePDFInfo must tolerate variable
	// spaces between key, colon, and value.
	raw := []byte(`Title:           Attention Is All You Need
Author:          Vaswani et al.
Creator:         LaTeX
Producer:        pdfTeX-1.40.20
Subject:         NIPS 2017
Keywords:        attention transformer
Pages:           15
Encrypted:       no
PDF version:     1.5
Page size:       612 x 792 pts
unrelated-line-without-colon-pattern
`)
	meta := parsePDFInfo(raw)
	if meta["title"] != "Attention Is All You Need" {
		t.Fatalf("title=%v", meta["title"])
	}
	if meta["author"] != "Vaswani et al." {
		t.Fatalf("author=%v", meta["author"])
	}
	if got, ok := meta["pages"].(int); !ok || got != 15 {
		t.Fatalf("pages=%v (%T) — expected typed int 15", meta["pages"], meta["pages"])
	}
	if meta["encrypted"] != false {
		t.Fatalf("encrypted=%v — expected typed bool false", meta["encrypted"])
	}
	if meta["pdf_version"] != "1.5" {
		t.Fatalf("pdf_version=%v", meta["pdf_version"])
	}
	if _, exists := meta["unrelated"]; exists {
		t.Fatal("unrelated key leaked into parsed metadata")
	}
}

func TestParsePDFInfoHandlesEncryptedYesPrefix(t *testing.T) {
	// Real Poppler emits "yes (print:yes copy:no…)" for encrypted
	// PDFs — parser must coerce to plain boolean true.
	meta := parsePDFInfo([]byte("Encrypted:       yes (print:yes copy:no change:no addNotes:no)\n"))
	if meta["encrypted"] != true {
		t.Fatalf("encrypted=%v — expected true", meta["encrypted"])
	}
}

func TestExtractMetadataReturnsNilForNonPDF(t *testing.T) {
	// DOCX / XLSX / images currently have no metadata extractor;
	// ExtractMetadata returns (nil, nil) which the caller treats
	// as "nothing to store".
	for _, ct := range []string{
		"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
		"image/png",
	} {
		meta, err := ExtractMetadata("x", ct, []byte("noop"))
		if err != nil {
			t.Fatalf("%s: unexpected err %v", ct, err)
		}
		if meta != nil {
			t.Fatalf("%s: expected nil metadata, got %v", ct, meta)
		}
	}
}

func TestExtractPDFFallsBackWhenPopplerMissing(t *testing.T) {
	// If pdftotext isn't installed (CI / sparse dev shells), the
	// extractor must still pull text via the Go-native fallback.
	// Swap the binary path to "" and confirm the minimal PDF
	// still extracts its known string.
	original := pdftotextPath
	pdftotextPath = ""
	defer func() { pdftotextPath = original }()
	text, err := ExtractText("brief.pdf", "application/pdf", minimalPDF("Fallback text"), 60_000)
	if err != nil {
		t.Fatalf("extract via Go fallback: %v", err)
	}
	if !strings.Contains(text, "Fallback text") {
		t.Fatalf("fallback path missed expected text: %q", text)
	}
}

func minimalPDF(text string) []byte {
	objects := []string{
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
		fmt.Sprintf("<< /Length %d >>\nstream\nBT /F1 24 Tf 72 720 Td (%s) Tj ET\nendstream", len("BT /F1 24 Tf 72 720 Td ("+text+") Tj ET\n"), text),
	}
	var buffer bytes.Buffer
	buffer.WriteString("%PDF-1.4\n")
	offsets := make([]int, len(objects)+1)
	for index, object := range objects {
		offsets[index+1] = buffer.Len()
		buffer.WriteString(fmt.Sprintf("%d 0 obj\n%s\nendobj\n", index+1, object))
	}
	xrefOffset := buffer.Len()
	buffer.WriteString(fmt.Sprintf("xref\n0 %d\n", len(objects)+1))
	buffer.WriteString("0000000000 65535 f \n")
	for index := 1; index <= len(objects); index++ {
		buffer.WriteString(fmt.Sprintf("%010d 00000 n \n", offsets[index]))
	}
	buffer.WriteString(fmt.Sprintf("trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n", len(objects)+1, xrefOffset))
	return buffer.Bytes()
}
