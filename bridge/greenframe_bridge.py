"""GreenFrame bridge: Xbox Remote Play's H.264 frames from the GreenFrame app (or extension) -> SmoovPlay's frame tap.

    GreenFrame window or browser (xbox.com/play)
        --ws://127.0.0.1:47820--> this bridge --shared memory "Local\\smoovplay-tap"--> run.py --source tap

The extension copies every compressed video frame the Xbox sends (before the browser decodes it) and sends it
here. The bridge writes it into SmoovPlay's frame tap with SmoovPlay's own writer (framegen.chiaki_tap.FrameTap),
in the same compressed layout chiaki-ng uses for the PS5, so SmoovPlay treats it like a PS5 stream: GPU decode,
repeats told apart by frame size. When SmoovPlay asks for a keyframe, the bridge asks the browser for one.

Run it with SmoovPlay's bundled Python (its path file already includes SmoovPlay's app folder):
    "%LOCALAPPDATA%\\Programs\\SmoovPlay\\runtime\\python\\python.exe" greenframe_bridge.py

Options: --port 47820, --tap NAME (default Local\\smoovplay-tap), --fake (no shared memory: log only, for tests).
"""
from __future__ import annotations

import argparse
import asyncio
import base64
import hashlib
import json
import os
import struct
import sys
import time

PORT = 47820
TAP_NAME = "Local\\smoovplay-tap"
CODEC_H264 = 0
FRAME_MAGIC = b"GRFM"
FRAME_HEADER = struct.Struct("<4sBxxxiHH")  # magic, flags (bit 0 keyframe), frames_lost, width, height
ALLOWED_ORIGINS = ("chrome-extension://", "extension://", "https://www.xbox.com", "https://xbox.com")
MAX_MESSAGE = 8 * 1024 * 1024
EXTRA_ORIGINS: tuple = ()  # --allow-origin (testing)


def log(msg: str) -> None:
    print(f"[greenframe {time.strftime('%H:%M:%S')}] {msg}", flush=True)


# ---------------------------------------------------------------- H.264 bitstream helpers

def nal_units(data: bytes):
    """(type, NAL unit with a 4-byte start code) for each NAL unit of an Annex-B access unit."""
    starts, i = [], 0
    while (i := data.find(b"\x00\x00\x01", i)) >= 0:
        starts.append(i)
        i += 3
    for k, s in enumerate(starts):
        end = starts[k + 1] if k + 1 < len(starts) else len(data)
        if end - 1 > s + 3 and k + 1 < len(starts) and data[end - 1] == 0:  # 4-byte start code of the next unit
            end -= 1
        if s + 3 < len(data):
            yield data[s + 3] & 0x1F, b"\x00\x00\x00\x01" + data[s + 3:end]


class Bits:
    def __init__(self, rbsp: bytes) -> None:
        self.b, self.i = rbsp, 0

    def u(self, n: int) -> int:
        v = 0
        for _ in range(n):
            byte = self.b[self.i >> 3] if (self.i >> 3) < len(self.b) else 0
            v = (v << 1) | ((byte >> (7 - (self.i & 7))) & 1)
            self.i += 1
        return v

    def ue(self) -> int:
        zeros = 0
        while self.u(1) == 0:
            zeros += 1
            if zeros > 31:
                raise ValueError("bad exp-golomb")
        return (1 << zeros) - 1 + self.u(zeros)

    def se(self) -> int:
        k = self.ue()
        return (k + 1) // 2 if k & 1 else -(k // 2)


