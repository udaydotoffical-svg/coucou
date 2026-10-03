// Chat client. Two providers: the Claude API (the same integration as
// ClaudeService.swift: multi-turn chat with web search, files sent as
// document/image/text blocks) and any OpenAI-compatible endpoint (OpenAI,
// OpenRouter, Groq, Together, Mistral, DeepSeek, Gemini, Ollama, LM Studio…).
//
// Everything happens here rather than in the island: the API key never leaves
// the Credential Manager, and file bytes never cross the IPC boundary.

use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::secrets;

const ENDPOINT: &str = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION: &str = "2023-06-01";
/// Server-side fallback: on a policy decline the API retries the same request on
/// a fallback model inside the same call, so the island never shows a dead end.
const FALLBACK_BETA: &str = "server-side-fallback-2026-07-01";
const MAX_TOKENS: u32 = 4096;
/// Text and code files are inlined; anything larger is skipped, as on macOS.
const MAX_INLINE_TEXT: u64 = 200_000;

pub const DEFAULT_MODEL: &str = "claude-opus-5";

const SYSTEM_PROMPT: &str = "You are Mochi, a personal AI assistant living at the top of the user's screen. \
You have web search access and can help with absolutely anything — research, coding, finding places, recommendations, tasks, questions. \
Respond in the user's language. Be thorough and complete — use as much detail as the task requires. \
No markdown formatting (no **, no ##, no bullet dashes). Use plain text with line breaks.";

/// Same persona, minus the web-search sentence: only the Claude API has that tool here.
const OPENAI_SYSTEM_PROMPT: &str = "You are Mochi, a personal AI assistant living at the top of the user's screen. \
You can help with absolutely anything — research, coding, recommendations, tasks, questions. \
Respond in the user's language. Be thorough and complete — use as much detail as the task requires. \
No markdown formatting (no **, no ##, no bullet dashes). Use plain text with line breaks.";

#[derive(Default)]
pub struct Chat {
    /// Full multi-turn history, including tool_use / tool_result blocks.
    messages: Mutex<Vec<Value>>,
    /// Which provider the history was written for. The two message formats are
    /// not interchangeable, so switching provider starts a fresh conversation.
    provider: Mutex<String>,
}

/// What the settings window chose: provider, endpoint and model.
pub struct AiConfig {
    pub provider: String,
    pub base_url: String,
    pub model: String,
}

impl Chat {
    pub fn reset(&self) {
        self.messages.lock().unwrap().clear();
    }

    fn use_provider(&self, tag: &str) {
        let mut current = self.provider.lock().unwrap();
        if *current != tag {
            self.messages.lock().unwrap().clear();
            *current = tag.to_string();
        }
    }

    fn is_empty(&self) -> bool {
        self.messages.lock().unwrap().is_empty()
    }

    fn push(&self, message: Value) {
        self.messages.lock().unwrap().push(message);
    }

    fn pop(&self) {
        self.messages.lock().unwrap().pop();
    }

