// Whisper, running on this PC's CPU in pure Rust (candle) for Knowura Speak.
//
// Nothing is downloaded until the user asks for it in the settings: the model's three files
// come from huggingface.co (openai/whisper-*) and live in %LOCALAPPDATA%\Coucou\models. After
// that, nothing about dictation touches the network: the audio never leaves this machine.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use candle_core::{Device, IndexOp, Tensor, D};
use candle_nn::VarBuilder;
use candle_transformers::models::whisper::{self as m, audio, Config};
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokenizers::Tokenizer;

use crate::island::WINDOW_LABEL;
use crate::{log, settings};

/// A model the user can pick: its id (also the folder name), the Hugging Face repository and
/// what it weighs.
pub struct ModelInfo {
    pub id: &'static str,
    pub repo: &'static str,
    pub label: &'static str,
    pub megabytes: u32,
    pub multilingual: bool,
}

pub const MODELS: &[ModelInfo] = &[
    ModelInfo { id: "tiny.en", repo: "openai/whisper-tiny.en", label: "Tiny · English", megabytes: 151, multilingual: false },
    ModelInfo { id: "base.en", repo: "openai/whisper-base.en", label: "Base · English", megabytes: 290, multilingual: false },
    ModelInfo { id: "small.en", repo: "openai/whisper-small.en", label: "Small · English", megabytes: 967, multilingual: false },
    ModelInfo { id: "base", repo: "openai/whisper-base", label: "Base · every language", megabytes: 290, multilingual: true },
    ModelInfo { id: "small", repo: "openai/whisper-small", label: "Small · every language", megabytes: 967, multilingual: true },
];

const FILES: [&str; 3] = ["config.json", "tokenizer.json", "model.safetensors"];

pub fn model_info(id: &str) -> Option<&'static ModelInfo> {
    MODELS.iter().find(|m| m.id == id)
}

pub fn model_dir(id: &str) -> PathBuf {
    settings::local_dir().join("models").join(id)
}

/// Whether every file of the model is on disk.
pub fn is_downloaded(id: &str) -> bool {
    let dir = model_dir(id);
    model_info(id).is_some() && FILES.iter().all(|f| dir.join(f).is_file())
}

// ── Mel filters ───────────────────────────────────────────────────────────────

/// Whisper's mel filter bank (librosa's `filters.mel`, Slaney scale and norm): `n_mels` rows of
/// `n_fft / 2 + 1` weights, row-major, in the layout candle's `pcm_to_mel` reads.
pub fn mel_filters(sample_rate: f64, n_fft: usize, n_mels: usize) -> Vec<f32> {
    let f_sp = 200.0 / 3.0;
    let min_log_hz = 1000.0;
    let min_log_mel = min_log_hz / f_sp;
    let log_step = (6.4f64).ln() / 27.0;
    let hz_to_mel = |hz: f64| if hz < min_log_hz { hz / f_sp } else { min_log_mel + (hz / min_log_hz).ln() / log_step };
    let mel_to_hz = |mel: f64| if mel < min_log_mel { mel * f_sp } else { min_log_hz * (log_step * (mel - min_log_mel)).exp() };

    let (lo, hi) = (hz_to_mel(0.0), hz_to_mel(sample_rate / 2.0));
    let points: Vec<f64> = (0..n_mels + 2)
        .map(|i| mel_to_hz(lo + (hi - lo) * i as f64 / (n_mels + 1) as f64))
        .collect();
    let bins = n_fft / 2 + 1;
    let freqs: Vec<f64> = (0..bins).map(|k| k as f64 * sample_rate / n_fft as f64).collect();

    let mut out = vec![0f32; n_mels * bins];
    for i in 0..n_mels {
        let (left, mid, right) = (points[i], points[i + 1], points[i + 2]);
        let norm = 2.0 / (right - left);
        for (k, &f) in freqs.iter().enumerate() {
            let lower = (f - left) / (mid - left);
            let upper = (right - f) / (right - mid);
            out[i * bins + k] = (lower.min(upper).max(0.0) * norm) as f32;
        }
    }
    out
}

// ── The model ─────────────────────────────────────────────────────────────────

pub struct Whisper {
    model: m::model::Whisper,
    tokenizer: Tokenizer,
    config: Config,
    filters: Vec<f32>,
    device: Device,
    multilingual: bool,
    sot: u32,
    eot: u32,
    transcribe: Option<u32>,
    no_timestamps: u32,
}

fn token(tok: &Tokenizer, name: &str) -> Result<u32, String> {
    tok.token_to_id(name).ok_or_else(|| format!("the tokenizer has no {name}"))
}

