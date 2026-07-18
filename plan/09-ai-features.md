# 09 — AI features

Two features: **scan a receipt** (vision/OCR → line items + total) and a **natural-language split
directive** ("split evenly but Sarah didn't drink"). On-device inference aligns with the
[E2E](06-e2e-encryption.md) ethos — the receipt image and amounts never leave the device.

## The reality of on-device AI from a PWA

- **OS built-in models are mostly closed to the web.** Apple Intelligence / Foundation Models are
  native-Swift only (no Safari/JS API). Pixel/Gemini Nano is reachable from native apps, not
  portably from web. So a **pure PWA cannot tap the iPhone/Pixel NPU.**
- **One emerging web exception:** Chrome's **Built-in AI** (Gemini Nano) — Prompt/Summarizer/
  Translator APIs. Chrome-specific, mostly desktop, hardware-gated, Android support still maturing.
  A nice progressive-enhancement bonus, not a foundation.
- **Portable on-device route:** ship our own models via **WebGPU/WASM** — Tesseract.js / ONNX
  Runtime Web for OCR, WebLLM (MLC) / Transformers.js for the NL directive. Runs locally,
  cross-browser; costs model download size + battery.

## Capability ladder (one interface, swappable backend)

1. **OS/browser on-device** — Chrome Built-in AI if present.
2. **In-browser WebGPU model** — WebLLM for NL, Tesseract/ONNX for OCR.
3. **Cloud API** — best accuracy, but breaks the "data never leaves device" promise, so gate it
   behind **explicit per-action user consent**.

## Per-task recommendation

| Task | Best on-device fit | Reality |
|------|--------------------|---------|
| **NL split directive** (text) | Chrome Built-in AI or WebLLM/WebGPU | Genuinely good on-device; small models handle it |
| **Receipt scan** (vision/OCR) | Tesseract.js / ONNX on WebGPU | Works, but cloud vision is notably more accurate today |

Lean on-device for the NL directive (keeps data local, works well); be pragmatic on receipt OCR —
start with a consented cloud vision API for accuracy, offer on-device OCR as the privacy option.

## Native path

To actually use the Pixel/iPhone NPU, reach it from the [native apps](10-native-apps.md) via
platform plugins (ML Kit GenAI on Android, Foundation Models on iOS). Pure web can't; native can.

## Open questions

- Verify current Chrome Built-in AI availability on Android before relying on tier 1.
- Which cloud vision provider for the fallback, and the consent UX.
- Model size budget for the WebGPU tier (download vs accuracy tradeoff).
