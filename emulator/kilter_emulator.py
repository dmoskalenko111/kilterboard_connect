#!/usr/bin/env python3
"""Kilter Board (Aurora) emulator for Linux.

The laptop advertises itself as an Aurora LED board over Bluetooth Low Energy, accepts LED messages
from the phone exactly like the real controller (writes to the UART RX characteristic in 20-byte
pieces), decodes them and draws the lit holds of a Kilter Board Original 12x12 with kickboard.

Run:   python3 kilter_emulator.py            # window + Bluetooth
       python3 kilter_emulator.py --no-gui   # terminal only
       python3 kilter_emulator.py --selftest # no Bluetooth: replays sample packets into the window

Nothing in the system configuration is changed. By default the adapter name is left alone and the
board name ("Emu@3") is sent only inside the advertisement. With --set-alias the adapter alias is
also changed for the session and restored on exit.
"""
import argparse
import asyncio
import json
import pathlib
import queue
import re
import sys
import threading
import time

ADVERTISED_SERVICE = "4488b571-7806-4df6-bcff-a2897e4953ff"
UART_SERVICE = "6e400001-b5a3-f393-e0a9-e50e24dcca9e"
RX_CHARACTERISTIC = "6e400002-b5a3-f393-e0a9-e50e24dcca9e"
INFO_CHARACTERISTIC = "4488b572-7806-4df6-bcff-a2897e4953ff"  # placeholder so the service is not empty

MARKERS = {
    2: {"middle": 77, "first": 78, "last": 79, "only": 80},
    3: {"middle": 81, "first": 82, "last": 83, "only": 84},
}
MARKER_KIND = {v: (api, k) for api, m in MARKERS.items() for k, v in m.items()}


# ---------------------------------------------------------------- protocol (mirrors src/protocol.js)
def checksum(data):
    i = 0
    for b in data:
        i = (i + b) & 255
    return ~i & 255


def decode_color(byte, api):
    if api == 3:
        r, g, b = (byte >> 5) & 7, (byte >> 2) & 7, byte & 3
        return "%02x%02x%02x" % (round(r * 255 / 7), round(g * 255 / 7), round(b * 255 / 3))
    r, g, b = (byte >> 6) & 3, (byte >> 4) & 3, (byte >> 2) & 3
    return "%02x%02x%02x" % (round(r * 255 / 3), round(g * 255 / 3), round(b * 255 / 3))


class Decoder:
    """Streaming decoder. on_message(placements, api); on_error(text)."""

    def __init__(self, on_message, on_error):
        self.on_message, self.on_error = on_message, on_error
        self.buf = bytearray()
        self.pending = None

    def reset(self):
        self.buf.clear()
        self.pending = None

    def feed(self, chunk):
        self.buf += chunk
        while True:
            start = self.buf.find(1)
            if start < 0:
                self.buf.clear()
                return
            if start > 0:
                self.on_error(f"мусор перед пакетом: {start} байт")
                del self.buf[:start]
            if len(self.buf) < 4:
                return
            n = self.buf[1]
            if len(self.buf) < n + 5:
                return
            body = bytes(self.buf[4:4 + n])
            if self.buf[3] != 2 or self.buf[4 + n] != 3 or checksum(body) != self.buf[2]:
                self.on_error("битый пакет (рамка или контрольная сумма)")
                del self.buf[:1]
                continue
            del self.buf[:n + 5]
            self._packet(body)

    def _packet(self, body):
        if body[0] not in MARKER_KIND:
            return self.on_error(f"неизвестный маркер пакета {body[0]}")
        api, kind = MARKER_KIND[body[0]]
        per = 3 if api == 3 else 2
        if (len(body) - 1) % per:
            return self.on_error(f"длина данных не кратна {per}")
        pl = []
        for i in range(1, len(body), per):
            if api == 3:
                pl.append((body[i] | (body[i + 1] << 8), decode_color(body[i + 2], 3)))
            else:
                pl.append((body[i] | ((body[i + 1] & 3) << 8), decode_color(body[i + 1], 2)))
        if kind == "only":
            self.pending = None
            return self.on_message(pl, api)
        if kind == "first":
            self.pending = (api, pl)
            return
        if not self.pending or self.pending[0] != api:
            self.pending = None
            return self.on_error("пакет вне сообщения (нет первого)")
        self.pending[1].extend(pl)
        if kind == "last":
            api, pl = self.pending
            self.pending = None
            self.on_message(pl, api)


