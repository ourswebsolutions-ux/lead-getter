#!/usr/bin/env python3
"""Lead Finder's Bluetooth helper (Linux, BlueZ over D-Bus).

Node cannot open Bluetooth sockets, so the Dialer runs this helper and talks
to it in JSON lines over stdin/stdout:

  request  {"id": 1, "cmd": "pair", "address": "AA:BB:..."}
  reply    {"id": 1, "ok": true, "result": ...} | {"id": 1, "ok": false, "error": "..."}
  event    {"event": "device", "device": {...}}

It discovers, pairs (passkey confirmation goes to the app), connects and
disconnects devices, and makes this computer a Bluetooth Hands-Free unit
(HFP HF) for a phone, the way a car kit is:

- control: a BlueZ Profile1 for the Hands-Free UUID; BlueZ connects the
  phone's Audio Gateway (and accepts the phone's own connections) and hands
  over the authenticated, encrypted RFCOMM socket. The AT lines the phone
  sends are passed through as "data" events (the Dialer speaks the AT
  protocol, see hfp.js); "send" writes an AT command.
- voice: the call's SCO link (CVSD, 8 kHz 16-bit mono). The phone opens it
  when the call's audio comes to this computer ("sco_connect" asks for it
  from here). Its audio is played with pacat on the chosen speaker and the
  chosen microphone (parec) is sent back, paced by the phone's packets.
  Nothing is recorded or stored.
"""

import base64
import json
import os
import re
import socket
import subprocess
import sys
import threading

import dbus
import dbus.mainloop.glib
import dbus.service
from gi.repository import GLib

HFP_HF_UUID = "0000111e-0000-1000-8000-00805f9b34fb"
HFP_AG_UUID = "0000111f-0000-1000-8000-00805f9b34fb"
BLUEZ = "org.bluez"
AGENT_PATH = "/leadfinder/agent"
PROFILE_PATH = "/leadfinder/handsfree"
# SDP SupportedFeatures of this Hands-Free unit: three-way calling, caller ID,
# remote volume. No wideband (codec negotiation): calls use CVSD.
HF_SDP_FEATURES = 0x0016
MAX_LINE = 65536

dbus.mainloop.glib.DBusGMainLoop(set_as_default=True)
bus = dbus.SystemBus()
loop = GLib.MainLoop()


def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def plain(v):
    if isinstance(v, (dbus.Boolean,)):
        return bool(v)
    if isinstance(v, (dbus.Int16, dbus.Int32, dbus.Int64, dbus.UInt16, dbus.UInt32, dbus.UInt64, dbus.Byte)):
        return int(v)
    if isinstance(v, (dbus.String, dbus.ObjectPath)):
        return str(v)
    if isinstance(v, (dbus.Array, list)):
        return [plain(x) for x in v]
    if isinstance(v, (dbus.Dictionary, dict)):
        return {str(k): plain(x) for k, x in v.items()}
    return v


def objects():
    om = dbus.Interface(bus.get_object(BLUEZ, "/"), "org.freedesktop.DBus.ObjectManager")
    return om.GetManagedObjects()


def adapter_path():
    for path, ifaces in objects().items():
        if "org.bluez.Adapter1" in ifaces:
            return path
    return None


def device_path(address):
    for path, ifaces in objects().items():
        dev = ifaces.get("org.bluez.Device1")
        if dev and str(dev.get("Address", "")).upper() == address.upper():
            return path
    return None


def device_info(path, ifaces):
    d = ifaces.get("org.bluez.Device1", {})
    bat = ifaces.get("org.bluez.Battery1")
    return {
        "path": str(path),
        "address": str(d.get("Address", "")),
        "name": str(d.get("Alias") or d.get("Name") or d.get("Address", "")),
        "icon": str(d.get("Icon", "")),
        "deviceClass": int(d.get("Class", 0)),
        "paired": bool(d.get("Paired", False)),
        "trusted": bool(d.get("Trusted", False)),
        "connected": bool(d.get("Connected", False)),
        "rssi": int(d["RSSI"]) if "RSSI" in d else None,
        "uuids": [str(u) for u in d.get("UUIDs", [])],
        "battery": int(bat["Percentage"]) if bat and "Percentage" in bat else None,
    }


