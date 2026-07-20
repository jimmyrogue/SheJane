Use `ocr.recognize_images` only for explicitly selected image inputs. Preserve the
user's input order. Choose a confidence threshold and bounded line/character limits
appropriate to the request. Do not claim OCR for PDFs directly: render selected PDF
pages first, then pass the resulting same-Run PNG Artifact IDs as `input_ids`.
