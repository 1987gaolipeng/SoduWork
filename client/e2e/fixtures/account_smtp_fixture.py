"""Loopback-only TLS SMTP capture for account E2E; no environment or app imports.

Use TLSSMTP(temp_directory), configure localhost / server.server_address[1],
and trust server.cert in the app's SMTP SSL context. Never runs an external relay.
"""
import ipaddress
import re
import socketserver
import ssl
import threading
from datetime import datetime, timedelta, timezone
from email import policy
from email.parser import BytesParser
from email.utils import getaddresses
from pathlib import Path

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID


class SMTPHandler(socketserver.StreamRequestHandler):
    def handle(self):
        self.wfile.write(b"220 fixture ESMTP\r\n")
        while line := self.rfile.readline():
            verb = line.split(b" ", 1)[0].strip().upper()
            if verb == b"EHLO":
                self.wfile.write(b"250-fixture\r\n250 AUTH PLAIN\r\n")
            elif verb == b"AUTH":
                self.wfile.write(b"235 authenticated\r\n")
            elif verb in {b"MAIL", b"RCPT", b"RSET"}:
                self.wfile.write(b"250 accepted\r\n")
            elif verb == b"DATA":
                self.wfile.write(b"354 end with dot\r\n")
                data = []
                while (part := self.rfile.readline()) not in {b".\r\n", b""}:
                    data.append(part[1:] if part.startswith(b"..") else part)
                with self.server.message_lock:
                    self.server.messages.append(b"".join(data))
                self.wfile.write(b"250 queued\r\n")
            elif verb == b"QUIT":
                self.wfile.write(b"221 bye\r\n")
                break
            else:
                self.wfile.write(b"500 unknown\r\n")


class TLSSMTP(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True

    def __init__(self, directory):
        directory = Path(directory)
        directory.mkdir(parents=True, exist_ok=True)
        key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "localhost")])
        now = datetime.now(timezone.utc)
        cert = (x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key())
            .serial_number(x509.random_serial_number()).not_valid_before(now - timedelta(minutes=1))
            .not_valid_after(now + timedelta(days=1)).add_extension(x509.SubjectAlternativeName([
                x509.DNSName("localhost"), x509.IPAddress(ipaddress.ip_address("127.0.0.1"))]), False)
            .sign(key, hashes.SHA256()))
        self.cert = str(directory / "fixture-cert.pem")
        key_path = str(directory / "fixture-key.pem")
        Path(self.cert).write_bytes(cert.public_bytes(serialization.Encoding.PEM))
        Path(key_path).write_bytes(key.private_bytes(serialization.Encoding.PEM,
            serialization.PrivateFormat.TraditionalOpenSSL, serialization.NoEncryption()))
        self.tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        self.tls.load_cert_chain(self.cert, key_path)
        self.messages = []
        self.message_lock = threading.Lock()
        super().__init__(("127.0.0.1", 0), SMTPHandler)
        self.thread = threading.Thread(target=self.serve_forever, daemon=True)
        self.thread.start()

    def get_request(self):
        sock, peer = super().get_request()
        sock.settimeout(10)
        try:
            return self.tls.wrap_socket(sock, server_side=True), peer
        except Exception:
            sock.close()
            raise

    def last_code(self, recipient, *, after=0):
        """Latest matching captured OTP after message index, or None if not sent yet."""
        with self.message_lock:
            captured = list(self.messages[after:])
        for raw in reversed(captured):
            message = BytesParser(policy=policy.default).parsebytes(raw)
            addresses = [address.lower() for _name, address in getaddresses(message.get_all("To", []))]
            if recipient.lower() not in addresses:
                continue
            body = message.get_body(preferencelist=("plain",)) if message.is_multipart() else message
            if body is not None:
                match = re.search(r"验证码[：:]\s*([0-9]{6})(?![0-9])", body.get_content())
                if match:
                    return match.group(1)
        return None

    def stop(self):
        self.shutdown()
        self.server_close()
        self.thread.join()
