# GreenFrame

**Xbox Remote Play into [SmoovPlay](https://github.com/smoovplay/smoovplay): AI frame generation for Xbox games on your PC.**

SmoovPlay streams a PS5 to your PC and has your graphics card add in-between frames, so a 30 fps game looks like
60, 90 or 120. GreenFrame does the same for an **Xbox**. It plays Xbox Remote Play in its own window and hands
every video frame straight to SmoovPlay. There's no screen capture: SmoovPlay gets the Xbox's own compressed
video, the same way it gets the PS5's.

> **Status: experimental (v0.1.0).** Tested end to end with a real Xbox: an H.264 2560×1440 stream at up to
> 60 fps reached SmoovPlay, and keyframes came back in about 180 ms whenever SmoovPlay asked for one. Frame
> generation on a 30 fps game hasn't been confirmed on real hardware yet. Reports are welcome in
> [Issues](../../issues).

## Built on SmoovPlay

**All the frame generation is SmoovPlay's.** [SmoovPlay](https://github.com/smoovplay/smoovplay), by the SmoovPlay
authors, does the hard part: GPU decoding, the AI in-between frames (RIFE), upscaling (AMD FSR 1, NVIDIA RTX
VSR), frame pacing, the settings menu and the window you watch. GreenFrame only gets the Xbox's video into
SmoovPlay, through the **frame tap** SmoovPlay built for its PS5 support and documents for other apps to use.

If GreenFrame is useful to you, please star and support [SmoovPlay](https://github.com/smoovplay/smoovplay) too.
GreenFrame is an unofficial add-on: report GreenFrame problems [here](../../issues), not to the SmoovPlay team.
See [Credits](#credits) for everything GreenFrame uses.

```
 Xbox ──Remote Play (WebRTC)──▶ GreenFrame window (xbox.com/play)
                                  │ hook: a copy of every H.264 frame, before it's decoded
                                  ▼
                                GreenFrame main process
                                  │ ws://127.0.0.1:47820
                                  ▼
                                GreenFrame bridge ──shared memory "Local\smoovplay-tap"──▶ SmoovPlay
                                  ▲                                            (GPU decode → RIFE → your screen)
                                  └──────────────── "send a keyframe" ◀──────────────────────┘
```

## What you need

- Windows 10/11 PC with a graphics card that SmoovPlay supports
- **SmoovPlay 0.3.4 or newer** installed ([Releases](https://github.com/smoovplay/smoovplay/releases)), with its setup
  finished. Older versions work, but read 30 fps Xbox games less reliably; GreenFrame says so when it starts.
- An Xbox Series X|S or Xbox One with remote play on. On the console: **Settings → Devices & connections →
  Remote features → Enable remote features**, and set power mode to **Sleep**.
- A controller connected to the PC
- Wired Ethernet for the Xbox and the PC, if you can

## Install

1. Download `GreenFrame-0.1.0-win64.zip` from [Releases](../../releases) and **unzip it** to a folder of your own.
   Don't run it from inside the zip.
2. Run **GreenFrame.exe**. Release builds are code-signed (publisher: Nathan Pittman, via Microsoft Artifact
   Signing).

## Use

1. GreenFrame opens Xbox Remote Play and starts SmoovPlay in the background, waiting for frames.
2. Sign in with your Microsoft account (first time only). Open the menu at the top-left of the page, choose
   **Remote play**, pick your console and **Connect**.
3. When the stream starts, SmoovPlay opens its window with the picture and GreenFrame minimises itself. It keeps
   streaming, playing sound and reading your controller while minimised. When you close SmoovPlay, GreenFrame
   comes back.

The first time SmoovPlay sees a new stream resolution (the Xbox may send 1440p), it spends about a minute
optimising its AI model for it. It only does that once per resolution.

In SmoovPlay's window: **S** stats overlay, **I** frame generation on/off (an instant A/B comparison), **F** full
screen, **M** settings.

**Frame generation only fills gaps.** On a game, or a menu like the Xbox home screen, that already runs at 60 fps,
SmoovPlay passes the frames through and says so. Try a 30 fps game, or a game's Quality/Fidelity mode.

### GreenFrame's menu

| | |
|---|---|
| Back to Xbox Remote Play | reload xbox.com/play |
| Start / Stop SmoovPlay | Ctrl+Shift+S starts SmoovPlay again after you've closed it |
| Restart bridge | if the log says the bridge stopped |
| Minimise GreenFrame while SmoovPlay is showing | on by default; turn off to keep GreenFrame open behind SmoovPlay |
| Open logs folder / Open settings | `%APPDATA%\GreenFrame` |

### Settings

`%APPDATA%\GreenFrame\config.json`:

| | |
|---|---|
| `smoovplayDir` | where SmoovPlay is installed. Leave blank: GreenFrame finds it through SmoovPlay's Apps & features entry (any folder), else `%LOCALAPPDATA%\Programs\SmoovPlay` |
| `startSmoovPlay` | start SmoovPlay with GreenFrame (default `true`) |
| `smoovplayArgs` | extra flags for SmoovPlay's `run.py --source tap`, e.g. `["--display", "--hz", "120"]` |
| `minimiseWhilePlaying` | minimise GreenFrame while SmoovPlay shows the picture (default `true`) |
| `port` | the bridge's local port (default 47820) |

SmoovPlay's own settings (frame rate, upscaler, AI engine, full screen) are the ones you choose in its **M** menu.

## Good to know

- **It adds delay.** Frame generation holds each real frame back until the next one arrives, as in SmoovPlay.
  That's fine for slower games and noticeable for fast shooters.
- **Most Xbox games already run near 60 fps.** Frame generation only helps a game running at 30. If SmoovPlay says
  *"Game at 60 fps: no gaps to fill"*, switch the game to its Quality/Fidelity mode, or turn frame generation off with
  **I** to skip its delay.
- **On an ultrawide**, SmoovPlay 0.3.7+ has *Fill the screen* (Fit, Zoom, Stretch or Panorama) in its settings.
- **Set your monitor to its full refresh rate** in Windows (Settings → System → Display → Advanced display), or
  SmoovPlay can't show more than 60 fps.
- **The stream has to be H.264.** GreenFrame asks for it, and it's what the Xbox sent in testing. If `bridge.log`
  mentions another codec, open an issue.
- SmoovPlay's delay test (**L**) doesn't work with GreenFrame yet. It needs to press a controller button on the
  console.

## Troubleshooting

Open **GreenFrame → Open logs folder**:

- `bridge.log`: a working stream shows `browser connected (GreenFrame app)`, then
  `stream live in SmoovPlay: H.264 2560x1440`, and `keyframe arrived … ms after the request` lines.
- `smoovplay.log`: SmoovPlay's own output, such as `[run] playing` and the frame rate it measures.
- `page.log`: GreenFrame's messages from the player page.

| Problem | Try |
|---|---|
| "SmoovPlay wasn't found" | install SmoovPlay, or set `smoovplayDir` |
| `bridge.log` never says `browser connected` | make sure remote play is connected (your console's home screen is showing); check nothing else uses port 47820 |
| Connected, but never `stream live` | the stream isn't H.264 (see `bridge.log`), or no keyframe yet: reconnect remote play |
| SmoovPlay doesn't open for a minute | first time at this resolution or setting: it's optimising (see `smoovplay.log`). Don't close GreenFrame meanwhile, or it starts over |
| Faint flicker on an OLED or VA monitor | G-Sync/FreeSync flicker as the frame rate varies: in NVIDIA Control Panel, give SmoovPlay's `runtime\python\python.exe` *Monitor Technology: Fixed Refresh* and *Vertical sync: On* |
| Controller stops when GreenFrame minimises | untick *Minimise GreenFrame while SmoovPlay is showing* and open an issue |
| Picture stutters, frame rate jumps around | wire the Xbox and the PC with Ethernet |

## How it works

| | |
|---|---|
| `app/hook/inject.js` | Runs in the xbox.com page before the page's own scripts. It wraps `RTCPeerConnection` and pipes the stream through WebRTC encoded streams (`createEncodedStreams`), copying each H.264 frame before the player decodes it. Sound, controller input and the player itself pass through unchanged. It prefers H.264 when the stream is set up. It also tells the page it's visible and focused, so remote play keeps going while GreenFrame is minimised. |
| `app/hook/relay.js`, `app/preload.js` | The preload puts the hook into the page. The relay passes frames to the main process over Electron IPC. The page can't connect to the bridge itself, because xbox.com's Content Security Policy (`connect-src`) blocks `ws://127.0.0.1`. |
| `app/bridge-link.js` | Main process: one WebSocket per video stream to the bridge, with retries. It passes SmoovPlay's keyframe requests back to the page. |
| `app/main.js` | The window and Microsoft sign-in. It starts and stops the bridge and SmoovPlay with SmoovPlay's bundled Python. It watches SmoovPlay's output for `[run] playing` to minimise itself and restores when SmoovPlay exits. |
| `bridge/greenframe_bridge.py` | Runs on SmoovPlay's Python and writes frames into SmoovPlay's frame tap (`Local\smoovplay-tap`, the compressed layout chiaki-ng uses for the PS5), using SmoovPlay's own writer class. SmoovPlay then treats the Xbox like a PS5: GPU decode, and repeated frames told apart by their size. The codec header goes first, as a packet of its own. The size comes from the stream's SPS, and a resolution change restarts the session. |

**Keyframes.** SmoovPlay needs a keyframe to start decoding, and asks for one when it joins a stream or falls
behind. There's no API for a WebRTC receiver to ask for one directly. The hook hands the hidden player one
deliberately broken frame; the player's decoder fails and asks the Xbox for a fresh keyframe itself. That took
about 180 ms on a real Xbox, against about 3 s for simply dropping frames. Until the keyframe arrives, the bridge
keeps back frames SmoovPlay couldn't decode.

**Why encoded streams and not `RTCRtpScriptTransform`:** in Chrome 153 the script transform exists, but received
frames bypass it (tested). The hook uses it only in browsers without encoded streams.

## Backup: browser extension

`scripts/build-extension.sh` builds the same hook as an unpacked extension for Edge or Chrome (`dist/extension`).
Load it from `edge://extensions` (Developer mode → Load unpacked) and run the bridge and SmoovPlay yourself:

```powershell
& "$env:LOCALAPPDATA\Programs\SmoovPlay\runtime\python\python.exe" bridge\greenframe_bridge.py
& "$env:LOCALAPPDATA\Programs\SmoovPlay\runtime\python\python.exe" "$env:LOCALAPPDATA\Programs\SmoovPlay\app\run.py" --source tap --display
```

The extension hasn't been tested on xbox.com yet. The app is the supported way.

## Building

```bash
cd app
npm install
npm start            # run from source (Windows, with SmoovPlay installed)
npm run dist:win     # dist/GreenFrame-win32-x64 (works from Linux too)
../scripts/build-extension.sh
```

To sign a Windows build, sign every `.exe` and `.dll` in `dist/GreenFrame-win32-x64` that doesn't already carry a
valid signature, using `signtool` with your own certificate (or Microsoft Artifact Signing's dlib), then zip it.
Only the binaries are signed; the app's JavaScript under `resources\app` can change without re-signing.

## Testing

`test/run-app.sh` runs the whole chain without an Xbox:

- A local page streams video, sound and a data channel over WebRTC loopback. It carries a `connect-src` policy
  like xbox.com's.
- GreenFrame hooks it as it would xbox.com, and hides its window partway through, the way it minimises for
  SmoovPlay.
- A stand-in bridge saves the H.264 it receives and asks for a keyframe every 3 s.
- The test checks that every frame decodes with ffmpeg, that frames keep flowing while hidden, that the sound and
  data channel are unaffected, and that the page never sees the focus loss.

Latest run: 945 frames, 0 decode errors, keyframes in 41–50 ms.

## Credits

GreenFrame stands on other people's work. Here's what it uses and from whom.

**[SmoovPlay](https://github.com/smoovplay/smoovplay)** by the SmoovPlay authors (MIT License). GreenFrame is
an add-on for SmoovPlay and needs it installed. From SmoovPlay, GreenFrame uses:

- **The frame tap:** SmoovPlay's shared-memory interface for other apps (`Local\smoovplay-tap`, read by
  `run.py --source tap`), with the compressed-frame layout, codec header, keyframe requests and size-based
  repeat detection that SmoovPlay designed for its chiaki-ng PS5 path. GreenFrame writes exactly what SmoovPlay's
  reader expects.
- **SmoovPlay's own writer class**, `framegen.chiaki_tap.FrameTap`. The bridge imports it at run time from your
  SmoovPlay installation, so the layout always matches. It isn't copied into GreenFrame.
- **SmoovPlay's bundled Python runtime**, which runs the bridge, and SmoovPlay's `run.py`, which GreenFrame starts.
- **A small adapted function:** the H.264 start-code scan in `bridge/greenframe_bridge.py` is adapted from
  `nal_units()` in SmoovPlay's `framegen/chiaki_tap.py`. Copyright (c) 2026 the SmoovPlay authors, MIT License,
  in full in [licenses/SmoovPlay-LICENSE.txt](licenses/SmoovPlay-LICENSE.txt).
- **Ideas:** minimising GreenFrame while SmoovPlay shows the picture follows SmoovPlay's "Minimise chiaki-ng"
  setting, and sending the codec header as a packet of its own follows how SmoovPlay's chiaki-ng tap does it.

**What SmoovPlay builds on**, credited as in SmoovPlay's own third-party notices. GreenFrame doesn't include any
of these; they reach you through SmoovPlay:

- [chiaki-ng](https://github.com/streetpea/chiaki-ng) (AGPL-3.0): the PS5 Remote Play client that SmoovPlay's
  frame tap was first built for.
- RIFE: model weights trained by hzwer ([Practical-RIFE](https://github.com/hzwer/Practical-RIFE), MIT), with
  network definitions and weights published by HolyWu ([vs-rife](https://github.com/HolyWu/vs-rife), MIT). It
  makes the in-between frames.
- AMD FidelityFX Super Resolution 1.0 (MIT, Advanced Micro Devices, Inc.): upscaling.
- PyTorch, NVIDIA TensorRT, FFmpeg/PyAV and the other libraries listed in SmoovPlay's `THIRD_PARTY_NOTICES.txt`.

**Bundled with GreenFrame:** [Electron](https://www.electronjs.org/) (MIT) and Chromium, whose licenses ship in
the release folder (`LICENSE`, `LICENSES.chromium.html`).

**Built with Claude:** GreenFrame was designed, written and tested by Nathan Pittman working with
[Claude](https://claude.ai), Anthropic's AI. Commits Claude wrote carry a `Co-Authored-By: Claude` line.

**Used, not bundled:** Microsoft's Xbox Remote Play at xbox.com/play, with your own account and console.
[FFmpeg](https://ffmpeg.org/) is used by the test script only.

## License

GreenFrame's own code is MIT-licensed (see [LICENSE](LICENSE)), © 2026 Nathan Pittman. The adapted SmoovPlay
function keeps SmoovPlay's notice ([licenses/SmoovPlay-LICENSE.txt](licenses/SmoovPlay-LICENSE.txt)). See
[NOTICE](NOTICE) for the summary.

GreenFrame is an unofficial add-on. It isn't affiliated with or endorsed by the SmoovPlay authors, Microsoft or
Xbox. Xbox is a trademark of Microsoft Corporation.
