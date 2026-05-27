-- Phase 5 — extracted document metadata (page count, author, title,
-- encrypted, …). Captured once at upload time by the documents
-- service via `pdfinfo` (PDFs). Stored as JSONB so non-PDF types can
-- park their own metadata here later without another migration.
--
-- Default `'{}'` so existing rows + memory-store tests don't need
-- backfill — Go `Document.Metadata` decodes empty objects fine.
ALTER TABLE documents
    ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;
