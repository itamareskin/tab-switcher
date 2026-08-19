#!/usr/bin/env python3
"""Extract the zip payload from a Chrome CRX package.

A CRX is a zip archive with a signature header prepended. `unzip` will usually
cope with the extra leading bytes and just warn, but the offset arithmetic is
worth doing explicitly so the unpack is reproducible and so a malformed or
unexpected package fails loudly instead of quietly extracting garbage.

Layout, all integers little-endian uint32:

    bytes 0..4    magic, always b"Cr24"
    bytes 4..8    format version, 2 or 3

    CRX3 (version 3)
    bytes 8..12   header length; zip starts at 12 + header_len

    CRX2 (version 2)
    bytes 8..12   public key length
    bytes 12..16  signature length; zip starts at 16 + pk_len + sig_len

Usage: unpack-crx.py <file.crx> <dest-dir>
"""

import io
import struct
import sys
import zipfile
from pathlib import Path

MAGIC = b"Cr24"


def zip_offset(blob: bytes) -> int:
    """Return the byte offset where the zip archive begins."""
    if blob[:4] != MAGIC:
        raise ValueError(f"not a CRX: expected magic {MAGIC!r}, got {blob[:4]!r}")

    (version,) = struct.unpack_from("<I", blob, 4)

    if version == 3:
        (header_len,) = struct.unpack_from("<I", blob, 8)
        return 12 + header_len
    if version == 2:
        pk_len, sig_len = struct.unpack_from("<II", blob, 8)
        return 16 + pk_len + sig_len
    raise ValueError(f"unsupported CRX format version: {version}")


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        print(__doc__.strip().splitlines()[-1], file=sys.stderr)
        return 2

    src, dest = Path(argv[1]), Path(argv[2])
    blob = src.read_bytes()

    offset = zip_offset(blob)
    if offset >= len(blob):
        raise ValueError(f"header length {offset} runs past end of {len(blob)}-byte file")

    payload = blob[offset:]
    if payload[:2] != b"PK":
        raise ValueError(
            f"no zip signature at offset {offset} (found {payload[:2]!r}) "
            "- header arithmetic is wrong for this file"
        )

    dest.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(io.BytesIO(payload)) as zf:
        # Refuse path traversal rather than trusting the archive's own names.
        for name in zf.namelist():
            resolved = (dest / name).resolve()
            if not resolved.is_relative_to(dest.resolve()):
                raise ValueError(f"refusing entry that escapes dest: {name}")
        zf.extractall(dest)
        count = len(zf.namelist())

    print(f"CRX{struct.unpack_from('<I', blob, 4)[0]}: zip at offset {offset}, "
          f"extracted {count} entries to {dest}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
