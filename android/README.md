# Coucou for Android

Mochi in your pocket. A Tauri 2 app that reuses Coucou for Windows' own Mochi engine, outfits,
weather and chat code (`windows/`), so the changes made there show up here too.

- **Mochi** with the wardrobe (seasonal outfits), tap him, he looks at your finger
- **Chat** with any provider: Claude, or any OpenAI-compatible API (OpenRouter, Groq, Together…)
- **Weather** for the city you pick
- **Settings**: provider, base URL, model, API key (kept in the app's private storage, never sent to the page), sounds

Not here yet: the link to a computer (approvals, live sessions) and the Knowura island.

## Build

```
cd android && npm install
export ANDROID_HOME=… NDK_HOME=…           # Android SDK 34 + NDK 26
npx tauri android build --debug --apk --target aarch64
```

The APK lands in `src-tauri/gen/android/app/build/outputs/apk/universal/debug/`.
