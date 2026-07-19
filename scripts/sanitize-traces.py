#!/usr/bin/env python3
"""Sanitize verbatim system prompt text from NDJSON trace bodies.

For each .ndjson file in fixtures/traces/:
  1. Reassemble request_body records into the full API request body
  2. Find the `system` field (array of content blocks)
  3. Replace each text block with a sha256 hash reference
  4. Re-chunk the sanitized body back into the request_body records
  5. Write the file in-place

Other records (request metadata, response, response_body) pass through untouched.
"""

import json
import base64
import hashlib
import sys
from pathlib import Path


def b64decode(data):
    """Decode base64 with automatic padding correction."""
    missing = len(data) % 4
    if missing:
        data += "=" * (4 - missing)
    return base64.b64decode(data)


def sanitize_system_blocks(system_field):
    """Replace text in system blocks with sha256 references."""
    if isinstance(system_field, str):
        h = hashlib.sha256(system_field.encode()).hexdigest()[:12]
        return f"[SANITIZED system prompt — sha256:{h}]"

    if isinstance(system_field, list):
        cleaned = []
        for block in system_field:
            if isinstance(block, dict) and "text" in block:
                h = hashlib.sha256(block["text"].encode()).hexdigest()[:12]
                block = {
                    **block,
                    "text": f"[SANITIZED system block — sha256:{h}]",
                }
            cleaned.append(block)
        return cleaned

    return system_field


def sanitize_file(path):
    """Sanitize one NDJSON trace file in-place. Returns True if modified."""
    with open(path, "r", encoding="utf-8") as f:
        raw = f.read().strip()
    if not raw:
        return False

    records = [json.loads(line) for line in raw.split("\n") if line.strip()]

    body_indices = [
        i
        for i, r in enumerate(records)
        if r.get("type") == "request_body" and r.get("data")
    ]
    if not body_indices:
        return False

    # Reassemble all request_body chunks
    body_parts = []
    for i in body_indices:
        try:
            body_parts.append(b64decode(records[i]["data"]))
        except Exception:
            continue

    if not body_parts:
        return False

    full_body = b"".join(body_parts)

    try:
        body_json = json.loads(full_body.decode("utf-8"))
    except Exception:
        return False

    system_field = body_json.get("system")
    if system_field is None:
        return False

    # Sanitize
    body_json["system"] = sanitize_system_blocks(system_field)

    # Re-serialize and base64-encode
    new_body = json.dumps(body_json, ensure_ascii=False).encode("utf-8")
    new_b64 = base64.b64encode(new_body).decode("utf-8")

    # Re-chunk: distribute the new b64 across the same number of body records.
    # Split at 4-character boundaries so each chunk is valid standalone b64.
    k = len(body_indices)
    chunk_bytes = (len(new_b64) // (k * 4)) * 4  # round down to 4-char boundary
    if chunk_bytes == 0:
        chunk_bytes = 4

    cursor = 0
    for idx, i in enumerate(body_indices):
        start = cursor
        if idx == k - 1:
            end = len(new_b64)
        else:
            end = min(cursor + chunk_bytes, len(new_b64))
            # Adjust to 4-character boundary
            while end > start and end < len(new_b64) and end % 4 != 0:
                end += 1
        records[i]["data"] = new_b64[start:end]
        cursor = end

    # Write back
    with open(path, "w", encoding="utf-8") as f:
        for r in records:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")

    return True


def main():
    traces_dir = Path("fixtures/traces")
    if not traces_dir.is_dir():
        print(f"ERROR: {traces_dir} not found", file=sys.stderr)
        sys.exit(1)

    ndjson_files = sorted(traces_dir.rglob("*.ndjson"))
    print(f"Found {len(ndjson_files)} NDJSON files")

    modified = 0
    skipped = 0
    for path in ndjson_files:
        result = sanitize_file(path)
        if result:
            modified += 1
        else:
            skipped += 1

    print(f"Modified: {modified}, Skipped: {skipped}")


if __name__ == "__main__":
    main()
