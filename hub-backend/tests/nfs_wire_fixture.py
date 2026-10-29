"""Isolated in-memory NFSv3 RPC peer; all traffic stays on loopback."""
import socketserver
import struct
import threading
import time


def uint(value):
    return struct.pack("!I", value)


def opaque(value):
    return uint(len(value)) + value + b"\0" * (-len(value) % 4)


class Reader:
    def __init__(self, data):
        self.data, self.offset = data, 0

    def number(self, wide=False):
        size = 8 if wide else 4
        value = struct.unpack_from("!Q" if wide else "!I", self.data, self.offset)[0]
        self.offset += size
        return value

    def blob(self):
        size = self.number()
        result = self.data[self.offset:self.offset + size]
        self.offset += size + (-size % 4)
        return result


class Peer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True

    def __init__(self):
        super().__init__(("127.0.0.1", 0), Handler)
        self.nodes = {b"root": {"type": 2, "data": b"", "children": {}}}
        self.serial = 0
        self.calls, self.auth = [], []
        self.short_write = 0
        self.fail_write = False
        self.bad_commit = False
        self.read_early_eof = False
        self.short_read = 0
        self.access_mask = 0x3f
        self.mount_status = 0
        self.mount_auth_flavors = [1]
        self.reply_fault = ""
        self.fragment = False
        self.connections = 0
        self.thread = threading.Thread(target=self.serve_forever, daemon=True)
        self.thread.start()

    @property
    def port(self):
        return self.server_address[1]

    def stop(self):
        self.shutdown()
        self.server_close()
        self.thread.join(timeout=2)

    def child(self, parent, name, kind=1):
        self.serial += 1
        handle = str(self.serial).encode()
        self.nodes[handle] = {"type": kind, "data": b"", "children": {}}
        self.nodes[parent]["children"][name] = handle
        return handle

    def resolve(self, path):
        handle = b"root"
        for part in path.split("/"):
            handle = self.nodes[handle]["children"][part]
        return self.nodes[handle]

    def attributes(self, handle):
        node = self.nodes[handle]
        return struct.pack("!5I2Q2I2Q6I", node["type"], 0o700, 1, 65534, 65534,
                           len(node["data"]), len(node["data"]), 0, 0, 1, 1, 0, 0, 0, 0, 0, 0)

    def dispatch(self, program, procedure, body):
        self.calls.append((program, procedure))
        if program == 100000:
            return uint(self.port)
        if program == 100005:
            if procedure == 1:
                self.export = Reader(body).blob().decode()
                if self.mount_status:
                    return uint(self.mount_status)
                return uint(0) + opaque(b"root") + uint(len(self.mount_auth_flavors)) + b"".join(uint(flavor) for flavor in self.mount_auth_flavors)
            return b""
        reader = Reader(body)
        handle = reader.blob()
        node = self.nodes[handle]
        if procedure == 1:
            return uint(0) + self.attributes(handle)
        if procedure == 4:
            return uint(0) + uint(0) + uint(self.access_mask)
        if procedure == 19:
            return uint(0) + uint(0) + struct.pack("!7IQ3I", 65536, 65536, 1, 65536, 65536, 1, 4096, 2**40, 0, 1, 0)
        if procedure == 3:
            name = reader.blob().decode()
            child = node["children"].get(name)
            return uint(2) + uint(0) if child is None else uint(0) + opaque(child) + uint(0) * 2
        if procedure in (8, 9):
            name = reader.blob().decode()
            if name in node["children"]:
                return uint(17) + uint(0) * 2
            child = self.child(handle, name, 2 if procedure == 9 else 1)
            return uint(0) + uint(1) + opaque(child) + uint(0) * 3
        if procedure == 7:
            offset, count = reader.number(True), reader.number()
            self.last_stability = reader.number()
            data = reader.blob()
            if self.fail_write:
                return uint(28) + uint(0) * 2
            if self.short_write:
                count = min(count, self.short_write)
            data = data[:count]
            current = node["data"]
            node["data"] = current[:offset].ljust(offset, b"\0") + data + current[offset + len(data):]
            return uint(0) + uint(0) * 2 + uint(count) + uint(0) + b"verifier"
        if procedure == 21:
            return uint(0) + uint(0) * 2 + (b"changed!" if self.bad_commit else b"verifier")
        if procedure == 6:
            offset, count = reader.number(True), reader.number()
            if self.short_read:
                count = min(count, self.short_read)
            data = node["data"][offset:offset + count]
            if self.read_early_eof:
                data = b""
            return uint(0) + uint(0) + uint(len(data)) + uint(self.read_early_eof or offset + len(data) >= len(node["data"])) + opaque(data)
        if procedure == 12:
            name = reader.blob().decode()
            child = node["children"].pop(name, None)
            return uint(0 if child else 2) + uint(0) * 2
        if procedure == 14:
            source = reader.blob().decode()
            destination = reader.blob()
            target = reader.blob().decode()
            child = node["children"].pop(source)
            self.nodes[destination]["children"][target] = child
            return uint(0) + uint(0) * 4
        raise AssertionError((program, procedure))


class Handler(socketserver.BaseRequestHandler):
    def exact(self, size):
        result = b""
        while len(result) < size:
            part = self.request.recv(size - len(result))
            if not part:
                raise EOFError()
            result += part
        return result

    def handle(self):
        peer = self.server
        peer.connections += 1
        try:
            while True:
                header = struct.unpack("!I", self.exact(4))[0]
                body = self.exact(header & 0x7fffffff)
                reader = Reader(body)
                xid, message, version = reader.number(), reader.number(), reader.number()
                program, program_version, procedure = reader.number(), reader.number(), reader.number()
                flavor, auth = reader.number(), reader.blob()
                if flavor == 1:
                    credentials = Reader(auth)
                    credentials.number()
                    machine = credentials.blob()
                    peer.auth.append((credentials.number(), credentials.number()))
                reader.number()
                reader.blob()
                payload = peer.dispatch(program, procedure, body[reader.offset:])
                fault = peer.reply_fault
                if fault == "timeout":
                    time.sleep(.25)
                if fault == "xid":
                    xid ^= 1
                reply = struct.pack("!6I", xid, 1, 0, 0, 0, 0) + payload
                if fault == "oversized":
                    self.request.sendall(uint(0x80000000 | (16 * 1024 * 1024)))
                    return
                if fault == "fragments":
                    self.request.sendall(uint(0) * 257)
                    return
                if fault == "eof":
                    self.request.sendall(uint(0x80000000 | len(reply)) + reply[:7])
                    return
                if peer.fragment:
                    chunks = [reply[:3], reply[3:13], reply[13:]]
                    for index, chunk in enumerate(chunks):
                        framed = uint(len(chunk) | (0x80000000 if index == 2 else 0)) + chunk
                        for start in range(0, len(framed), 3):
                            self.request.sendall(framed[start:start + 3])
                else:
                    self.request.sendall(uint(0x80000000 | len(reply)) + reply)
        except (EOFError, ConnectionError, OSError):
            pass
        finally:
            peer.connections -= 1
