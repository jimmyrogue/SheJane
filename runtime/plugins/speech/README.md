# Speech plugin

`org.shejane.speech` is a deterministic Managed Worker plugin for offline file transcription. It normalizes one authorized audio input through the exact `org.ffmpeg.runtime` asset and transcribes it through the exact `org.whisper.runtime` asset.

The v1 Action is `speech.transcribe`. It provides segment timestamps and optional UTF-8 text, SRT, and canonical JSON Artifacts. It does not provide live voice, translation, diarization, word timestamps, network fallback, model selection, or host-tool discovery.

The Linux/arm64 asset, frozen onedir Worker, and deterministic package pass local
production-VM tests for repeatability, explicit English/Mandarin, Japanese `auto`
detection with deterministic background noise/tone and a long pause, hostile inputs,
cancellation cleanup, a 66.7-second low-volume accented English fixture with technical
prompt terms, and `media.extract_audio -> speech.transcribe` Artifact composition.
Proper nouns remain ordinary ASR output rather than guaranteed dictionary matches. The
package remains unpublished until the signed/notarized release workflow and general
Managed Worker platform Gate pass. See
`docs/plugins/phase6-speech-research.md`.
