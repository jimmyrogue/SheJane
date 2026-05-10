# Phase 2A Progress - Document Upload and Single-File AI Reading

## Goal

Build the MVP document-reading flow: users upload PDF / DOCX / XLSX files to AWS S3, the API extracts text into a separate S3 text object, and users ask a real LLM questions about one ready document while consuming credits through the existing wallet flow.

## Decisions

- Storage: AWS S3 directly.
- Supported files: PDF, DOCX, XLSX.
- Product entry: standalone document reading page in the user client.
- Billing: upload and extraction are free; document questions consume credits.
- Limits: 30 MB per file, 60k extracted characters, 7-day retention.
- Extracted text: stored as a separate S3 `.txt` object.
- Extraction mode: synchronous after upload completion.

## Checklist

- [x] Backend tests for document auth, validation, extraction, ask, ownership, and billing.
- [x] Document metadata store and migration.
- [x] S3 object storage adapter and test memory adapter.
- [x] PDF / DOCX / XLSX text extraction.
- [x] Document API routes.
- [x] Client document reading page and API client methods.
- [x] README and operations docs.
- [x] `make test`
- [x] `make build`

## Notes

- Phase 2A intentionally avoids multi-document chat, vector search, RAG, team libraries, and admin document management.
- S3 keys and provider credentials must not be committed or exposed in the admin UI.