    fn snapshot(&self) -> Vec<Value> {
        self.messages.lock().unwrap().clone()
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ChatContext {
    File { name: String, path: String },
    Window { app_name: String, title: String, url: Option<String> },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatReply {
    pub text: String,
}

/// One chat turn. Returns the assistant's text, or a message the island shows
/// in the note view.
pub async fn send(
    chat: &Chat,
    cfg: &AiConfig,
    query: String,
    context: Option<ChatContext>,
) -> Result<ChatReply, String> {
    if cfg.provider == "openai" {
        chat.use_provider(&format!("openai {}", cfg.base_url));
        send_openai(chat, cfg, query, context).await
    } else {
        chat.use_provider("anthropic");
        send_anthropic(chat, &cfg.model, query, context).await
    }
}

async fn send_anthropic(
    chat: &Chat,
    model: &str,
    query: String,
    context: Option<ChatContext>,
) -> Result<ChatReply, String> {
    let key = secrets::get("anthropic-api-key")
        .ok_or_else(|| "API key missing. Open settings.".to_string())?;

    let mut content: Vec<Value> = Vec::new();

    // File / window context rides along with the first message only, exactly
    // like ClaudeService.chat().
    if chat.is_empty() {
        match &context {
            Some(ChatContext::File { name, path }) => {
                if let Some(block) = file_block(path) {
                    content.push(block);
                }
                content.push(json!({ "type": "text", "text": format!("File: {name}") }));
            }
            Some(ChatContext::Window { app_name, title, url }) => {
                let mut text = format!("Context — App: {app_name}, Window: {title}");
                if let Some(url) = url {
                    text.push_str(&format!(", URL: {url}"));
                }
                content.push(json!({ "type": "text", "text": text }));
            }
            None => {}
        }
    }
    content.push(json!({ "type": "text", "text": query }));

    chat.push(json!({ "role": "user", "content": content }));

    let body = json!({
        "model": model,
        "max_tokens": MAX_TOKENS,
        "system": SYSTEM_PROMPT,
        "tools": [{ "type": "web_search_20260209", "name": "web_search", "max_uses": 5 }],
        "fallbacks": "default",
        "messages": chat.snapshot(),
    });

    let response = match call(&key, &body).await {
        Ok(v) => v,
        Err(err) => {
            chat.pop(); // keep the history consistent with what the model saw
            return Err(err);
        }
    };

    // A policy decline comes back as HTTP 200 with stop_reason "refusal".
    if response.get("stop_reason").and_then(Value::as_str) == Some("refusal") {
        chat.pop();
        let why = response
            .get("stop_details")
            .and_then(|d| d.get("explanation"))
            .and_then(Value::as_str)
            .unwrap_or("Claude declined this one.");
        return Err(why.to_string());
    }

    let Some(blocks) = response.get("content").and_then(Value::as_array).cloned() else {
        chat.pop();
        return Err("Unexpected API response.".into());
    };

    // Store the whole content — tool_use / tool_result blocks included — so the
    // next turn has the right context.
    chat.push(json!({ "role": "assistant", "content": blocks.clone() }));

    let text = blocks
        .iter()
        .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
        .filter_map(|b| b.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string();

    if text.is_empty() {
        return Err("No response text.".into());
    }
    Ok(ChatReply { text })
}

async fn call(key: &str, body: &Value) -> Result<Value, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(90))
        .build()
        .map_err(|e| e.to_string())?;

    let response = client
        .post(ENDPOINT)
        .header("x-api-key", key)
        .header("anthropic-version", ANTHROPIC_VERSION)
        .header("anthropic-beta", FALLBACK_BETA)
        .header("content-type", "application/json")
        .json(body)
        .send()
        .await
        .map_err(|e| format!("Network error: {e}"))?;

    let status = response.status();
    let text = response.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        // Surface the API's own message, which is what makes a bad key obvious.
        let detail = serde_json::from_str::<Value>(&text)
            .ok()
            .and_then(|v| {
                v.get("error")
                    .and_then(|e| e.get("message"))
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .unwrap_or_else(|| text.chars().take(200).collect());
        return Err(format!("Claude API {status}: {detail}"));
    }
    serde_json::from_str(&text).map_err(|e| format!("Bad API response: {e}"))
}

// ── OpenAI-compatible providers ───────────────────────────────────────────────

/// A server on this machine (Ollama, LM Studio…) needs no key.
fn is_local_url(url: &str) -> bool {
    let rest = url.split("://").nth(1).unwrap_or(url);
    let authority = rest.split('/').next().unwrap_or("");
    let host = match authority.strip_prefix('[') {
        Some(v6) => v6.split(']').next().unwrap_or(""),
        None => authority.split(':').next().unwrap_or(""),
    };
    let loopback_v4 = host.starts_with("127.") && host.split('.').all(|p| p.parse::<u8>().is_ok());
    host == "localhost" || host == "::1" || loopback_v4
}

async fn send_openai(
    chat: &Chat,
    cfg: &AiConfig,
    query: String,
    context: Option<ChatContext>,
) -> Result<ChatReply, String> {
    let base = cfg.base_url.trim().trim_end_matches('/');
    if !(base.starts_with("http://") || base.starts_with("https://")) {
        return Err("Set the API base URL in settings, for example https://api.openai.com/v1".into());
    }
    let model = cfg.model.trim();
    if model.is_empty() {
        return Err("Set a model name in settings.".into());
    }
    let key = secrets::get("ai-api-key");
    if key.is_none() && !is_local_url(base) {
        return Err("API key missing. Open settings.".into());
    }

    let mut parts: Vec<Value> = Vec::new();
    if chat.is_empty() {
        match &context {
            Some(ChatContext::File { name, path }) => {
                parts.push(openai_file_part(path));
                parts.push(json!({ "type": "text", "text": format!("File: {name}") }));
            }
            Some(ChatContext::Window { app_name, title, url }) => {
                let mut text = format!("Context — App: {app_name}, Window: {title}");
                if let Some(url) = url {
                    text.push_str(&format!(", URL: {url}"));
                }
                parts.push(json!({ "type": "text", "text": text }));
            }
            None => {}
        }
    }
    parts.push(json!({ "type": "text", "text": query }));

    // Plain text goes as a string: it is the one shape every server accepts.
    let content = match parts.as_slice() {
        [only] => only.get("text").cloned().unwrap_or(Value::Null),
        _ => Value::Array(parts),
    };
    chat.push(json!({ "role": "user", "content": content }));

    let mut messages = vec![json!({ "role": "system", "content": OPENAI_SYSTEM_PROMPT })];
    messages.extend(chat.snapshot());
    let body = json!({ "model": model, "messages": messages });

    let response = match call_openai(base, key.as_deref(), &body).await {
        Ok(v) => v,
        Err(err) => {
            chat.pop();
            return Err(err);
        }
    };

    let message = response
        .get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("message"));
    let text = match message.and_then(|m| m.get("content")) {
        Some(Value::String(s)) => s.trim().to_string(),
        Some(Value::Array(blocks)) => blocks
            .iter()
            .filter_map(|b| b.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n")
            .trim()
            .to_string(),
        _ => String::new(),
    };
    if text.is_empty() {
        chat.pop();
        let refusal = message
            .and_then(|m| m.get("refusal"))
            .and_then(Value::as_str)
            .unwrap_or("No response text.");
        return Err(refusal.to_string());
    }

    chat.push(json!({ "role": "assistant", "content": text }));
    Ok(ChatReply { text })
}

async fn call_openai(base: &str, key: Option<&str>, body: &Value) -> Result<Value, String> {
    let client = reqwest::Client::builder()
        // Local models can take a while to load before the first token.
        .timeout(std::time::Duration::from_secs(180))
        .build()
        .map_err(|e| e.to_string())?;

    let mut request = client
        .post(format!("{base}/chat/completions"))
        .header("content-type", "application/json")
        .json(body);
    if let Some(key) = key {
        request = request.bearer_auth(key);
    }
    let response = request.send().await.map_err(|e| format!("Network error: {e}"))?;

    let status = response.status();
    let text = response.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        let detail = serde_json::from_str::<Value>(&text)
            .ok()
            .and_then(|v| {
                v.get("error")
                    .and_then(|e| e.get("message").or(Some(e)))
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .unwrap_or_else(|| text.chars().take(200).collect());
        return Err(format!("API {status}: {detail}"));
    }
    serde_json::from_str(&text).map_err(|e| format!("Bad API response: {e}"))
}

/// Image → image_url part, text/code → inline text. PDFs have no portable
/// shape in this API, so they are reported instead of silently dropped.
fn openai_file_part(path: &str) -> Value {
    let ext = std::path::Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    let image = match ext.as_str() {
        "jpg" | "jpeg" => Some("image/jpeg"),
        "png" => Some("image/png"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        _ => None,
    };
    if let Some(media) = image {
        if let Ok(bytes) = std::fs::read(path) {
            return json!({
                "type": "image_url",
                "image_url": { "url": format!("data:{media};base64,{}", base64(&bytes)) },
            });
        }
    }
    if ext == "pdf" {
        return json!({ "type": "text", "text": "(A PDF was attached, but this provider can't read PDFs.)" });
    }

    let small = std::fs::metadata(path).map(|m| m.len() <= MAX_INLINE_TEXT).unwrap_or(false);
    match small.then(|| std::fs::read_to_string(path).ok()).flatten() {
        Some(text) => json!({ "type": "text", "text": format!("File contents:\n{text}") }),
        None => json!({ "type": "text", "text": "(The attached file couldn't be read as text.)" }),
    }
}

/// PDF → document block, image → image block, text/code → inline text.
/// Mirrors readFileAsBlock() in ClaudeService.swift.
fn file_block(path: &str) -> Option<Value> {
    let ext = std::path::Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    let media_type = match ext.as_str() {
        "pdf" => Some(("document", "application/pdf")),
        "jpg" | "jpeg" => Some(("image", "image/jpeg")),
        "png" => Some(("image", "image/png")),
        "gif" => Some(("image", "image/gif")),
        "webp" => Some(("image", "image/webp")),
        _ => None,
    };

    if let Some((block_type, media)) = media_type {
        let bytes = std::fs::read(path).ok()?;
        return Some(json!({
            "type": block_type,
            "source": { "type": "base64", "media_type": media, "data": base64(&bytes) },
        }));
    }

    let len = std::fs::metadata(path).ok()?.len();
    if len > MAX_INLINE_TEXT {
        return None;
    }
    let text = std::fs::read_to_string(path).ok()?;
    Some(json!({ "type": "text", "text": format!("File contents:\n{text}") }))
}

/// Small standalone base64 encoder — not worth another dependency.
/// Also used for Stripe's basic auth.
pub(crate) fn base64_for(bytes: &[u8]) -> String {
    base64(bytes)
}

fn base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(TABLE[(n >> 18) as usize & 63] as char);
        out.push(TABLE[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { TABLE[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { TABLE[n as usize & 63] as char } else { '=' });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::{base64, is_local_url};

    #[test]
    fn local_servers_need_no_key_but_hosted_ones_do() {
        assert!(is_local_url("http://localhost:11434/v1"));
        assert!(is_local_url("http://127.0.0.1:1234/v1"));
        assert!(is_local_url("http://[::1]:8080/v1"));
        assert!(!is_local_url("https://api.openai.com/v1"));
        assert!(!is_local_url("https://localhost.evil.example/v1"));
        assert!(!is_local_url("http://127.evil.example/v1"));
    }

    #[test]
    fn settings_are_clamped_to_what_the_island_can_draw() {
        let s = crate::settings::Settings {
            island_width: 5000.0,
            island_height_extra: -500.0,
            compact_height: 1.0,
            ai_provider: "bogus".into(),
            ..Default::default()
        }
        .sanitized();
        assert_eq!(s.island_width, crate::settings::ISLAND_WIDTH_MAX);
        assert_eq!(s.island_height_extra, crate::settings::ISLAND_HEIGHT_EXTRA_MIN);
        assert_eq!(s.compact_height, crate::settings::COMPACT_HEIGHT_MIN);
        assert_eq!(s.ai_provider, "anthropic");
    }

    #[test]
    fn base64_matches_rfc4648_vectors() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foob"), "Zm9vYg==");
        assert_eq!(base64(b"fooba"), "Zm9vYmE=");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
    }
}
