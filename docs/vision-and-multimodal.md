# ARC-AI Vision and Multimodal

This document describes the **current** live-vision pipeline and multimodal routing. It reflects the code as it exists today (vision routes to **Gemini**, not Pixtral/GPT-4o).

---

## Live Vision

ARC-AI extends static image understanding to realtime camera-assisted interaction.

### Pipeline

1. Frontend streams the webcam in `LiveVisionCamera` (device + facing-mode enumeration, frame capture to a hidden canvas).
2. When the user finalizes a voice command (or submits a text command with the camera enabled), the **current frame is captured as base64 JPEG**.
3. The frame is attached to the command payload (`ai:stt:final`).
4. The backend treats the image as a multimodal attachment and routes it to a multimodal-capable provider (**Gemini**).
5. Vision analysis is synthesized into the streaming response.

### Feature Highlights

- realtime webcam-assisted command understanding
- frame capture synchronized to user utterance
- low-friction multimodal command flow
- vision frame also available from the text input path (`getLiveVisionFrame()` in ChatContext)
- seamless integration with existing streaming UX

---

## Multimodal Routing

- Image attachments force `taskMode: 'multimodal'` in the AI pipeline.
- `LLMRouter`/`inferTaskProfile` classify image-bearing requests and select **Gemini** as the primary provider.
- **Text-only providers (Groq gpt-oss-120b, Mistral) are excluded** from the fallback order for image requests by `canHandleRequest()` and router-level filtering.
- If no multimodal-capable provider is available, a clean error is returned.

---

## Multimodal Runtime Safety

- invalid multimodal provider fallback is blocked (400, never a silent skip)
- silent attachment loss is prevented
- capability-aware routing is enforced before execution
- graceful failure when no compatible provider exists

---

## Streaming Compatibility

- token streaming remains provider-independent
- interruption cleanup remains safe
- stream finalization remains guaranteed
- voice + multimodal orchestration remains compatible

---

## Relations

- STT/TTS paths: [`advanced-voice.md`](./advanced-voice.md)
- Provider/capability table and model resolution: [`llm-providers.md`](./llm-providers.md)