def adapter_info():
    path = adapter_path()
    if not path:
        return None
    a = objects()[path]["org.bluez.Adapter1"]
    return {"path": str(path), "address": str(a.get("Address", "")), "name": str(a.get("Alias") or a.get("Name") or ""), "powered": bool(a.get("Powered", False)), "discovering": bool(a.get("Discovering", False)), "visible": bool(a.get("Discoverable", False))}


def snapshot():
    devices = [device_info(p, i) for p, i in objects().items() if "org.bluez.Device1" in i]
    return {"adapter": adapter_info(), "devices": devices, "links": sorted(links.keys())}


def props(path, iface):
    return dbus.Interface(bus.get_object(BLUEZ, path), "org.freedesktop.DBus.Properties")


# --- the Hands-Free control channel (RFCOMM, AT commands) ----------------------------

links = {}  # address -> {"fd": int, "buf": bytes, "watch": id}


def close_link(address, reason):
    link = links.pop(address, None)
    if not link:
        return
    if voice.address == address:
        voice.close("Hands-Free disconnected")
    GLib.source_remove(link["watch"])
    try:
        os.close(link["fd"])
    except OSError:
        pass
    emit({"event": "link_down", "address": address, "reason": reason})


def on_link_data(fd, cond, address):
    link = links.get(address)
    if not link:
        return False
    if cond & (GLib.IO_HUP | GLib.IO_ERR):
        close_link(address, "closed")
        return False
    try:
        chunk = os.read(fd, 4096)
    except BlockingIOError:
        return True
    except OSError as e:
        close_link(address, str(e))
        return False
    if not chunk:
        close_link(address, "closed")
        return False
    link["buf"] += chunk.replace(b"\r", b"\n")
    while b"\n" in link["buf"]:
        line, link["buf"] = link["buf"].split(b"\n", 1)
        if line.strip():
            emit({"event": "data", "address": address, "line": line.decode("utf-8", "replace").strip()})
    if len(link["buf"]) > MAX_LINE:
        close_link(address, "line too long")
        return False
    return True


class Profile(dbus.service.Object):
    @dbus.service.method("org.bluez.Profile1", in_signature="oha{sv}", out_signature="")
    def NewConnection(self, device, fd, properties):
        fd = fd.take()
        address = str(props(device, "org.bluez.Device1").Get("org.bluez.Device1", "Address"))
        close_link(address, "replaced")
        os.set_blocking(fd, False)
        watch = GLib.io_add_watch(fd, GLib.IO_IN | GLib.IO_HUP | GLib.IO_ERR, on_link_data, address)
        links[address] = {"fd": fd, "buf": b"", "watch": watch}
        emit({"event": "link_up", "address": address})

    @dbus.service.method("org.bluez.Profile1", in_signature="o", out_signature="")
    def RequestDisconnection(self, device):
        address = str(props(device, "org.bluez.Device1").Get("org.bluez.Device1", "Address"))
        close_link(address, "disconnected")

    @dbus.service.method("org.bluez.Profile1", in_signature="", out_signature="")
    def Release(self):
        pass


def send_line(address, line):
    link = links.get(address)
    if not link:
        raise RuntimeError("The phone is not connected as a Hands-Free device.")
    data = (line.rstrip("\r\n") + "\r").encode("utf-8")
    view = memoryview(data)
    os.set_blocking(link["fd"], True)
    try:
        while view:
            n = os.write(link["fd"], view)
            view = view[n:]
    finally:
        os.set_blocking(link["fd"], False)


# --- the call's voice (SCO) ---------------------------------------------------------

PLAY = ["pacat", "--playback", "--raw", "--format=s16le", "--rate=8000", "--channels=1", "--latency-msec=60", "--client-name=Lead Finder", "--stream-name=Phone call"]
RECORD = ["parec", "--raw", "--format=s16le", "--rate=8000", "--channels=1", "--latency-msec=30", "--client-name=Lead Finder", "--stream-name=Phone call microphone"]
MIC_MAX = 8000 * 2 // 5  # keep at most 200 ms of microphone audio