def sps_size(sps_nal: bytes) -> tuple[int, int] | None:
    """(width, height) from an H.264 SPS NAL unit (with or without start code), cropping applied."""
    try:
        i = sps_nal.find(b"\x00\x00\x01")
        body = sps_nal[i + 4:] if i >= 0 else sps_nal[1:]
        rbsp, zeros = bytearray(), 0
        for byte in body:  # strip emulation-prevention bytes
            if zeros >= 2 and byte == 3:
                zeros = 0
                continue
            rbsp.append(byte)
            zeros = zeros + 1 if byte == 0 else 0
        r = Bits(bytes(rbsp))
        profile = r.u(8)
        r.u(16)  # constraint flags + level
        r.ue()  # seq_parameter_set_id
        chroma = 1
        if profile in (100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135):
            chroma = r.ue()
            if chroma == 3:
                r.u(1)
            r.ue(); r.ue(); r.u(1)  # bit depths, qpprime bypass
            if r.u(1):  # scaling matrices present
                for k in range(8 if chroma != 3 else 12):
                    if r.u(1):
                        last, nxt = 8, 8
                        for _ in range(16 if k < 6 else 64):
                            if nxt:
                                nxt = (last + r.se() + 256) % 256
                            last = nxt or last
        r.ue()  # log2_max_frame_num
        poc = r.ue()
        if poc == 0:
            r.ue()
        elif poc == 1:
            r.u(1); r.se(); r.se()
            for _ in range(r.ue()):
                r.se()
        r.ue(); r.u(1)  # max refs, gaps allowed
        w_mbs, h_map = r.ue() + 1, r.ue() + 1
        frame_mbs_only = r.u(1)
        if not frame_mbs_only:
            r.u(1)
        r.u(1)  # direct_8x8
        w, h = w_mbs * 16, (2 - frame_mbs_only) * h_map * 16
        if r.u(1):  # cropping
            cl, cr, ct, cb = r.ue(), r.ue(), r.ue(), r.ue()
            cx = 1 if chroma == 0 or chroma == 3 else 2
            cy = (1 if chroma in (0, 2, 3) else 2) * (2 - frame_mbs_only)
            w -= (cl + cr) * cx
            h -= (ct + cb) * cy
        return (w, h) if 16 <= w <= 8192 and 16 <= h <= 8192 else None
    except (ValueError, IndexError):
        return None


# ---------------------------------------------------------------- the tap side

class FakeTap:
    """Stands in for SmoovPlay's FrameTap off Windows or with --fake: counts and optionally saves frames."""

    def __init__(self, save: str | None = None) -> None:
        self.frames, self.idr_wanted, self.f = 0, False, open(save, "wb") if save else None
        self.began: list[tuple] = []

    def begin(self, codec, width, height, max_fps=60, **_):
        self.began.append((codec, width, height, max_fps))
        log(f"[fake tap] begin codec={codec} {width}x{height}@{max_fps}")

    def push(self, data, frames_lost=0, recovered=False, new=None):
        self.frames += 1
        if self.f:
            self.f.write(data)
            self.f.flush()

    idr_every = 0.0  # testing: act as if SmoovPlay asked for a keyframe this often

    def take_idr_request(self) -> bool:
        if self.idr_every and time.perf_counter() - getattr(self, "_t_idr", 0) > self.idr_every:
            self._t_idr = time.perf_counter()
            self.idr_wanted = True
        r, self.idr_wanted = self.idr_wanted, False
        return r

    def heartbeat(self) -> None: ...

    def end(self):
        log("[fake tap] end")

    def close(self):
        if self.f:
            self.f.close()


def open_tap(name: str):
    sys.path.insert(0, os.path.join(os.path.dirname(sys.executable), "..", "..", "app"))
    from framegen.chiaki_tap import FrameTap
    return FrameTap(name, name + "-frame")  # the event name framegen.tap.open_tap uses


class Session:
    """One video stream from the browser into the tap. The tap starts at the first keyframe with an SPS (the
    size comes from it); the codec header goes in first as a packet of its own, the way chiaki-ng sends it."""

    def __init__(self, tap) -> None:
        self.tap = tap
        self.live = False
        self.size: tuple[int, int] | None = None
        self.params = b""  # latest SPS+PPS
        self.frames = self.dropped_wait = self.lost = self.withheld = 0
        self.t0 = time.perf_counter()
        self.key_wanted_at: float | None = None  # SmoovPlay asked for a keyframe; deltas are withheld till then

    def frame(self, data: bytes, key: bool, lost: int, w: int, h: int) -> bool:
        """Returns True if the browser should be asked for a keyframe (waiting for one to start)."""
        units = list(nal_units(data))
        if not units:
            return False
        sps = [u for t, u in units if t == 7]
        pps = [u for t, u in units if t == 8]
        key = key or any(t == 5 for t, _ in units)
        if sps and pps:
            self.params = b"".join(sps + pps)
        if not self.live:
            if not (key and self.params):
                self.dropped_wait += 1
                return self.dropped_wait % 30 == 1
            size = sps_size(sps[0]) if sps else None
            self.size = size or ((w, h) if w and h else (1920, 1080))
            self.tap.begin(CODEC_H264, self.size[0], self.size[1], 60)
            self.tap.push(self.params)  # the codec header, on its own
            self.live = True
            log(f"stream live in SmoovPlay: H.264 {self.size[0]}x{self.size[1]}"
                f" (waited {self.dropped_wait} frames for a keyframe)")
        elif sps:
            size = sps_size(sps[0])
            if size and size != self.size:  # resolution change: restart the tap session
                log(f"resolution changed {self.size} -> {size}: restarting the stream in SmoovPlay")
                self.size = size
                self.tap.begin(CODEC_H264, size[0], size[1], 60)
                self.tap.push(self.params)
        if self.key_wanted_at is not None:
            if not key:
                self.withheld += 1  # SmoovPlay can't decode these until a keyframe: don't send it garbage
                return time.perf_counter() - self.key_wanted_at > 1.0 and self.withheld % 30 == 0
            log(f"keyframe arrived {1000 * (time.perf_counter() - self.key_wanted_at):.0f} ms after the request")
            self.key_wanted_at = None
        if key and not sps and self.params:
            data = self.params + data  # a keyframe the decoder can start from on its own
        self.tap.push(data, frames_lost=lost)
        self.frames += 1
        self.lost += max(0, lost)
        return False

    def end(self) -> None:
        if self.live:
            self.tap.end()
            secs = time.perf_counter() - self.t0
            log(f"stream ended: {self.frames} frames in {secs:.0f} s ({self.frames / max(secs, 1e-3):.1f} fps), "
                f"{self.lost} lost")
        self.live = False