impl Whisper {
    pub fn load(id: &str) -> Result<Self, String> {
        let info = model_info(id).ok_or("unknown model")?;
        let dir = model_dir(id);
        if !is_downloaded(id) {
            return Err("The speech model is not downloaded yet.".into());
        }
        let config: Config = serde_json::from_slice(&std::fs::read(dir.join("config.json")).map_err(|e| e.to_string())?)
            .map_err(|e| format!("config.json: {e}"))?;
        let tokenizer = Tokenizer::from_file(dir.join("tokenizer.json")).map_err(|e| format!("tokenizer.json: {e}"))?;
        let device = Device::Cpu;
        // The weights are mapped from the file rather than read into memory twice.
        let vb = unsafe {
            VarBuilder::from_mmaped_safetensors(&[dir.join("model.safetensors")], m::DTYPE, &device)
                .map_err(|e| format!("model.safetensors: {e}"))?
        };
        let model = m::model::Whisper::load(&vb, config.clone()).map_err(|e| format!("loading the model: {e}"))?;
        let sot = token(&tokenizer, m::SOT_TOKEN)?;
        let eot = token(&tokenizer, m::EOT_TOKEN)?;
        let no_timestamps = token(&tokenizer, m::NO_TIMESTAMPS_TOKEN)?;
        let transcribe = tokenizer.token_to_id(m::TRANSCRIBE_TOKEN);
        let filters = mel_filters(m::SAMPLE_RATE as f64, m::N_FFT, config.num_mel_bins);
        Ok(Self { model, tokenizer, config, filters, device, multilingual: info.multilingual, sot, eot, transcribe, no_timestamps })
    }

    /// Speech to text. `pcm` is mono 16 kHz in -1..1; `language` is a code like "en" or "fr"
    /// (only used by the multilingual models).
    pub fn transcribe(&mut self, pcm: &[f32], language: &str) -> Result<String, String> {
        let frames = pcm.len() / m::HOP_LENGTH;
        if frames < 20 {
            return Ok(String::new());
        }
        let mel = audio::pcm_to_mel(&self.config, pcm, &self.filters);
        let total = mel.len() / self.config.num_mel_bins;
        let mel = Tensor::from_vec(mel, (1, self.config.num_mel_bins, total), &self.device).map_err(e2s)?;

        let mut text = String::new();
        let mut seek = 0;
        while seek < frames {
            let len = (frames - seek).min(m::N_FRAMES);
            let segment = mel.narrow(2, seek, len).map_err(e2s)?;
            let piece = self.decode(&segment, language)?;
            if !piece.is_empty() {
                if !text.is_empty() {
                    text.push(' ');
                }
                text.push_str(&piece);
            }
            seek += len;
        }
        Ok(text.trim().to_string())
    }

    fn decode(&mut self, mel: &Tensor, language: &str) -> Result<String, String> {
        self.model.reset_kv_cache();
        let features = self.model.encoder.forward(mel, true).map_err(e2s)?;

        let mut tokens = vec![self.sot];
        if self.multilingual {
            let lang = self
                .tokenizer
                .token_to_id(&format!("<|{language}|>"))
                .or_else(|| self.tokenizer.token_to_id("<|en|>"));
            if let Some(l) = lang {
                tokens.push(l);
            }
            if let Some(t) = self.transcribe {
                tokens.push(t);
            }
        }
        tokens.push(self.no_timestamps);
        let prompt_len = tokens.len();

        // Timestamps are never wanted: everything from <|notimestamps|> up is off the table, as are
        // the tokens the model's own config forbids.
        let vocab = self.config.vocab_size;
        let mask: Vec<f32> = (0..vocab as u32)
            .map(|i| if i >= self.no_timestamps || self.config.suppress_tokens.contains(&i) { f32::NEG_INFINITY } else { 0.0 })
            .collect();
        let mask = Tensor::new(mask.as_slice(), &self.device).map_err(e2s)?;

        let max_new = (self.config.max_target_positions / 2).min(224);
        for step in 0..max_new {
            let input = Tensor::new(tokens.as_slice(), &self.device).map_err(e2s)?.unsqueeze(0).map_err(e2s)?;
            let ys = self.model.decoder.forward(&input, &features, step == 0).map_err(e2s)?;
            let (_, seq, _) = ys.dims3().map_err(e2s)?;
            let last = ys.i((.., seq - 1..)).map_err(e2s)?;
            let logits = self.model.decoder.final_linear(&last).map_err(e2s)?.i(0).map_err(e2s)?.i(0).map_err(e2s)?;
            let mut logits = logits.broadcast_add(&mask).map_err(e2s)?;
            if step == 0 {
                // The very first token is never the end of the text nor a bare space.
                let mut v = logits.to_vec1::<f32>().map_err(e2s)?;
                v[self.eot as usize] = f32::NEG_INFINITY;
                if (220usize) < v.len() {
                    v[220] = f32::NEG_INFINITY;
                }
                logits = Tensor::new(v.as_slice(), &self.device).map_err(e2s)?;
            }
            let next = logits.argmax(D::Minus1).map_err(e2s)?.to_scalar::<u32>().map_err(e2s)?;
            if next == self.eot {
                break;
            }
            tokens.push(next);
            // A model that has fallen into a loop repeats the same few tokens: stop it.
            if looping(&tokens[prompt_len..]) {
                break;
            }
        }
        let spoken = &tokens[prompt_len..];
        self.tokenizer.decode(spoken, true).map(|s| s.trim().to_string()).map_err(|e| e.to_string())
    }
}