def encode(placements, api=3):
    """Only used by --selftest; the phone app has the real encoder."""
    m = MARKERS[api]
    per = 3 if api == 3 else 2
    packets, cur = [], [m["middle"]]
    for pos, color in placements:
        if len(cur) + per > 255:
            packets.append(cur)
            cur = [m["middle"]]
        r, g, b = (int(color[i:i + 2], 16) for i in (0, 2, 4))
        if api == 3:
            cur += [pos & 255, (pos >> 8) & 255, ((r >> 5) << 5) | ((g >> 5) << 2) | (b >> 6)]
        else:
            cur += [pos & 255, ((r >> 6) << 6) | ((g >> 6) << 4) | ((b >> 6) << 2) | ((pos >> 8) & 3)]
    packets.append(cur)
    if len(packets) == 1:
        packets[0][0] = m["only"]
    else:
        packets[0][0], packets[-1][0] = m["first"], m["last"]
    out = []
    for p in packets:
        out += [1, len(p), checksum(p), 2, *p, 3]
    return bytes(out)


# ---------------------------------------------------------------- wall model
def load_holds():
    here = pathlib.Path(__file__).resolve().parent
    for p in (here / "holds.json", here.parent / "holds.json"):
        if p.exists():
            return [dict(id=a, x=x, y=y, led=led, set=s, kb=bool(kb)) for a, x, y, led, s, kb in json.loads(p.read_text())]
    sys.exit("Не найден holds.json рядом со скриптом.")


class Stats:
    def __init__(self):
        self.messages = self.errors = self.bytes = self.writes = 0
        self.last_write = None
        self.msg_start = None


