# GreenFrame

**Xbox Remote Play into [SmoovPlay](https://github.com/smoovplay/smoovplay): AI frame generation for Xbox games on your PC.**

SmoovPlay streams a PS5 to your PC and has your graphics card add in-between frames, so a 30 fps game looks like
60, 90 or 120. GreenFrame does the same for an **Xbox**. It plays Xbox Remote Play in its own window and hands
every video frame straight to SmoovPlay. There's no screen capture: SmoovPlay gets the Xbox's own compressed
video, the same way it gets the PS5's.

> **Status: experimental.** The whole chain is tested with a stand-in WebRTC stream (see [Testing](#testing)),
> not yet with a real Xbox. Please report how it goes in Issues.

```
Xbox ─Remote Play (WebRTC)─▶ GreenFrame window (xbox.com/play)
                                  │  hook: a copy of each H.264 frame, before it's decoded
                                  ▼
                             GreenFrame bridge ──shared memory "Local\smoovplay-tap"──▶ SmoovPlay
                                  ▲                                                    (decode → RIFE → your screen)
                                  └──────────── "send a keyframe" ◀────────────────────┘
```

## What you need

- Windows 10/11 PC with a graphics card that SmoovPlay supports
- **SmoovPlay** installed ([Releases](https://github.com/smoovplay/smoovplay/releases)), with its setup finished
- An Xbox Series X|S or Xbox One with remote play turned on: **Settings → Devices & connections → Remote
  features → Enable remote features**, and power mode set to **Sleep**
- A controller connected to the PC
- Wired Ethernet for the Xbox and the PC, if you can

## Install

1. Download `GreenFrame-win32-x64.zip` from [Releases](../../releases) and unzip it anywhere.
2. Run **GreenFrame.exe**.

## Use

1. GreenFrame opens Xbox Remote Play and starts SmoovPlay in the background.
2. Sign in with your Microsoft account (the first time only), pick your console and start remote play.
3. SmoovPlay's window opens over GreenFrame's with the smoothed picture. Press **M** in it for its settings and
   **F** for full screen. GreenFrame keeps streaming, playing sound and reading your controller behind it.

GreenFrame's menu has: **Start / Stop SmoovPlay** (Ctrl+Shift+S), **Restart bridge**, **Open logs folder**,
**Open settings**, and full screen (F11).

### Settings

`%APPDATA%\GreenFrame\config.json`:

| | |
|---|---|
| `smoovplayDir` | where SmoovPlay is installed (default `%LOCALAPPDATA%\Programs\SmoovPlay`) |
| `startSmoovPlay` | start SmoovPlay with GreenFrame (default `true`) |
| `smoovplayArgs` | extra flags for SmoovPlay's `run.py --source tap`, e.g. `["--display", "--hz", "120"]` |
| `port` | the bridge's local port (default 47820) |

SmoovPlay's own settings (frame rate, upscaler, AI engine) are the ones you saved in SmoovPlay.

## Good to know

- **It adds delay.** Frame generation holds each real frame back until the next one arrives, as in SmoovPlay.
  That's fine for slower games and noticeable for fast shooters.
- **Set your monitor to its full refresh rate** in Windows (Settings → System → Display → Advanced display), or
  SmoovPlay can't show more than 60 fps.
- The stream has to be **H.264**. GreenFrame asks for it, and it's what Xbox Remote Play in the browser uses. If the
  log says another codec, open an issue.
- When SmoovPlay joins a stream already in progress, it asks for a keyframe. GreenFrame gets one by handing the
  hidden player one deliberately broken frame. That makes the player ask the Xbox for a fresh keyframe, which
  arrives within about 50 ms in testing. The hidden player may smear for a moment; SmoovPlay's picture doesn't.

## Troubleshooting

Open **GreenFrame → Open logs folder**:

- `bridge.log` should show `browser connected`, then `stream live in SmoovPlay: H.264 1920x1080`.
- `smoovplay.log` is SmoovPlay's own output.
- `page.log` has GreenFrame's messages from the player page.

| Problem | Try |
|---|---|
| "SmoovPlay wasn't found" | install SmoovPlay, or set `smoovplayDir` |
| `bridge.log` never says `browser connected` | start remote play; check nothing else uses port 47820 |
| Connected, but never `stream live` | the stream isn't H.264 (see `bridge.log`), or no keyframe yet: reconnect remote play |
| Controller stops working behind SmoovPlay | click GreenFrame's window once so it has focus, then go back to SmoovPlay |

## Backup: browser extension

If you'd rather use Edge or Chrome, `dist/extension` (built by `scripts/build-extension.sh`) has the same hook as
an unpacked extension. Load it from `edge://extensions` (Developer mode → Load unpacked) and run the bridge with
SmoovPlay's Python:

```powershell
& "$env:LOCALAPPDATA\Programs\SmoovPlay\runtime\python\python.exe" bridge\greenframe_bridge.py
& "$env:LOCALAPPDATA\Programs\SmoovPlay\runtime\python\python.exe" "$env:LOCALAPPDATA\Programs\SmoovPlay\app\run.py" --source tap --display
```

The browser may slow down a stream that's covered by another window. The GreenFrame app turns that off.

## How it works

| | |
|---|---|
| `app/hook/inject.js` | runs in the page before its own scripts. It wraps `RTCPeerConnection` and uses WebRTC encoded streams (`createEncodedStreams`) to copy each H.264 frame before the player decodes it. Sound, input and the player itself pass through unchanged. It prefers H.264 when the stream is set up. |
| `app/hook/relay.js` | GreenFrame's side of the page. It sends frames to the bridge over a local WebSocket, and keyframe requests back to the page. |
| `app/main.js`, `app/preload.js` | the Electron app: the window, Microsoft sign-in, starting and stopping the bridge and SmoovPlay, and keeping a covered window running |
| `bridge/greenframe_bridge.py` | runs on SmoovPlay's bundled Python. It writes frames into SmoovPlay's [frame tap](https://github.com/smoovplay/smoovplay) (`Local\smoovplay-tap`, the compressed layout chiaki-ng uses), with SmoovPlay's own writer class, so SmoovPlay treats the Xbox like a PS5: GPU decode, and repeated frames told apart by their size. The codec header goes in first as a packet of its own. When SmoovPlay asks for a keyframe, the bridge withholds frames it couldn't decode until the keyframe arrives. |

Chrome 153 has `RTCRtpScriptTransform`, but frames bypass it on the receiving side (tested), so encoded streams
are the main path and the worker transform is only a fallback.

## Building

```bash
cd app
npm install
npm start            # run from source (Windows, with SmoovPlay installed)
npm run dist:win     # dist/GreenFrame-win32-x64 (works from Linux too)
../scripts/build-extension.sh
```

## Testing

`test/run-app.sh` runs the whole chain without an Xbox. A local page streams video, sound and a data channel over
WebRTC loopback. GreenFrame hooks it like xbox.com, and a stand-in bridge saves the H.264, asking for a keyframe
every 3 s. ffmpeg then checks every frame decodes. Latest run: 1116 frames, 0 decode errors, keyframes back in
27–39 ms, sound and data channel unaffected.

## Credits and license

GreenFrame is MIT-licensed (see [LICENSE](LICENSE)). It sends frames to **SmoovPlay** by the SmoovPlay
developers (MIT), through SmoovPlay's frame tap, and needs SmoovPlay installed. It includes no SmoovPlay code;
see [NOTICE](NOTICE). Built on [Electron](https://www.electronjs.org/) (MIT).

GreenFrame isn't affiliated with or endorsed by Microsoft, Xbox or SmoovPlay. Xbox is a trademark of Microsoft.
It uses Xbox Remote Play as Microsoft offers it at xbox.com/play, with your own account and console.