class Voice:
    def __init__(self):
        self.sock = None
        self.address = None
        self.watch = None
        self.play = ""
        self.record = ""
        self.muted = False
        self.player = None
        self.recorder = None
        self.mic = bytearray()
        self.mic_watch = None
        self.listener = None
        # Remote: the call's audio goes to Lead Finder on another computer (a bridge).
        self.remote = False
        self.out = bytearray()
        self.flush_timer = None

    def listen(self, adapter_address):
        try:
            s = socket.socket(socket.AF_BLUETOOTH, socket.SOCK_SEQPACKET, socket.BTPROTO_SCO)
            s.bind(adapter_address.encode())
            s.listen(1)
        except OSError as e:
            emit({"event": "audio_error", "error": "Call audio (SCO) is not available: %s" % e})
            return
        self.listener = s
        GLib.io_add_watch(s.fileno(), GLib.IO_IN, self.on_accept)

    def on_accept(self, fd, cond):
        try:
            sock, addr = self.listener.accept()
        except OSError:
            return True
        if isinstance(addr, (tuple, list)):
            addr = addr[0]
        if isinstance(addr, bytes):
            addr = addr.decode()
        address = str(addr).upper()
        if address not in links:
            sock.close()  # only the connected Hands-Free phone's call audio
            return True
        self.attach(sock, address)
        return True

    def connect(self, address):
        def run():
            s = socket.socket(socket.AF_BLUETOOTH, socket.SOCK_SEQPACKET, socket.BTPROTO_SCO)
            s.settimeout(8)
            try:
                s.connect(address.encode())
            except OSError as e:
                s.close()
                err = e.strerror or str(e)
                GLib.idle_add(lambda: emit({"event": "audio_error", "address": address, "error": "The phone did not move the call audio to this computer (%s)." % err}) and False)
                return
            s.settimeout(None)
            GLib.idle_add(lambda: self.attach(s, address) and False)

        threading.Thread(target=run, daemon=True).start()

    def attach(self, sock, address):
        self.close("replaced")
        sock.setblocking(False)
        self.sock = sock
        self.address = address
        self.mic = bytearray()
        self.watch = GLib.io_add_watch(sock.fileno(), GLib.IO_IN | GLib.IO_HUP | GLib.IO_ERR, self.on_voice)
        self.start_audio()
        emit({"event": "sco_up", "address": address})

    def start_audio(self):
        self.stop_audio()
        if self.remote:
            # 20 ms chunks of the phone's voice to Lead Finder; its microphone comes back with voice_out.
            self.flush_timer = GLib.timeout_add(20, self.flush)
            return
        try:
            self.player = subprocess.Popen(PLAY + (["--device=" + self.play] if self.play else []), stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            os.set_blocking(self.player.stdin.fileno(), False)
            self.recorder = subprocess.Popen(RECORD + (["--device=" + self.record] if self.record else []), stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
            os.set_blocking(self.recorder.stdout.fileno(), False)
            self.mic_watch = GLib.io_add_watch(self.recorder.stdout.fileno(), GLib.IO_IN | GLib.IO_HUP, self.on_mic)
        except OSError as e:
            emit({"event": "audio_error", "error": "pacat and parec are needed for call audio (%s)." % e})

    def flush(self):
        if self.out:
            emit({"event": "voice", "address": self.address, "data": base64.b64encode(bytes(self.out)).decode()})
            self.out = bytearray()
        return True

    def mic_in(self, data):
        self.mic += data
        if len(self.mic) > MIC_MAX:
            del self.mic[: len(self.mic) - MIC_MAX]

    def stop_audio(self):
        if self.flush_timer:
            GLib.source_remove(self.flush_timer)
            self.flush_timer = None
        self.out = bytearray()
        if self.mic_watch:
            GLib.source_remove(self.mic_watch)
            self.mic_watch = None
        for p in (self.player, self.recorder):
            if p:
                try:
                    p.kill()
                    p.wait(timeout=2)
                except Exception:  # noqa: BLE001
                    pass
        self.player = self.recorder = None

    def on_mic(self, fd, cond):
        try:
            chunk = os.read(fd, 4096)
        except BlockingIOError:
            return True
        except OSError:
            chunk = b""
        if not chunk:
            self.mic_watch = None
            return False
        self.mic += chunk
        if len(self.mic) > MIC_MAX:
            del self.mic[: len(self.mic) - MIC_MAX]
        return True

    # Each packet from the phone is played, and as much microphone audio goes back
    # (the phone's packets set the pace, so both sides stay in step).
    def on_voice(self, fd, cond):
        if cond & (GLib.IO_HUP | GLib.IO_ERR):
            self.close("closed by the phone")
            return False
        try:
            data = self.sock.recv(1024)
        except BlockingIOError:
            return True
        except OSError:
            data = b""
        if not data:
            self.close("closed by the phone")
            return False
        if self.remote:
            self.out += data
        elif self.player and self.player.poll() is None:
            try:
                self.player.stdin.write(data)
                self.player.stdin.flush()
            except OSError:
                pass
        n = len(data)
        if self.muted or len(self.mic) < n:
            out = bytes(n)
        else:
            out = bytes(self.mic[:n])
            del self.mic[:n]
        try:
            self.sock.send(out)
        except OSError:
            pass
        return True

    def configure(self, play, record, muted, remote=False):
        changed = (play, record, remote) != (self.play, self.record, self.remote)
        self.play, self.record, self.muted, self.remote = play, record, muted, remote
        if changed and self.sock:
            self.start_audio()

    def close(self, reason):
        if not self.sock:
            return
        if self.watch:
            GLib.source_remove(self.watch)
            self.watch = None
        try:
            self.sock.close()
        except OSError:
            pass
        self.sock = None
        self.stop_audio()
        emit({"event": "sco_down", "address": self.address, "reason": reason})
        self.address = None


voice = Voice()
hf_registered = False
hf_error = None


# --- SMS: Bluetooth Message Access (MAP) through obexd ---------------------------------
# obexd (BlueZ's OBEX service, on the session bus) is the MAP client: it
# connects to the phone's Message Access Server, lists, reads and pushes
# (sends) messages, and receives the phone's event reports (new message,
# sent, delivered) through its Message Notification Server.

OBEX = "org.bluez.obex"
session_bus = None
map_sessions = {}  # address -> session path
TMP = os.path.join(os.environ.get("XDG_RUNTIME_DIR") or "/tmp", "lead-finder-map")


def obex():
    global session_bus
    if session_bus is None:
        session_bus = dbus.SessionBus()
        session_bus.add_signal_receiver(on_obex_added, dbus_interface="org.freedesktop.DBus.ObjectManager", signal_name="InterfacesAdded", bus_name=OBEX)
        session_bus.add_signal_receiver(on_obex_changed, dbus_interface="org.freedesktop.DBus.Properties", signal_name="PropertiesChanged", bus_name=OBEX, path_keyword="path")
    return session_bus


def map_address(path):
    for a, p in map_sessions.items():
        if str(path).startswith(p + "/"):
            return a
    return None


def message_info(path, props):
    keep = ("Folder", "Subject", "Timestamp", "Sender", "SenderAddress", "ReplyTo", "Recipient", "RecipientAddress", "Type", "Size", "Status", "Read", "Sent", "Protected")
    return {"path": str(path), "handle": str(path).rsplit("/", 1)[-1], **{k[0].lower() + k[1:]: plain(v) for k, v in props.items() if k in keep}}


def on_obex_added(path, ifaces):
    if "org.bluez.obex.Message1" in ifaces:
        address = map_address(path)
        if address:
            emit({"event": "sms_message", "address": address, "message": message_info(path, ifaces["org.bluez.obex.Message1"])})


def on_obex_changed(iface, changed, invalidated, path=None):
    if iface == "org.bluez.obex.Message1":
        address = map_address(path)
        if address:
            emit({"event": "sms_status", "address": address, "path": str(path), "handle": str(path).rsplit("/", 1)[-1], "changed": plain(changed)})


def obex_error(e):
    msg = e.get_dbus_message() if isinstance(e, dbus.DBusException) else str(e)
    if "0x53" in (msg or "") or "0x43" in (msg or "") or "Forbidden" in (msg or ""):
        return "denied: The phone refused message access. On the phone: Settings, Bluetooth, this computer, turn on Text messages (Message access)."
    if "ServiceUnknown" in (e.get_dbus_name() if isinstance(e, dbus.DBusException) else "") or "org.bluez.obex" in (msg or ""):
        return "obexd: The Bluetooth messaging service (obexd) is not running on this computer."
    return msg or "MAP error"


def wait_transfer(transfer, done):
    # Calls done(error or None) when the OBEX transfer completes or fails.
    def changed(iface, props, invalidated, path=None):
        if str(path) != str(transfer) or "Status" not in props:
            return
        st = str(props["Status"])
        if st in ("complete", "error"):
            receiver.remove()
            done(None if st == "complete" else "The transfer failed.")

    receiver = obex().add_signal_receiver(changed, dbus_interface="org.freedesktop.DBus.Properties", signal_name="PropertiesChanged", bus_name=OBEX, path_keyword="path")


def bmessage(number, text):
    body = "BEGIN:MSG\r\n" + text.replace("\r\n", "\n").replace("\n", "\r\n") + "\r\nEND:MSG\r\n"
    return (
        "BEGIN:BMSG\r\nVERSION:1.0\r\nSTATUS:READ\r\nTYPE:SMS_GSM\r\nFOLDER:telecom/msg/outbox\r\n"
        "BEGIN:BENV\r\nBEGIN:VCARD\r\nVERSION:2.1\r\nN:\r\nTEL:" + number + "\r\nEND:VCARD\r\n"
        "BEGIN:BBODY\r\nCHARSET:UTF-8\r\nLENGTH:" + str(len(body.encode("utf-8"))) + "\r\n" + body + "END:BBODY\r\nEND:BENV\r\nEND:BMSG\r\n"
    )


def bmessage_text(raw):
    m = re.search(r"BEGIN:MSG\r?\n(.*?)\r?\nEND:MSG", raw, re.S)
    return m.group(1) if m else ""


def map_command(rid, cmd, req, address):
    bus_ = obex()
    if cmd == "map_connect":
        if address in map_sessions:
            return reply(rid, True)
        client = dbus.Interface(bus_.get_object(OBEX, "/org/bluez/obex"), "org.bluez.obex.Client1")

        def ok(path):
            map_sessions[address] = str(path)
            try:
                dbus.Interface(bus_.get_object(OBEX, path), "org.bluez.obex.MessageAccess1").SetFolder("telecom/msg")
            except dbus.DBusException:
                pass
            reply(rid, True)

        return client.CreateSession(address, {"Target": "map"}, reply_handler=ok, error_handler=lambda e: reply(rid, error=obex_error(e)), timeout=90)
    if cmd == "map_disconnect":
        path = map_sessions.pop(address, None)
        if path:
            try:
                dbus.Interface(bus_.get_object(OBEX, "/org/bluez/obex"), "org.bluez.obex.Client1").RemoveSession(path)
            except dbus.DBusException:
                pass
        return reply(rid, True)
    path = map_sessions.get(address)
    if not path:
        raise RuntimeError("Messages are not connected.")
    ma = dbus.Interface(bus_.get_object(OBEX, path), "org.bluez.obex.MessageAccess1")
    if cmd == "map_list":
        flt = {"MaxCount": dbus.UInt16(max(1, min(int(req.get("max") or 50), 500)))}
        if req.get("since"):
            flt["PeriodBegin"] = str(req["since"])
        return ma.ListMessages(str(req.get("folder") or "inbox"), flt, reply_handler=lambda msgs: reply(rid, [message_info(p, pr) for p, pr in msgs.items()]), error_handler=lambda e: reply(rid, error=obex_error(e)), timeout=60)
    if cmd == "map_get":
        os.makedirs(TMP, mode=0o700, exist_ok=True)
        target = os.path.join(TMP, "msg-%s.bmsg" % re.sub(r"[^\w-]", "_", str(req.get("handle") or "x")))
        msg = dbus.Interface(bus_.get_object(OBEX, str(req["path"])), "org.bluez.obex.Message1")

        def got(transfer, props):
            def done(err):
                try:
                    with open(target, encoding="utf-8", errors="replace") as f:
                        text = bmessage_text(f.read())
                except OSError:
                    text = None
                try:
                    os.remove(target)
                except OSError:
                    pass
                reply(rid, error=err) if err or text is None else reply(rid, text)

            wait_transfer(transfer, done)

        return msg.Get(target, False, reply_handler=got, error_handler=lambda e: reply(rid, error=obex_error(e)), timeout=60)
    if cmd == "map_push":
        number = str(req.get("number") or "")
        text = str(req.get("text") or "")
        if not re.match(r"^\+?[0-9]{3,20}$", number) or not text:
            raise RuntimeError("A number and a message are needed.")
        os.makedirs(TMP, mode=0o700, exist_ok=True)
        source = os.path.join(TMP, "out-%d.bmsg" % rid)
        with open(source, "w", encoding="utf-8", newline="") as f:
            f.write(bmessage(number, text))

        def pushed(transfer, props):
            def done(err):
                try:
                    os.remove(source)
                except OSError:
                    pass
                reply(rid, error=err) if err else reply(rid, {"transfer": str(transfer)})

            wait_transfer(transfer, done)

        def failed(e):
            try:
                os.remove(source)
            except OSError:
                pass
            reply(rid, error=obex_error(e))

        return ma.PushMessage(source, "telecom/msg/outbox", {"Transparent": False, "Retry": True, "Charset": "utf8"}, reply_handler=pushed, error_handler=failed, timeout=60)
    if cmd == "map_read":
        dbus.Interface(bus_.get_object(OBEX, str(req["path"])), "org.freedesktop.DBus.Properties").Set("org.bluez.obex.Message1", "Read", dbus.Boolean(True))
        return reply(rid, True)
    raise RuntimeError("Unknown command: %s" % cmd)


def register_hf():
    """This computer's Hands-Free role. Fails while another program (PipeWire's
    own hfp_hf role) has it; the app explains and can hand it over."""
    global hf_registered, hf_error
    pm = dbus.Interface(bus.get_object(BLUEZ, "/org/bluez"), "org.bluez.ProfileManager1")
    try:
        pm.RegisterProfile(PROFILE_PATH, HFP_HF_UUID, {"Name": "Lead Finder Hands-Free", "Version": dbus.UInt16(0x0107), "Features": dbus.UInt16(HF_SDP_FEATURES), "RequireAuthentication": True, "RequireAuthorization": False, "AutoConnect": True})
        hf_registered, hf_error = True, None
    except dbus.DBusException as e:
        hf_registered = False
        busy = "already" in (e.get_dbus_message() or "").lower() or e.get_dbus_name() == "org.bluez.Error.AlreadyExists"
        hf_error = "The sound server (PipeWire) is using this computer's Hands-Free role." if busy else dbus_error(e)
        emit({"event": "hf_profile", "ok": False, "busy": busy, "error": hf_error})
        return
    emit({"event": "hf_profile", "ok": True})


# --- pairing agent: the passkey is confirmed by the user in the app -----------------

pending_confirm = None  # (ok, err) callbacks


class Rejected(dbus.DBusException):
    _dbus_error_name = "org.bluez.Error.Rejected"


class Agent(dbus.service.Object):
    def _address(self, device):
        try:
            return str(props(device, "org.bluez.Device1").Get("org.bluez.Device1", "Address"))
        except dbus.DBusException:
            return ""

    @dbus.service.method("org.bluez.Agent1", in_signature="ou", out_signature="", async_callbacks=("ok", "err"))
    def RequestConfirmation(self, device, passkey, ok, err):
        global pending_confirm
        pending_confirm = (ok, err)
        emit({"event": "confirm", "address": self._address(device), "passkey": "%06d" % int(passkey)})

    @dbus.service.method("org.bluez.Agent1", in_signature="o", out_signature="", async_callbacks=("ok", "err"))
    def RequestAuthorization(self, device, ok, err):
        global pending_confirm
        pending_confirm = (ok, err)
        emit({"event": "confirm", "address": self._address(device), "passkey": None})

    @dbus.service.method("org.bluez.Agent1", in_signature="os", out_signature="")
    def AuthorizeService(self, device, uuid):
        return

    @dbus.service.method("org.bluez.Agent1", in_signature="o", out_signature="s")
    def RequestPinCode(self, device):
        # Phones pair with a confirmed passkey; PIN pairing is not offered.
        raise Rejected("PIN pairing is not supported")

    @dbus.service.method("org.bluez.Agent1", in_signature="o", out_signature="u")
    def RequestPasskey(self, device):
        raise Rejected("Passkey entry is not supported")

    @dbus.service.method("org.bluez.Agent1", in_signature="ouq", out_signature="")
    def DisplayPasskey(self, device, passkey, entered):
        emit({"event": "passkey", "address": self._address(device), "passkey": "%06d" % int(passkey)})

    @dbus.service.method("org.bluez.Agent1", in_signature="os", out_signature="")
    def DisplayPinCode(self, device, pincode):
        emit({"event": "passkey", "address": self._address(device), "passkey": str(pincode)})

    @dbus.service.method("org.bluez.Agent1", in_signature="", out_signature="")
    def Cancel(self):
        global pending_confirm
        pending_confirm = None
        emit({"event": "confirm_cancelled"})

    @dbus.service.method("org.bluez.Agent1", in_signature="", out_signature="")
    def Release(self):
        pass


# --- commands -------------------------------------------------------------------------


def reply(rid, result=None, error=None):
    if error is None:
        emit({"id": rid, "ok": True, "result": result})
    else:
        emit({"id": rid, "ok": False, "error": error})


def dbus_error(e):
    name = e.get_dbus_name() if isinstance(e, dbus.DBusException) else ""
    msg = e.get_dbus_message() if isinstance(e, dbus.DBusException) else str(e)
    known = {
        "org.bluez.Error.AuthenticationFailed": "Pairing failed: the codes were not confirmed on both devices.",
        "org.bluez.Error.AuthenticationCanceled": "Pairing was cancelled.",
        "org.bluez.Error.AuthenticationRejected": "Pairing was rejected on the phone.",
        "org.bluez.Error.AuthenticationTimeout": "Pairing timed out: confirm the code on the phone.",
        "org.bluez.Error.ConnectionAttemptFailed": "The phone did not answer: keep its Bluetooth on and in range.",
        "org.bluez.Error.AlreadyExists": "Already paired.",
        "org.bluez.Error.InProgress": "Already in progress.",
        "org.bluez.Error.NotReady": "Bluetooth is off on this computer.",
        "org.freedesktop.DBus.Error.NoReply": "The phone did not answer in time.",
    }
    if name in known:
        return known[name]

    if "br-connection-profile-unavailable" in (msg or "") or name == "org.bluez.Error.NotAvailable":
        return "The Lead Finder app is not running on the phone (open it once and keep Bluetooth on)."
    return msg or name or "Bluetooth error"


def device_iface(address, iface="org.bluez.Device1"):
    path = device_path(address)
    if not path:
        raise RuntimeError("That device is not known: scan for it first.")
    return dbus.Interface(bus.get_object(BLUEZ, path), iface), path


def run_async(rid, method, *args, done=None):
    def ok(*_):
        try:
            reply(rid, done() if done else True)
        except Exception as e:  # noqa: BLE001
            reply(rid, error=str(e))

    def err(e):
        reply(rid, error=dbus_error(e))

    method(*args, reply_handler=ok, error_handler=err, timeout=60)


def handle(req):
    global pending_confirm
    rid = req.get("id")
    cmd = req.get("cmd")
    address = str(req.get("address") or "").upper()
    try:
        if cmd == "state":
            return reply(rid, snapshot())
        ad = adapter_path()
        if not ad:
            raise RuntimeError("No Bluetooth adapter was found on this computer.")
        adapter = dbus.Interface(bus.get_object(BLUEZ, ad), "org.bluez.Adapter1")
        if cmd == "power":
            props(ad, "org.bluez.Adapter1").Set("org.bluez.Adapter1", "Powered", dbus.Boolean(bool(req.get("on"))))
            return reply(rid, True)
        if cmd == "visible":
            # Lets the phone find and pair with this computer (for 3 minutes).
            p = props(ad, "org.bluez.Adapter1")
            on = bool(req.get("on"))
            if on:
                p.Set("org.bluez.Adapter1", "PairableTimeout", dbus.UInt32(180))
                p.Set("org.bluez.Adapter1", "DiscoverableTimeout", dbus.UInt32(180))
            p.Set("org.bluez.Adapter1", "Pairable", dbus.Boolean(on))
            p.Set("org.bluez.Adapter1", "Discoverable", dbus.Boolean(on))
            return reply(rid, True)
        if cmd == "scan":
            if req.get("on"):
                try:
                    adapter.SetDiscoveryFilter({"Transport": "bredr"})
                except dbus.DBusException:
                    pass
                try:
                    adapter.StartDiscovery()
                except dbus.DBusException as e:
                    if e.get_dbus_name() != "org.bluez.Error.InProgress":
                        raise
            else:
                try:
                    adapter.StopDiscovery()
                except dbus.DBusException:
                    pass
            return reply(rid, True)
        if cmd == "pair":
            dev, path = device_iface(address)

            def trust():
                props(path, "org.bluez.Device1").Set("org.bluez.Device1", "Trusted", dbus.Boolean(True))
                return True

            return run_async(rid, dev.Pair, done=trust)
        if cmd == "confirm":
            cb = pending_confirm
            pending_confirm = None
            if not cb:
                return reply(rid, error="Nothing is waiting for confirmation.")
            if req.get("accept"):
                cb[0]()
            else:
                cb[1](Rejected("Rejected by the user"))
            return reply(rid, True)
        if cmd == "connect":
            dev, _ = device_iface(address)
            return run_async(rid, dev.Connect)
        if cmd == "link":
            # Hands-Free: BlueZ connects the phone's Audio Gateway to this computer's HF profile.
            if address in links:
                return reply(rid, True)
            if not hf_registered:
                raise RuntimeError(hf_error or "The Hands-Free role is not available.")
            dev, _ = device_iface(address)
            return run_async(rid, dev.ConnectProfile, HFP_AG_UUID)
        if cmd == "audio":
            voice.configure(req.get("play") or "", req.get("record") or "", bool(req.get("muted")), bool(req.get("remote")))
            return reply(rid, True)
        if cmd == "voice_out":
            voice.mic_in(base64.b64decode(str(req.get("data") or "")))
            return  # no reply: 50 a second
        if cmd == "sco_connect":
            voice.connect(address)
            return reply(rid, True)
        if cmd == "sco_disconnect":
            voice.close("moved to the phone")
            return reply(rid, True)
        if cmd.startswith("map_"):
            return map_command(rid, cmd, req, address)
        if cmd == "register_hf":
            if not hf_registered:
                register_hf()
            return reply(rid, hf_registered)
        if cmd == "unlink":
            close_link(address, "closed by Lead Finder")
            return reply(rid, True)
        if cmd == "disconnect":
            close_link(address, "disconnected")
            dev, _ = device_iface(address)
            return run_async(rid, dev.Disconnect)
        if cmd == "remove":
            close_link(address, "removed")
            path = device_path(address)
            if path:
                adapter.RemoveDevice(path)
            return reply(rid, True)
        if cmd == "send":
            send_line(address, str(req.get("line") or ""))
            return reply(rid, True)
        raise RuntimeError("Unknown command: %s" % cmd)
    except dbus.DBusException as e:
        reply(rid, error=dbus_error(e))
    except Exception as e:  # noqa: BLE001
        reply(rid, error=str(e))


stdin_buf = b""


def on_stdin(fd, cond):
    global stdin_buf
    if cond & (GLib.IO_HUP | GLib.IO_ERR):
        loop.quit()
        return False
    chunk = os.read(fd, 65536)
    if not chunk:
        loop.quit()
        return False
    stdin_buf += chunk
    while b"\n" in stdin_buf:
        line, stdin_buf = stdin_buf.split(b"\n", 1)
        if not line.strip():
            continue
        try:
            req = json.loads(line)
        except ValueError:
            continue
        handle(req)
    return True


def on_props_changed(iface, changed, invalidated, path=None):
    if iface in ("org.bluez.Device1", "org.bluez.Battery1"):
        ifaces = objects().get(path)
        if ifaces and "org.bluez.Device1" in ifaces:
            emit({"event": "device", "device": device_info(path, ifaces)})
    elif iface == "org.bluez.Adapter1":
        emit({"event": "adapter", "adapter": adapter_info()})


def on_added(path, ifaces):
    if "org.bluez.Device1" in ifaces:
        emit({"event": "device", "device": device_info(path, objects().get(path, ifaces))})
    elif "org.bluez.Adapter1" in ifaces:
        emit({"event": "adapter", "adapter": adapter_info()})


def on_removed(path, ifaces):
    if "org.bluez.Device1" in ifaces:
        emit({"event": "device_removed", "path": str(path)})
    elif "org.bluez.Adapter1" in ifaces:
        emit({"event": "adapter", "adapter": adapter_info()})


def main():
    bus.add_signal_receiver(on_props_changed, dbus_interface="org.freedesktop.DBus.Properties", signal_name="PropertiesChanged", bus_name=BLUEZ, path_keyword="path")
    bus.add_signal_receiver(on_added, dbus_interface="org.freedesktop.DBus.ObjectManager", signal_name="InterfacesAdded", bus_name=BLUEZ)
    bus.add_signal_receiver(on_removed, dbus_interface="org.freedesktop.DBus.ObjectManager", signal_name="InterfacesRemoved", bus_name=BLUEZ)
    Agent(bus, AGENT_PATH)
    Profile(bus, PROFILE_PATH)
    manager = dbus.Interface(bus.get_object(BLUEZ, "/org/bluez"), "org.bluez.AgentManager1")
    manager.RegisterAgent(AGENT_PATH, "DisplayYesNo")
    register_hf()
    ad = adapter_info()
    if ad:
        voice.listen(ad["address"])
    GLib.io_add_watch(sys.stdin.fileno(), GLib.IO_IN | GLib.IO_HUP | GLib.IO_ERR, on_stdin)
    emit({"event": "ready", "state": snapshot()})
    loop.run()


if __name__ == "__main__":
    try:
        main()
    except dbus.DBusException as e:
        emit({"event": "fatal", "error": dbus_error(e)})
        sys.exit(1)