/// True when the tail of the output is the same short run of tokens, over and over.
fn looping(tokens: &[u32]) -> bool {
    for n in 1..=4usize {
        let reps = 6 / n.min(3) + 2;
        if tokens.len() >= n * reps {
            let tail = &tokens[tokens.len() - n * reps..];
            if tail.chunks(n).all(|c| c == &tail[..n]) {
                return true;
            }
        }
    }
    false
}

fn e2s(e: candle_core::Error) -> String {
    e.to_string()
}

// ── Download ──────────────────────────────────────────────────────────────────

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    pub model: String,
    /// "downloading" | "done" | "error"
    pub state: &'static str,
    pub done: u64,
    pub total: u64,
    pub message: Option<String>,
}

static DOWNLOADING: AtomicBool = AtomicBool::new(false);

fn report(app: &AppHandle, model: &str, state: &'static str, done: u64, total: u64, message: Option<String>) {
    let _ = app.emit_to(
        WINDOW_LABEL,
        "speak-model",
        DownloadProgress { model: model.to_string(), state, done, total, message: message.clone() },
    );
    let _ = app.emit_to("settings", "speak-model", DownloadProgress { model: model.to_string(), state, done, total, message });
}

/// Downloads a model's files one after the other, with progress events. Only ever started by the
/// user's click in the settings.
pub async fn download(app: AppHandle, id: String) {
    let Some(info) = model_info(&id) else { return };
    if DOWNLOADING.swap(true, Ordering::AcqRel) {
        return;
    }
    let result = download_files(&app, info).await;
    DOWNLOADING.store(false, Ordering::Release);
    match result {
        Ok(()) => {
            log::line(format!("speak: model {} downloaded", info.id));
            report(&app, info.id, "done", 1, 1, None);
        }
        Err(err) => {
            log::line(format!("speak: model download failed: {err}"));
            report(&app, info.id, "error", 0, 0, Some(err));
        }
    }
}

async fn download_files(app: &AppHandle, info: &ModelInfo) -> Result<(), String> {
    let dir = model_dir(info.id);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let http = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .read_timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| e.to_string())?;

    let total_estimate = info.megabytes as u64 * 1_000_000;
    let mut done_before = 0u64;
    for file in FILES {
        let target = dir.join(file);
        if target.is_file() {
            done_before += std::fs::metadata(&target).map(|m| m.len()).unwrap_or(0);
            continue;
        }
        let url = format!("https://huggingface.co/{}/resolve/main/{file}", info.repo);
        let mut response = http.get(&url).send().await.map_err(|e| format!("{file}: {e}"))?;
        if !response.status().is_success() {
            return Err(format!("{file}: the server answered {}", response.status()));
        }
        let part = target.with_extension("part");
        let mut out = std::fs::File::create(&part).map_err(|e| e.to_string())?;
        let mut got = 0u64;
        let mut last_report = std::time::Instant::now();
        while let Some(chunk) = response.chunk().await.map_err(|e| format!("{file}: {e}"))? {
            use std::io::Write;
            out.write_all(&chunk).map_err(|e| e.to_string())?;
            got += chunk.len() as u64;
            if last_report.elapsed() > Duration::from_millis(250) {
                last_report = std::time::Instant::now();
                report(app, info.id, "downloading", done_before + got, total_estimate.max(done_before + got), None);
            }
        }
        drop(out);
        std::fs::rename(&part, &target).map_err(|e| e.to_string())?;
        done_before += got;
    }
    Ok(())
}

pub fn delete(id: &str) {
    if model_info(id).is_some() {
        let _ = std::fs::remove_dir_all(model_dir(id));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_mel_filter_bank_has_whispers_shape() {
        let f = mel_filters(16000.0, 400, 80);
        assert_eq!(f.len(), 80 * 201);
        assert!(f.iter().all(|w| *w >= 0.0 && w.is_finite()));
        // Each filter is a triangle: its peak climbs with the filter's number.
        let peak = |i: usize| (0..201).max_by(|a, b| f[i * 201 + a].partial_cmp(&f[i * 201 + b]).unwrap()).unwrap();
        for i in 1..80 {
            assert!(peak(i) >= peak(i - 1), "filter {i} peaks before filter {}", i - 1);
        }
        assert!(peak(79) > 150);
        // Slaney normalisation: every filter covers the same energy, so none is all zeros.
        assert!((0..80).all(|i| (0..201).any(|k| f[i * 201 + k] > 0.0)));
    }

    #[test]
    fn a_loop_of_repeated_tokens_is_noticed() {
        assert!(looping(&[5, 6, 7, 7, 7, 7, 7, 7, 7, 7]));
        assert!(looping(&[1, 2, 3, 4, 5, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2]));
        assert!(!looping(&[1, 2, 3, 4, 5, 6, 7, 8, 9, 10]));
        assert!(!looping(&[]));
    }

    #[test]
    fn model_names_are_known() {
        assert!(model_info("base.en").is_some());
        assert!(model_info("../evil").is_none());
        assert!(!is_downloaded("../evil"));
    }
}
