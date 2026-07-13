# Document And Tool Combination Policy

> Updated: 2026-06-13

This page defines how SheJane combines uploaded attachments with agent tools. The goal is to avoid ambiguous prompts where the user expects both document-grounded answers and open-ended tool execution in the same turn.

## Matrix

| Input | Web/cloud tools | Local tools / MCP / Skills | Product behavior |
|---|---|---|---|
| Plain text, no attachment | Supported when configured. | Supported on desktop when Local Host is connected. | Normal tool-capable agent path. |
| One or more uploaded PDF / DOCX / XLSX files | Not mixed in the same turn. | Not mixed in the same turn. | Document Q&A mode. The cloud agent run receives `attachments[]`, reads each document with `document.read`, and injects the extracted text into one context. |
| Uploaded document plus slash-command skill or cloud tool intent | Deferred. | Deferred. | The composer shows attachment mode. The send path omits `cloudTools` so the run stays document-grounded. |
| Uploaded image files only | Not a document Q&A case. | Supported only through the Local Host image-edit path when connected. | The client may route image attachments to the local harness so tools can inspect/edit the image. |
| URL pasted as plain text | Supported when configured. | Supported on desktop when Local Host is connected. | Treated as text unless the user attaches an uploaded document. |

## UX Contract

- The composer may show a compact "attachment mode" status when attachments are present and tool entry points would otherwise be available.
- The status is informational, not a blocking dialog.
- A turn with uploaded documents should prefer grounded document answering over web search, image generation, code execution, or local workspace mutation.
- To combine document analysis with tools later, add an explicit staged workflow: first extract/summarize the attachments, then ask the user to continue with tools using the derived summary.

## Implementation Hooks

- `client/src/App.tsx` disables `cloudTools` when uploaded documents are sent through the cloud agent path.
- `client/src/features/chat/chatStore.ts` maps `documents[]` into run `attachments[]`.
- `services/cloud/internal/httpapi/server.go` reads every document attachment in `loadAgentDocumentContext`.
- `client/src/features/chat/components/Composer.tsx` surfaces the attachment-mode status.