# ---------------------------------------------------------------- Bluetooth side (asyncio thread)
async def run_ble(name, events, stop, set_alias):
    try:
        from bless import BlessServer, GATTAttributePermissions, GATTCharacteristicProperties
        from bless.backends.bluezdbus.dbus import application as bz_app
    except ImportError:
        events.put(("fatal", "Не установлена библиотека bless: pip install bless"))
        return

    original_alias = {"value": None}
    real_set_name = bz_app.BlueZGattApplication.set_name

    async def guarded_set_name(self, adapter, new_name):
        iface = adapter.get_interface("org.freedesktop.DBus.Properties")
        if original_alias["value"] is None:
            v = await iface.call_get("org.bluez.Adapter1", "Alias")
            original_alias["value"] = v.value
        if set_alias:
            await real_set_name(self, adapter, new_name)
        # otherwise: leave the laptop's Bluetooth name untouched; the advertisement still carries LocalName

    bz_app.BlueZGattApplication.set_name = guarded_set_name

    def on_write(characteristic, value, **kwargs):
        events.put(("write", bytes(value), time.monotonic()))

    def on_read(characteristic, **kwargs):
        return characteristic.value

    server = BlessServer(name=name, loop=asyncio.get_running_loop())
    server.read_request_func = on_read
    server.write_request_func = on_write
    try:
        # The first service is the one that goes into the advertisement (bless rule): Aurora's own UUID,
        # which is what the phone app filters on. The UART service is found later over GATT, like on the real board.
        await server.add_new_service(ADVERTISED_SERVICE)
        await server.add_new_characteristic(ADVERTISED_SERVICE, INFO_CHARACTERISTIC,
                                            GATTCharacteristicProperties.read, bytearray(b"emu"),
                                            GATTAttributePermissions.readable)
        await server.add_new_service(UART_SERVICE)
        await server.add_new_characteristic(
            UART_SERVICE, RX_CHARACTERISTIC,
            GATTCharacteristicProperties.write | GATTCharacteristicProperties.write_without_response,
            None, GATTAttributePermissions.writeable)
        # bless (BlueZ backend) marks only the first service as primary and registers the rest as
        # secondary. Web Bluetooth's getPrimaryService() never sees secondary services, so the phone
        # would find the board but not its UART service. The real board exposes both as primary.
        for svc in server.app.services:
            svc._primary = True
        await server.start()
    except Exception as e:  # noqa: BLE001
        events.put(("fatal", f"Не удалось запустить Bluetooth: {e}\n"
                             "Проверьте: включён ли Bluetooth (bluetoothctl power on) и запущена ли служба "
                             "(systemctl status bluetooth)."))
        return
    baseline = await connected_devices(server)
    services = ", ".join(f"{s.UUID[:8]}…{' (основной)' if s.Primary else ' (вторичный!)'}" for s in server.app.services)
    events.put(("status", f"Реклама включена: «{name}». Сервисы: {services}. "
                          "Ищите её в приложении → «Стена» → «Подключить»."))
    # bless reports a connection only when a client subscribes to notifications, which the Aurora
    # protocol never does, so connection state is shown from incoming writes instead (see Core).
    try:
        while not stop.is_set():
            await asyncio.sleep(0.5)
    finally:
        # A real board that is switched off drops the link, so the phone notices. Removing our GATT
        # service alone would keep the link up, so disconnect the phone ourselves. Only devices that
        # connected after start and are not paired: a Web Bluetooth phone never pairs, while headphones,
        # mice and keyboards are paired and are left alone.
        try:
            for alias in await disconnect_new_clients(server, baseline):
                print(f"Отключил телефон «{alias}», как при выключении стены", flush=True)
        except Exception as e:  # noqa: BLE001
            print(f"Не удалось разорвать соединение с телефоном ({e}); телефон заметит обрыв при следующей записи.", flush=True)
        try:
            await server.stop()
        except Exception:  # noqa: BLE001
            pass
        if set_alias and original_alias["value"] is not None:
            try:
                await real_set_name(server.app, server.adapter, original_alias["value"])
                events.put(("status", f"Имя адаптера возвращено: «{original_alias['value']}»"))
            except Exception as e:  # noqa: BLE001
                print(f"Не удалось вернуть имя адаптера, выполните: bluetoothctl system-alias \"{original_alias['value']}\" ({e})")


async def connected_devices(server, unpaired_only=False):
    """[(object_path, alias)] of devices currently connected to our adapter."""
    try:
        root = server.bus.get_proxy_object("org.bluez", "/", await server.bus.introspect("org.bluez", "/"))
        objs = await root.get_interface("org.freedesktop.DBus.ObjectManager").call_get_managed_objects()
    except Exception:  # noqa: BLE001
        return []
    prefix = server.adapter.path + "/"
    out = []
    for path, ifaces in objs.items():
        d = ifaces.get("org.bluez.Device1")
        if not d or not path.startswith(prefix) or not d.get("Connected") or not d["Connected"].value:
            continue
        if unpaired_only and d.get("Paired") and d["Paired"].value:
            continue
        out.append((path, d["Alias"].value if d.get("Alias") else "?"))
    return out


async def disconnect_new_clients(server, baseline):
    """Disconnect devices that connected after start and are not paired; return their names."""
    before = {path for path, _ in baseline}
    done = []
    for path, alias in await connected_devices(server, unpaired_only=True):
        if path in before:
            continue
        dev = server.bus.get_proxy_object("org.bluez", path, await server.bus.introspect("org.bluez", path))
        await dev.get_interface("org.bluez.Device1").call_disconnect()
        done.append(alias)
    return done


def ble_thread(name, events, stop, set_alias):
    asyncio.run(run_ble(name, events, stop, set_alias))


