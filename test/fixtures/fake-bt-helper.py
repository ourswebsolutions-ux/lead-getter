#!/usr/bin/env python3
"""A stand-in for src/dialer/bt-helper.py in end-to-end tests: one phone
("Test Phone") connected over Hands-Free, answering AT commands as a vivo
1920 did in a live session. It pairs (with a passkey to confirm), and plays
calls: ATD -> dialing, ringing, answered with the voice link on this
computer (numbers ending in 0: not answered); AT+CHUP -> ended. No Bluetooth is used."""

import json
import sys
import threading
import time

PHONE = "AA:BB:CC:DD:EE:01"
lock = threading.Lock()
state = {"paired": False, "connected": False}
NAMES = ["call", "callsetup", "service", "signal", "roam", "battchg", "callheld"]
ind = {"call": 0, "callsetup": 0, "service": 1, "signal": 4, "roam": 0, "battchg": 3, "callheld": 0}


def emit(o):
    with lock:
        sys.stdout.write(json.dumps(o) + "\n")
        sys.stdout.flush()


def device():
    return {"path": "/org/bluez/hci0/dev_AA", "address": PHONE, "name": "Test Phone", "icon": "phone", "deviceClass": 0x5A020C, "paired": state["paired"], "trusted": state["paired"], "connected": state["connected"], "rssi": -50, "uuids": [], "battery": None}


def later(delay, fn):
    threading.Thread(target=lambda: (time.sleep(delay), fn()), daemon=True).start()


def line(text):
    emit({"event": "data", "address": PHONE, "line": text})


def ciev(name, v):
    ind[name] = v
    line("+CIEV: %d,%d" % (NAMES.index(name) + 1, v))


def at(cmd):
    if cmd.startswith("AT+BRSF="):
        line("+BRSF: 2927")
    elif cmd == "AT+CIND=?":
        line('+CIND: ("call",(0,1)),("callsetup",(0-3)),("service",(0-1)),("signal",(0-5)),("roam",(0,1)),("battchg",(0-5)),("callheld",(0-2))')
    elif cmd == "AT+CIND?":
        line("+CIND: " + ",".join(str(ind[n]) for n in NAMES))
    elif cmd == "AT+CHLD=?":
        line("+CHLD: (0,1,2,3)")
    elif cmd == "AT+COPS?":
        line('+COPS: 0,0,"Jazz"')
    elif cmd == "AT+CNUM":
        line('+CNUM: ,"+923270583075",145,,4')
    elif cmd.startswith("ATD"):
        line("OK")
        later(0.2, lambda: ciev("callsetup", 2))
        later(0.5, lambda: ciev("callsetup", 3))
        if cmd.rstrip(";").endswith("0"):
            # Numbers ending in 0 ring and are not answered.
            later(1.5, lambda: ciev("callsetup", 0) if not ind["call"] else None)
        else:
            later(0.9, lambda: (emit({"event": "sco_up", "address": PHONE}), ciev("call", 1), ciev("callsetup", 0)))
        return
    elif cmd == "AT+CHUP":
        line("OK")
        later(0.2, lambda: (emit({"event": "sco_down", "address": PHONE, "reason": "closed by the phone"}), ciev("call", 0)))
        return
    line("OK")


ADAPTER = {"path": "/org/bluez/hci0", "address": "00:11:22:33:44:55", "name": "test-laptop", "powered": True, "discovering": False, "visible": False}
pending_pair = None

emit({"event": "hf_profile", "ok": True})
emit({"event": "ready", "state": {"adapter": ADAPTER, "devices": [], "links": []}})

for raw in sys.stdin:
    try:
        req = json.loads(raw)
    except ValueError:
        continue
    rid, cmd = req.get("id"), req.get("cmd")
    if cmd == "scan":
        if req.get("on"):
            emit({"event": "device", "device": device()})
        emit({"id": rid, "ok": True, "result": True})
    elif cmd == "pair":
        pending_pair = rid
        emit({"event": "confirm", "address": PHONE, "passkey": "123456"})
    elif cmd == "confirm":
        emit({"id": rid, "ok": True, "result": True})
        if pending_pair is not None:
            if req.get("accept"):
                state["paired"] = True
                emit({"event": "device", "device": device()})
                emit({"id": pending_pair, "ok": True, "result": True})
            else:
                emit({"id": pending_pair, "ok": False, "error": "Pairing was cancelled."})
            pending_pair = None
    elif cmd == "link":
        state["connected"] = True
        emit({"event": "device", "device": device()})
        emit({"id": rid, "ok": True, "result": True})
        emit({"event": "link_up", "address": PHONE})
    elif cmd in ("unlink", "disconnect"):
        emit({"id": rid, "ok": True, "result": True})
        emit({"event": "link_down", "address": PHONE, "reason": "closed by Lead Finder"})
    elif cmd == "send":
        emit({"id": rid, "ok": True, "result": True})
        at(req["line"])
    elif cmd == "sco_disconnect":
        emit({"id": rid, "ok": True, "result": True})
        emit({"event": "sco_down", "address": PHONE, "reason": "moved to the phone"})
    elif cmd == "sco_connect":
        emit({"id": rid, "ok": True, "result": True})
        later(0.2, lambda: emit({"event": "sco_up", "address": PHONE}))
    elif cmd == "register_hf":
        emit({"id": rid, "ok": True, "result": True})
    else:
        emit({"id": rid, "ok": True, "result": True})
