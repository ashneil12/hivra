# Apple Root CA certificates (acquired at build time)

DER-encoded Apple root certificates used by `SignedDataVerifier`
(`@apple/app-store-server-library`) to verify the JWS signature chain on
App Store Server Notifications V2 and signed transactions. The source tree
does not redistribute the certificate bytes. `npm run apple:certs` downloads
them directly from Apple, verifies the pinned byte length and SHA-256, and
writes them to the ignored `.generated/apple-certs/` directory.

## Provenance

The acquisition manifest is maintained in
`docs/release/source-third-party-provenance.json`. Sources:

| File | Source URL | SHA-256 |
|---|---|---|
| `AppleIncRootCertificate.cer` | https://www.apple.com/appleca/AppleIncRootCertificate.cer | `b0b1730ecbc7ff4505142c49f1295e6eda6bcaed7e2c68c5be91b5a11001f024` |
| `AppleComputerRootCertificate.cer` | https://www.apple.com/certificateauthority/AppleComputerRootCertificate.cer | `0d83b611b648a1a75eb8558400795375cad92e264ed8e9d7a757c1f5ee2bb22d` |
| `AppleRootCA-G2.cer` | https://www.apple.com/certificateauthority/AppleRootCA-G2.cer | `c2b9b042dd57830e7d117dac55ac8ae19407d38e41d88f3215bc3a890444a050` |
| `AppleRootCA-G3.cer` | https://www.apple.com/certificateauthority/AppleRootCA-G3.cer | `63343abfb89a6a03ebb57e9b3f5fa7be7c4f5c756f3017b3a8c488c3653e9179` |

To acquire and re-verify:

```bash
npm run apple:certs
shasum -a 256 .generated/apple-certs/*.cer
openssl x509 -inform der -in .generated/apple-certs/AppleRootCA-G3.cer -noout -subject -enddate
```

## Notes

- **AppleRootCA-G3** anchors the chain Apple signs ASSN v2 payloads with today
  (ECC). The other three are included because Apple's own server-library
  sample code passes the full root set; the verifier picks whichever root the
  chain terminates at.
- `AppleComputerRootCertificate.cer` expired 2025-02-10. It is retained for
  parity with Apple's documented root set; it cannot validate a current chain
  and the verifier is constructed with `enableOnlineChecks: true`, so an
  expired chain would be rejected regardless.
- If Apple rotates roots, update the source URL, byte length, and SHA-256 in
  both the acquisition script and provenance policy. The fetcher fails closed
  when downloaded bytes do not match the reviewed manifest.
