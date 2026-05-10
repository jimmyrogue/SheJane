package documents

import (
	"archive/zip"
	"bytes"
	"encoding/xml"
	"fmt"
	"io"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"github.com/ledongthuc/pdf"
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

func extractPDF(data []byte) (string, error) {
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
	handle, err := file.Open()
	if err != nil {
		return "", err
	}
	defer handle.Close()
	decoder := xml.NewDecoder(handle)
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
	return builder.String(), nil
}

func xlsxSharedStrings(file *zip.File) ([]string, error) {
	handle, err := file.Open()
	if err != nil {
		return nil, err
	}
	defer handle.Close()
	decoder := xml.NewDecoder(handle)
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
	return stringsList, nil
}

func xlsxSheetText(file *zip.File, sharedStrings []string) (string, error) {
	handle, err := file.Open()
	if err != nil {
		return "", err
	}
	defer handle.Close()
	decoder := xml.NewDecoder(handle)
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
	return builder.String(), nil
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
