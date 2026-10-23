"""Emulator behaviour without real Bluetooth: strict protocol version and which devices get disconnected."""
import asyncio, sys, pathlib
from types import SimpleNamespace as NS
sys.path.insert(0, str(pathlib.Path(__file__).parent.parent / "emulator"))
import kilter_emulator as E

holds = E.load_holds()
led = holds[0]["led"]

# strict mode: API 3 board ignores API 2 messages and reports it
for expected, api, drawn in [(3, 3, True), (3, 2, False), (2, 2, True), (2, 3, False), (None, 2, True), (None, 3, True)]:
    frames, errs = [], []
    core = E.Core(holds, lambda k, p: (frames if k == "frame" else errs if k == "err" else []).append(p), expected)
    core.write(E.encode([(led, "00ff00")], api), 0.0)
    assert bool(frames) == drawn and bool(errs) == (not drawn), (expected, api, frames, errs)

# disconnect: only devices that connected after start and are not paired
V = lambda v: NS(value=v)
class Bus:
    def __init__(self): self.devices, self.disconnected = {}, []
    async def introspect(self, *a): return None
    def get_proxy_object(self, dest, path, intro):
        bus = self
        class Iface:
            async def call_get_managed_objects(self_):
                return {p: {"org.bluez.Device1": d} for p, d in bus.devices.items()} | {"/org/bluez/hci0": {"org.bluez.Adapter1": {}}}
            async def call_disconnect(self_): bus.disconnected.append(path)
        return NS(get_interface=lambda name: Iface())
bus = Bus()
server = NS(bus=bus, adapter=NS(path="/org/bluez/hci0"))
dev = lambda alias, paired, conn=True: {"Alias": V(alias), "Paired": V(paired), "Connected": V(conn)}
bus.devices = {"/org/bluez/hci0/dev_HEAD": dev("Наушники", True), "/org/bluez/hci0/dev_OLD": dev("Старый телефон", False)}

async def run():
    baseline = await E.connected_devices(server)
    bus.devices["/org/bluez/hci0/dev_PHONE"] = dev("Pixel", False)          # our phone
    bus.devices["/org/bluez/hci0/dev_MOUSE"] = dev("Мышь", True)            # paired, connected later
    bus.devices["/org/bluez/hci0/dev_GONE"] = dev("Ушёл", False, conn=False)  # not connected
    bus.devices["/org/bluez/hci1/dev_X"] = dev("Другой адаптер", False)      # other adapter
    return await E.disconnect_new_clients(server, baseline)

names = asyncio.run(run())
assert names == ["Pixel"], names
assert bus.disconnected == ["/org/bluez/hci0/dev_PHONE"], bus.disconnected
print("emulator BLE logic: strict mode 6 cases + disconnect filter passed")