# ---------------------------------------------------------------- a minimal WebSocket server (RFC 6455)

class WSClosed(Exception):
    pass


class WS:
    def __init__(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        self.r, self.w = reader, writer

    @staticmethod
    async def accept(reader, writer) -> tuple["WS", str] | None:
        head = await reader.readuntil(b"\r\n\r\n")
        lines = head.decode("latin-1").split("\r\n")
        hdr = {k.strip().lower(): v.strip() for k, _, v in (l.partition(":") for l in lines[1:] if ":" in l)}
        origin = hdr.get("origin", "")
        if "websocket" not in hdr.get("upgrade", "").lower() or "sec-websocket-key" not in hdr:
            writer.write(b"HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 30\r\n\r\n"
                         b"GreenFrame bridge running\n")
            await writer.drain()
            return None
        # A browser always sends Origin, so the check keeps other websites out. GreenFrame's app connects from its
        # main process, which sends none.
        if origin and not origin.startswith(ALLOWED_ORIGINS + EXTRA_ORIGINS):
            log(f"refused a connection from origin {origin!r}")
            writer.write(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n")
            await writer.drain()
            return None
        acc = base64.b64encode(hashlib.sha1((hdr["sec-websocket-key"] +
                                             "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()).decode()
        writer.write(("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                      f"Sec-WebSocket-Accept: {acc}\r\n\r\n").encode())
        await writer.drain()
        return WS(reader, writer), origin

    async def recv(self) -> bytes | str:
        parts, first_op = [], None
        while True:
            b0, b1 = await self.r.readexactly(2)
            fin, op, masked, n = b0 & 0x80, b0 & 0x0F, b1 & 0x80, b1 & 0x7F
            if n == 126:
                (n,) = struct.unpack(">H", await self.r.readexactly(2))
            elif n == 127:
                (n,) = struct.unpack(">Q", await self.r.readexactly(8))
            if n > MAX_MESSAGE:
                raise WSClosed("message too big")
            mask = await self.r.readexactly(4) if masked else b"\0\0\0\0"
            payload = await self.r.readexactly(n)
            if masked:
                payload = (int.from_bytes(payload, "little") ^ int.from_bytes(mask * (n // 4 + 1), "little")
                           .__and__((1 << (8 * n)) - 1)).to_bytes(n, "little") if n else b""
            if op == 8:
                raise WSClosed("closed by the browser")
            if op == 9:
                await self._send(10, payload)
                continue
            if op == 10:
                continue
            if op in (1, 2):
                first_op, parts = op, [payload]
            elif op == 0 and first_op is not None:
                parts.append(payload)
            if fin and first_op is not None:
                msg = b"".join(parts)
                return msg.decode() if first_op == 1 else msg

    async def _send(self, op: int, payload: bytes) -> None:
        n = len(payload)
        head = bytes([0x80 | op]) + (bytes([n]) if n < 126 else
                                     bytes([126]) + struct.pack(">H", n) if n < 65536 else
                                     bytes([127]) + struct.pack(">Q", n))
        self.w.write(head + payload)
        await self.w.drain()

    async def send_text(self, text: str) -> None:
        await self._send(1, text.encode())


# ---------------------------------------------------------------- the bridge

class Bridge:
    def __init__(self, tap) -> None:
        self.tap = tap
        self.active: WS | None = None
        self.session: Session | None = None

    async def keyframe(self, ws: WS, why: str) -> None:
        try:
            await ws.send_text(json.dumps({"type": "keyframe", "why": why}))
        except (ConnectionError, RuntimeError):
            pass

    async def watch_tap(self) -> None:
        """Keyframe requests from SmoovPlay (it asks when it joins mid-stream or can't decode)."""
        while True:
            await asyncio.sleep(0.05)
            try:
                wanted = self.tap.take_idr_request()
            except Exception:
                wanted = False
            if wanted and self.active is not None:
                log("SmoovPlay asked for a keyframe")
                if self.session is not None and self.session.live and self.session.key_wanted_at is None:
                    self.session.key_wanted_at = time.perf_counter()
                await self.keyframe(self.active, "smoovplay")

    async def handle(self, reader, writer) -> None:
        try:
            acc = await WS.accept(reader, writer)
        except (asyncio.IncompleteReadError, asyncio.LimitOverrunError, ConnectionError):
            writer.close()
            return
        if acc is None:
            writer.close()
            return
        ws, origin = acc
        log(f"browser connected ({origin or 'GreenFrame app'})")
        try:
            while True:
                msg = await ws.recv()
                if isinstance(msg, str):
                    await self.control(ws, json.loads(msg))
                    continue
                if len(msg) < FRAME_HEADER.size or msg[:4] != FRAME_MAGIC:
                    continue
                _, flags, lost, w, h = FRAME_HEADER.unpack_from(msg)
                if self.active is not ws or self.session is None:  # frames from a tab that didn't say "begin"
                    await self.start(ws, "frames without begin")
                if self.session.frame(msg[FRAME_HEADER.size:], bool(flags & 1), lost, w, h):
                    await self.keyframe(ws, "still waiting")
        except (WSClosed, asyncio.IncompleteReadError, ConnectionError) as e:
            log(f"browser disconnected ({e or 'connection lost'})")
        finally:
            if self.active is ws:
                self.stop()
            writer.close()

    async def start(self, ws: WS, why: str) -> None:
        self.stop()
        self.active, self.session = ws, Session(self.tap)
        log(f"new Xbox video stream ({why}); waiting for a keyframe")
        await self.keyframe(ws, "starting")

    def stop(self) -> None:
        if self.session is not None:
            self.session.end()
        self.active, self.session = None, None

    async def control(self, ws: WS, m: dict) -> None:
        t = m.get("type")
        if t == "hello":
            log(f"extension {m.get('version', '?')} in {m.get('page', '?')} (tap mode: {m.get('mode', '?')})")
        elif t == "begin":
            await self.start(ws, f"codec {m.get('codec', '?')}")
        elif t == "end" and self.active is ws:
            self.stop()
        elif t in ("warn", "info"):
            log(f"browser: {m.get('msg')}")


async def main_async(a) -> int:
    if a.fake or sys.platform != "win32":
        tap = FakeTap(a.save)
        tap.idr_every = a.fake_idr_every
    else:
        try:
            tap = open_tap(a.tap)
        except ImportError as e:
            log(f"can't load SmoovPlay's frame tap code ({e}). Run this with SmoovPlay's own Python: "
                r"%LOCALAPPDATA%\Programs\SmoovPlay\runtime\python\python.exe")
            return 1
    bridge = Bridge(tap)
    try:
        server = await asyncio.start_server(bridge.handle, "127.0.0.1", a.port, limit=MAX_MESSAGE)
    except OSError as e:
        log(f"can't listen on 127.0.0.1:{a.port} ({e}). Is another bridge already running?")
        return 1
    log(f"listening on ws://127.0.0.1:{a.port}, writing to {'a fake tap' if isinstance(tap, FakeTap) else a.tap}")
    log("start SmoovPlay with:  run.py --source tap --display   then start Remote Play at xbox.com/play")
    asyncio.create_task(bridge.watch_tap())
    try:
        async with server:
            if a.seconds:
                await asyncio.sleep(a.seconds)
            else:
                await server.serve_forever()
    finally:
        bridge.stop()
        tap.close()
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", type=int, default=PORT)
    ap.add_argument("--tap", default=TAP_NAME, help="frame tap shared-memory name (run.py --tap must match)")
    ap.add_argument("--fake", action="store_true", help="don't write shared memory; just log (testing)")
    ap.add_argument("--save", help="with --fake: append every frame to this .h264 file")
    ap.add_argument("--seconds", type=float, default=0, help=argparse.SUPPRESS)
    ap.add_argument("--fake-idr-every", type=float, default=0, help=argparse.SUPPRESS)
    ap.add_argument("--allow-origin", action="append", default=[], help=argparse.SUPPRESS)
    a = ap.parse_args(argv)
    global EXTRA_ORIGINS
    EXTRA_ORIGINS = tuple(a.allow_origin)
    try:
        return asyncio.run(main_async(a))
    except KeyboardInterrupt:
        return 0


if __name__ == "__main__":
    sys.exit(main())