# ---------------------------------------------------------------- front-ends
class Core:
    """Shared message handling for GUI and terminal."""

    def __init__(self, holds, out, expected_api=None):
        self.expected_api = expected_api  # None = accept both versions (lenient)
        self.by_led = {h["led"]: h for h in holds}
        self.stats = Stats()
        self.out = out  # out(kind, payload)
        self.dec = Decoder(self._message, self._error)

    def write(self, data, t):
        s = self.stats
        gap = None if s.last_write is None else (t - s.last_write) * 1000
        s.last_write, s.writes, s.bytes = t, s.writes + 1, s.bytes + len(data)
        if s.msg_start is None:
            s.msg_start = t
        warn = f"  ⚠ кусок {len(data)} байт (> 20)" if len(data) > 20 else ""
        self.out("log", f"← {len(data):>2} б" + (f"  +{gap:.0f} мс" if gap is not None and gap < 5000 else "") +
                 f"  {data.hex(' ')}{warn}")
        self.dec.feed(data)

    def _message(self, placements, api):
        s = self.stats
        s.messages += 1
        took = (s.last_write - s.msg_start) * 1000 if s.msg_start is not None else 0
        s.msg_start = None
        if self.expected_api and api != self.expected_api:
            s.errors += 1
            self.out("err", f"пакет API {api}, а эта стена понимает только API {self.expected_api}: "
                            f"настоящая стена такое сообщение, скорее всего, не покажет. "
                            f"Проверьте «Версию протокола стены» в приложении")
            return
        lit, unknown = [], []
        for pos, color in placements:
            h = self.by_led.get(pos)
            (lit.append((h, color)) if h else unknown.append(pos))
        self.out("frame", (lit, api))
        self.out("log", f"✓ сообщение #{s.messages}: API {api}, зацепок {len(placements)}, "
                        f"доставлено за {took:.0f} мс")
        if unknown:
            s.errors += 1
            self.out("err", f"LED нет на стене 12×12: {unknown[:10]}")
        if len(placements) > 60:
            self.out("err", f"горит {len(placements)} зацепок — больше, чем зажигает официальное приложение")

    def _error(self, text):
        self.stats.errors += 1
        self.out("err", text)


def run_terminal(holds, events, stop, expected_api=None):
    def out(kind, payload):
        if kind == "frame":
            lit, api = payload
            print("   горят:", ", ".join(f"LED {h['led']} ({h['x']},{h['y']}) #{c}" for h, c in lit) or "ничего")
        else:
            print(("✗ " if kind == "err" else "") + payload, flush=True)
    core = Core(holds, out, expected_api)
    try:
        while True:
            ev = events.get()
            if ev[0] == "write":
                if core.stats.writes == 0:
                    print("● телефон шлёт данные", flush=True)
                core.write(ev[1], ev[2])
            elif ev[0] == "conn":
                print("● телефон подключился" if ev[1] else "○ телефон отключился", flush=True)
                core.dec.reset()
            elif ev[0] == "fatal":
                print(ev[1]); return
            else:
                print(ev[1], flush=True)
    except KeyboardInterrupt:
        pass
    finally:
        stop.set()


