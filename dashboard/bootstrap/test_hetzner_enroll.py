"""Offline regression tests; no provider, real credential, or host mutation."""
import base64
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import ssl
import tempfile
import unittest
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location("hivra_enroll", Path(__file__).with_name("hetzner-enroll.py"))
enrollment = importlib.util.module_from_spec(spec)
spec.loader.exec_module(enrollment)
NOW = 1787842800.0  # 2026-08-27T15:00:00Z
TOKEN = "hbe1_" + "x" * 43
KEY = "ssh-ed25519 " + base64.b64encode(enrollment.PREFIX + bytes(range(1, 33))).decode()


def config():
    return {"version": 1, "recipeVersion": enrollment.RECIPE_VERSION,
            "orderId": "22222222-2222-4222-8222-222222222222",
            "attemptId": "33333333-3333-4333-8333-333333333333",
            "token": TOKEN, "issuedAt": "2026-08-27T15:00:00.000Z",
            "expiresAt": "2026-08-27T15:15:00.000Z",
            "callbackUrl": "https://hivra.example/api/infrastructure/first-boot/enroll"}


def acknowledgement():
    value = config()
    return {"version": 1, "accepted": True, "orderId": value["orderId"],
            "attemptId": value["attemptId"],
            "hostFingerprintSha256": enrollment.canonical_key(KEY)[1]}


