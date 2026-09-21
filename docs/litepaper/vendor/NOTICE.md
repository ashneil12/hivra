# Litepaper animation dependencies

The litepaper includes GSAP and ScrollTrigger **3.15.0**, published by
GreenSock/Webflow. These two third-party files retain their original `/*! ... */`
copyright and licence headers. They are covered by the GSAP Standard "No Charge"
License, **not** Hivra's Apache-2.0 licence.

## Exact upstream source

On 2026-09-08, both local files were verified as byte-for-byte matches to the
following files in the official npm archive. This records a verified upstream
match; it does not assert which download route originally supplied the local
copies.

- Package metadata: <https://registry.npmjs.org/gsap/3.15.0>
- Archive: <https://registry.npmjs.org/gsap/-/gsap-3.15.0.tgz>
- Archive SHA-256: `d2e33ad202d4811e9084883f7ff9a27967ac4095caef51ca4c9d20697a253b1c`
- The archive also matched the SHA-512 integrity value in that version's npm
  metadata.

| Local file | Path inside npm archive | Bytes | SHA-256 |
| --- | --- | ---: | --- |
| `gsap-3.15.0.min.js` | `package/dist/gsap.min.js` | 72,927 | `92bb9a96476f983d212a2bc4f54c889039c1696dd4461d40a736860938570fbb` |
| `ScrollTrigger-3.15.0.min.js` | `package/dist/ScrollTrigger.min.js` | 44,575 | `b0b14d67b55b0c43c756ac0b106cfcb09d0879945f6ead64451065b0672916a2` |

## Licence and notices

The upstream headers identify:

> Copyright 2026, GreenSock. All rights reserved.

The exact licence URL in both headers and the npm package metadata is
<https://gsap.com/standard-license>. It currently redirects to the
[official Standard "No Charge" GSAP License](https://gsap.com/community/standard-license/).
The official page was checked on 2026-09-08 and states an effective date of
April 30, 2025 and a last modification date of May 30, 2025. The npm archive does
not include a standalone licence-text file; its metadata and these preserved
headers point to the official terms.

Those terms cover ordinary use in websites, web applications and digital
interfaces, including commercial use. They include restrictions concerning
competing visual animation builders and require proprietary notices to remain
intact. This summary does not replace the official terms or extend their scope.
Do not remove the original headers or describe these files as Apache-2.0 or
OSI-licensed software.

## Public-source release evidence

These files support the private litepaper review and local preview. This notice
records their identity and licence boundary; it is not public-release approval.
The repository's exact source-release provenance review must incorporate these
vendored distributions before an export containing them is approved. They are
not yet represented in `docs/release/source-third-party-provenance.json`, and
the lockfile-only npm inventory does not cover this vendor directory.

Any replacement, version upgrade or byte change needs fresh hashes, upstream
matching and licence review. Preserve the distinction between Hivra-owned
Apache-2.0 source and this separately licensed third-party code.

## Entry arrow

The inline `arrow-down-right` icon in `build.py` and the generated HTML is from
[Tabler Icons](https://github.com/tabler/tabler-icons/blob/main/icons/outline/arrow-down-right.svg).
Its path geometry is unchanged; the presentation uses a 1.5px stroke.

MIT License

Copyright (c) 2020-2026 Paweł Kuna

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