def run_gui(holds, events, stop, title, expected_api=None):
    import tkinter as tk
    from tkinter import font as tkfont

    BG, PLY, KB, BOLT, FG, MUTED, BAD, OK = "#11151b", "#2a2520", "#211d19", "#4b443b", "#e9edf2", "#8d98a7", "#ff7a6b", "#36d37a"
    root = tk.Tk()
    root.title(title)
    root.configure(bg=BG)
    root.geometry("1040x760")
    mono = tkfont.Font(family="DejaVu Sans Mono", size=9)
    head = tkfont.Font(family="DejaVu Sans", size=12, weight="bold")

    left = tk.Frame(root, bg=BG); left.pack(side="left", fill="both", expand=True, padx=12, pady=12)
    right = tk.Frame(root, bg=BG, width=420); right.pack(side="right", fill="y", padx=(0, 12), pady=12)
    right.pack_propagate(False)

    canvas = tk.Canvas(left, bg=BG, highlightthickness=0)
    canvas.pack(fill="both", expand=True)
    status = tk.Label(right, text="Запуск…", bg=BG, fg=FG, font=head, anchor="w", justify="left", wraplength=400)
    status.pack(fill="x")
    conn = tk.Label(right, text="○ данных от телефона ещё не было", bg=BG, fg=MUTED, anchor="w")
    conn.pack(fill="x", pady=(4, 0))
    counters = tk.Label(right, text="", bg=BG, fg=MUTED, anchor="w", font=mono)
    counters.pack(fill="x", pady=(4, 8))
    logbox = tk.Text(right, bg="#191f27", fg=MUTED, font=mono, relief="flat", wrap="char", height=30)
    logbox.pack(fill="both", expand=True)
    logbox.tag_configure("err", foreground=BAD)
    logbox.tag_configure("ok", foreground=FG)

    state = {"lit": [], "api": None}

    def draw():
        canvas.delete("all")
        w, h = canvas.winfo_width(), canvas.winfo_height()
        if w < 50 or h < 50:
            return
        s = min(w / 152, h / 162)
        ox, oy = (w - 152 * s) / 2 + 4 * s, (h - 162 * s) / 2 + 2 * s
        X = lambda x: ox + x * s
        Y = lambda y: oy + (156 - y) * s
        canvas.create_rectangle(X(-2), Y(157), X(146), Y(-1), fill=PLY, outline="")
        canvas.create_rectangle(X(-2), Y(12), X(146), Y(-1), fill=KB, outline="")
        for hd in holds:
            r = (1.5 if hd["set"] == 1 else 1.1) * s
            canvas.create_oval(X(hd["x"]) - r, Y(hd["y"]) - r, X(hd["x"]) + r, Y(hd["y"]) + r, fill=BOLT, outline="")
        for hd, color in state["lit"]:
            c = "#" + color
            for rr, wdt in ((4.2, 1), (3.1, 3)):
                canvas.create_oval(X(hd["x"]) - rr * s, Y(hd["y"]) - rr * s, X(hd["x"]) + rr * s, Y(hd["y"]) + rr * s,
                                   outline=c, width=wdt)
            canvas.create_oval(X(hd["x"]) - 1.3 * s, Y(hd["y"]) - 1.3 * s, X(hd["x"]) + 1.3 * s, Y(hd["y"]) + 1.3 * s,
                               fill=c, outline="")
            canvas.create_text(X(hd["x"]) + 4.6 * s, Y(hd["y"]), text=str(hd["led"]), fill=FG, anchor="w",
                               font=("DejaVu Sans", max(7, int(2.6 * s))))
        cap = f"горит {len(state['lit'])}" + (f" · API {state['api']}" if state["api"] else "") + " · внизу кикборд · подписи = номер LED"
        canvas.create_text(w / 2, h - 6, text=cap, fill=MUTED, anchor="s", font=mono)

    def log(text, tag=None):
        logbox.insert("1.0", text + "\n", tag or ())
        if int(logbox.index("end-1c").split(".")[0]) > 400:
            logbox.delete("400.0", "end")

    def out(kind, payload):
        if kind == "frame":
            state["lit"], state["api"] = payload
            draw()
        elif kind == "err":
            log("✗ " + payload, "err")
        else:
            log(payload, "ok" if payload.startswith("✓") else None)
        st = core.stats
        counters.config(text=f"сообщений {st.messages} · кусков {st.writes} · байт {st.bytes} · ошибок {st.errors}")

    core = Core(holds, out, expected_api)

    def pump():
        try:
            while True:
                ev = events.get_nowait()
                if ev[0] == "write":
                    core.write(ev[1], ev[2])
                    conn.config(text="● телефон шлёт данные", fg=OK)
                elif ev[0] == "conn":
                    conn.config(text="● телефон подключён" if ev[1] else "○ телефон отключился", fg=OK if ev[1] else MUTED)
                    core.dec.reset()
                elif ev[0] == "fatal":
                    status.config(text=ev[1], fg=BAD)
                else:
                    status.config(text=ev[1], fg=FG)
        except queue.Empty:
            pass
        lw = core.stats.last_write
        if lw is not None and time.monotonic() - lw > 15:
            conn.config(text=f"○ данных нет {int(time.monotonic() - lw)} с (нормально, пока не нажимают «Дальше»)", fg=MUTED)
        if not stop.is_set():
            root.after(40, pump)

    def close():
        stop.set()
        root.after(700, root.destroy)  # give the Bluetooth thread time to stop advertising

    canvas.bind("<Configure>", lambda e: draw())
    root.protocol("WM_DELETE_WINDOW", close)
    root.after(40, pump)
    try:
        root.mainloop()
    except KeyboardInterrupt:
        stop.set()