class EnrollmentTests(unittest.TestCase):
    def run_enroll(self, request, **kwargs):
        return enrollment.enroll(config(), KEY + " guest@host", "42", request=request,
                                 wall_clock=lambda: NOW, pause=lambda _: None, **kwargs)

    def assert_code(self, code, operation):
        with self.assertRaises(enrollment.EnrollmentFailure) as caught:
            operation()
        self.assertEqual(caught.exception.code, code)
        self.assertNotIn(TOKEN, str(caught.exception))

    def test_exact_acknowledgement_and_public_only_body(self):
        request = Mock(return_value=(200, json.dumps(acknowledgement()).encode()))
        result = self.run_enroll(request)
        self.assertTrue(result["ok"])
        url, token, body, timeout = request.call_args.args
        self.assertEqual(url, config()["callbackUrl"])
        self.assertEqual(token, TOKEN)
        self.assertLessEqual(timeout, 5)
        self.assertEqual(json.loads(body), {"version": 1, "orderId": config()["orderId"],
                                          "attemptId": config()["attemptId"], "providerServerId": "42",
                                          "hostPublicKey": KEY})
        self.assertNotIn(TOKEN, body.decode())
        self.assertNotIn(TOKEN, json.dumps(result))

    def test_rejects_redirects_and_authority_failures_without_retry(self):
        for status in (301, 302, 307, 308, 400, 401, 403, 404, 409, 410):
            with self.subTest(status=status):
                request = Mock(return_value=(status, TOKEN.encode()))
                self.assert_code("ENROLLMENT_REJECTED", lambda: self.run_enroll(request))
                self.assertEqual(request.call_count, 1)

    def test_transient_retries_are_bounded(self):
        for status in (408, 429, 500, 502, 503, 504):
            with self.subTest(status=status):
                request = Mock(return_value=(status, TOKEN.encode()))
                self.assert_code("ENROLLMENT_UNAVAILABLE", lambda: self.run_enroll(request))
                self.assertEqual(request.call_count, enrollment.MAX_ATTEMPTS)
        request = Mock(side_effect=[enrollment.EnrollmentFailure("NETWORK_UNAVAILABLE"),
                                    (200, json.dumps(acknowledgement()).encode())])
        self.assertTrue(self.run_enroll(request)["ok"])
        self.assertEqual(request.call_count, 2)

    def test_monotonic_deadline_rejects_late_success(self):
        request = Mock(return_value=(200, json.dumps(acknowledgement()).encode()))
        self.assert_code("ENROLLMENT_TIMEOUT", lambda: self.run_enroll(
            request, monotonic=Mock(side_effect=[0, 1, enrollment.WINDOW_SECONDS])))

    def test_tls_failure_does_not_retry(self):
        request = Mock(side_effect=enrollment.EnrollmentFailure("TLS_VERIFICATION_FAILED"))
        self.assert_code("TLS_VERIFICATION_FAILED", lambda: self.run_enroll(request))
        self.assertEqual(request.call_count, 1)

    def test_rejects_acknowledgement_changes_and_malformed_json(self):
        mutations = [None, [], {**acknowledgement(), "accepted": 1},
                     {**acknowledgement(), "version": True}, {**acknowledgement(), "ready": True},
                     {**acknowledgement(), "orderId": config()["attemptId"]},
                     {**acknowledgement(), "attemptId": config()["orderId"]},
                     {**acknowledgement(), "hostFingerprintSha256": "SHA256:other"}]
        for value in mutations:
            with self.subTest(value=value):
                self.assert_code("INVALID_ACKNOWLEDGEMENT", lambda: self.run_enroll(
                    Mock(return_value=(200, json.dumps(value).encode()))))
        self.assert_code("INVALID_ACKNOWLEDGEMENT", lambda: self.run_enroll(Mock(return_value=(200, b"not-json"))))

    def test_configuration_and_expiry_are_strict(self):
        self.assertEqual(enrollment.validate_config(config(), lambda: NOW), config())
        for invalid in (None, {**config(), "version": True}, {**config(), "extra": 1},
                        {**config(), "token": TOKEN + "\n"}, {**config(), "recipeVersion": "later"},
                        {**config(), "attemptId": "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"}):
            self.assert_code("INVALID_CONFIGURATION", lambda: enrollment.validate_config(invalid, lambda: NOW))
        for timestamp in (NOW - 1, NOW + 900, NOW + 1000):
            self.assert_code("ENROLLMENT_EXPIRED", lambda: enrollment.validate_config(config(), lambda: timestamp))
        self.assert_code("ENROLLMENT_EXPIRED", lambda: enrollment.validate_config(
            {**config(), "expiresAt": "2026-08-27T15:16:00.000Z"}, lambda: NOW))

    def test_https_destination_has_no_url_credentials_or_redirect_path(self):
        for url in ("http://hivra.example" + enrollment.CALLBACK_PATH,
                    "https://user:pass@hivra.example" + enrollment.CALLBACK_PATH,
                    "https://hivra.example:8443" + enrollment.CALLBACK_PATH,
                    config()["callbackUrl"] + "?token=" + TOKEN,
                    config()["callbackUrl"] + "#" + TOKEN,
                    "https://hivra.example/other", "https://hivra.example\\@evil.example" + enrollment.CALLBACK_PATH):
            self.assert_code("INVALID_CONFIGURATION", lambda: enrollment.validate_config({**config(), "callbackUrl": url}, lambda: NOW))

    def test_direct_tls_transport_ignores_proxy_and_bounds_response(self):
        connection = Mock()
        response = connection.getresponse.return_value
        response.status = 307
        response.read.return_value = b"redirect-not-followed"
        with patch.object(enrollment.http.client, "HTTPSConnection", return_value=connection) as construct, \
             patch.dict(os.environ, {"HTTPS_PROXY": "https://untrusted-proxy.example"}):
            result = enrollment.request_registration(config()["callbackUrl"], TOKEN, b"{}", 5)
            self.assertEqual(result[0], 307)
            self.assertEqual(construct.call_args.args, ("hivra.example", 443))
            tls = construct.call_args.kwargs["context"]
            self.assertTrue(tls.check_hostname)
            self.assertEqual(tls.verify_mode, ssl.CERT_REQUIRED)
            self.assertEqual(connection.request.call_args.args, ("POST", enrollment.CALLBACK_PATH))
            self.assertEqual(connection.request.call_args.kwargs["headers"]["Authorization"], "Bearer " + TOKEN)
            response.read.assert_called_with(enrollment.MAX_RESPONSE + 1)
            connection.close.assert_called_once()
            response.read.return_value = b"x" * (enrollment.MAX_RESPONSE + 1)
            self.assert_code("INVALID_ACKNOWLEDGEMENT", lambda: enrollment.request_registration(config()["callbackUrl"], TOKEN, b"{}", 5))
            connection.request.side_effect = ssl.SSLCertVerificationError("secret " + TOKEN)
            self.assert_code("TLS_VERIFICATION_FAILED", lambda: enrollment.request_registration(config()["callbackUrl"], TOKEN, b"{}", 5))

    def test_metadata_is_exact_bounded_public_id(self):
        connection = Mock()
        response = connection.getresponse.return_value
        response.status = 200
        with patch.object(enrollment.http.client, "HTTPConnection", return_value=connection) as construct:
            response.read.return_value = b"42\n"
            self.assertEqual(enrollment.metadata_server_id(), "42")
            construct.assert_called_with("169.254.169.254", timeout=5)
            connection.request.assert_called_with("GET", "/hetzner/v1/metadata/instance-id")
            for bad in (b"0", b"0042", b"9007199254740992", b"42x", b"42" + b" " * 63):
                response.read.return_value = bad
                self.assert_code("METADATA_UNAVAILABLE", enrollment.metadata_server_id)
            response.status = 302
            response.read.return_value = b"42"
            self.assert_code("METADATA_UNAVAILABLE", enrollment.metadata_server_id)

    def test_canonical_ssh_wire_format(self):
        self.assertEqual(enrollment.canonical_key(KEY + " root@guest")[0], KEY)
        for bad in (KEY + "\n", KEY + "=", KEY + " comment with spaces", "ssh-ed25519 " + "A" * 68,
                    "ssh-ed25519 " + base64.b64encode(enrollment.PREFIX + bytes(32)).decode()):
            self.assert_code("INVALID_HOST_KEY", lambda: enrollment.canonical_key(bad))

    def test_root_file_permissions_symlinks_size_and_inode_bound_removal(self):
        # Test-owned files only. Ownership is normalized in mocked fstat so this
        # regression works as an ordinary developer, not only as root.
        with tempfile.TemporaryDirectory(prefix="hivra-enrollment-test-") as folder:
            file = Path(folder) / "config.json"
            file.write_text(json.dumps(config()))
            file.chmod(0o600)
            real_fstat = os.fstat
            def root_fstat(fd):
                values = list(real_fstat(fd))
                values[4] = 0
                return os.stat_result(values)
            with patch.object(enrollment.os, "fstat", side_effect=root_fstat), \
                 patch.object(enrollment, "validate_config", side_effect=lambda value: value):
                value, identity = enrollment.read_config(str(file))
                self.assertEqual(value, config())
                link = Path(folder) / "link"
                link.symlink_to(file)
                self.assert_code("INVALID_CONFIGURATION", lambda: enrollment.read_config(str(link)))
                file.chmod(0o644)
                self.assert_code("UNSAFE_CONFIGURATION_FILE", lambda: enrollment.read_config(str(file)))
                file.chmod(0o600)
                file.write_bytes(b"x" * 4097)
                self.assert_code("INVALID_CONFIGURATION", lambda: enrollment.read_config(str(file)))
                self.assert_code("CONFIGURATION_CHANGED", lambda: enrollment.remove_config((identity[0], -1), str(file)))
                self.assertTrue(file.exists())
                enrollment.remove_config(identity, str(file))
                self.assertFalse(file.exists())

    def test_main_never_logs_secret_exception_and_cancels_hard_deadline(self):
        output, errors = io.StringIO(), io.StringIO()
        with patch.object(enrollment.os, "geteuid", return_value=0), \
             patch.object(enrollment, "read_config", side_effect=RuntimeError(TOKEN)), \
             patch.object(enrollment.signal, "signal", return_value=enrollment.signal.SIG_DFL) as install, \
             patch.object(enrollment.signal, "setitimer") as timer, \
             contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors):
            self.assertEqual(enrollment.main(), 1)
            self.assertEqual(output.getvalue(), "")
            self.assertNotIn(TOKEN, errors.getvalue())
            self.assertIn("ENROLLMENT_FAILED", errors.getvalue())
            self.assertEqual(timer.call_args_list[0].args, (enrollment.signal.ITIMER_REAL, enrollment.WINDOW_SECONDS))
            self.assertEqual(timer.call_args_list[-1].args, (enrollment.signal.ITIMER_REAL, 0))
            self.assertEqual(install.call_args_list[-1].args, (enrollment.signal.SIGALRM, enrollment.signal.SIG_DFL))


if __name__ == "__main__":
    unittest.main()