def selftest_feeder(holds, events, stop):
    """Replays the kind of traffic the phone sends, split into 20-byte writes, plus two broken packets."""
    import random
    rnd = random.Random(1)
    events.put(("status", "Самопроверка без Bluetooth: проигрываю пакеты, как от телефона"))
    events.put(("conn", True))
    frames = 0
    while not stop.is_set():
        frames += 1
        api = 3 if frames % 5 else 2
        if frames % 7 == 0:
            msg = bytearray(encode([(h["led"], "00ff00") for h in holds[:3]], api)); msg[2] ^= 0xFF
        elif frames % 11 == 0:
            msg = encode([(h["led"], "ffffff") for h in rnd.sample(holds, 120)], 3)  # multi-packet message
        else:
            pick = rnd.sample(holds, 5)
            msg = encode([(h["led"], "00ff00") for h in pick[:4]] + [(pick[4]["led"], "ff00ff")], api)
        for i in range(0, len(msg), 20):
            events.put(("write", bytes(msg[i:i + 20]), time.monotonic()))
            time.sleep(0.015)
        time.sleep(1.2)


def main():
    ap = argparse.ArgumentParser(description="Эмулятор стены Kilter Board (Aurora) для Linux")
    ap.add_argument("--name", default="Emu@3", help="имя стены в рекламе; @3 или @2 = версия протокола (по умолчанию Emu@3)")
    ap.add_argument("--no-gui", action="store_true", help="без окна, журнал в терминал")
    ap.add_argument("--selftest", action="store_true", help="без Bluetooth: проверить окно и декодер на тестовых пакетах")
    ap.add_argument("--lenient", action="store_true", help="принимать пакеты обеих версий протокола (по умолчанию только версию из имени)")
    ap.add_argument("--set-alias", action="store_true", help="на время работы сменить Bluetooth-имя ноутбука на --name (вернётся при выходе)")
    a = ap.parse_args()
    if len(a.name.encode()) > 8:
        print(f"Внимание: имя «{a.name}» длиннее 8 байт может не поместиться в рекламный пакет вместе с UUID.")

    # Like the official app: "@3" at the end of the name means API 3, anything else means API 2.
    m = re.search(r"@(\d+)$", a.name)
    name_api = 3 if m and m.group(1) == "3" else 2
    # The self-test deliberately mixes both versions, so it is always lenient.
    expected = None if (a.lenient or a.selftest) else name_api
    mode = "принимаю обе версии протокола" if expected is None else f"строгий режим: принимаю только API {expected}"
    print(f"Эмулятор «{a.name}»: {mode}", flush=True)

    holds = load_holds()
    events, stop = queue.Queue(), threading.Event()
    if a.selftest:
        threading.Thread(target=selftest_feeder, args=(holds, events, stop), daemon=True).start()
    else:
        threading.Thread(target=ble_thread, args=(a.name, events, stop, a.set_alias), daemon=False).start()
    try:
        if a.no_gui:
            run_terminal(holds, events, stop, expected)
        else:
            try:
                run_gui(holds, events, stop, f"Эмулятор Kilter · {a.name} · {mode}", expected)
            except Exception as e:  # noqa: BLE001  (no display / no tkinter)
                print(f"Окно не открылось ({e}), продолжаю в терминале.")
                run_terminal(holds, events, stop, expected)
    finally:
        stop.set()


if __name__ == "__main__":
    main()
