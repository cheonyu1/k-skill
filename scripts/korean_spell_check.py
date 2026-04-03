from __future__ import annotations

import argparse
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import asdict, dataclass
from html import unescape
from pathlib import Path
from typing import Callable

DEFAULT_RESULTS_URL = "https://nara-speller.co.kr/old_speller/results"
DEFAULT_MAX_CHARS = 1500
DEFAULT_TIMEOUT = 30
DEFAULT_THROTTLE_SECONDS = 1.2
RESULT_PAYLOAD_PATTERN = re.compile(r"data\s*=\s*(\[[\s\S]*?\]);\s*pageIdx\s*=")
TAG_PATTERN = re.compile(r"<[^>]+>")
LINE_BREAK_PATTERN = re.compile(r"<br\s*/?>", re.IGNORECASE)
SENTENCE_BOUNDARY_PATTERN = re.compile(r"(?<=[.!?。！？])\s+")

DEFAULT_HEADERS = {
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "ko,en-US;q=0.9,en;q=0.8",
    "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
    "Origin": "https://nara-speller.co.kr",
    "Referer": "https://nara-speller.co.kr/old_speller/",
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36"
    ),
}


@dataclass(frozen=True)
class SpellCheckIssue:
    chunk_index: int
    page_index: int
    issue_index: int
    sentence: str
    original: str
    suggestions: list[str]
    reason: str
    start: int | None
    end: int | None
    correct_method: int | None
    error_message: str


def strip_html(value: str | None) -> str:
    text = LINE_BREAK_PATTERN.sub("\n", value or "")
    text = TAG_PATTERN.sub("", text)
    return unescape(text).strip()


def split_candidates(value: str | None) -> list[str]:
    return [candidate.strip() for candidate in str(value or "").split("|") if candidate.strip()]


def split_text_into_chunks(text: str, max_chars: int = DEFAULT_MAX_CHARS) -> list[str]:
    normalized = str(text or "").strip()
    if not normalized:
        return []

    paragraphs = [paragraph.strip() for paragraph in re.split(r"\n\s*\n", normalized) if paragraph.strip()]
    chunks: list[str] = []
    current = ""

    for paragraph in paragraphs:
        candidate = paragraph if not current else f"{current}\n\n{paragraph}"

        if len(candidate) <= max_chars:
            current = candidate
            continue

        if current:
            chunks.append(current)
            current = ""

        if len(paragraph) <= max_chars:
            current = paragraph
            continue

        for sentence in split_long_paragraph(paragraph, max_chars=max_chars):
            if len(sentence) <= max_chars:
                chunks.append(sentence)
                continue

            start = 0
            while start < len(sentence):
                chunks.append(sentence[start : start + max_chars].strip())
                start += max_chars

    if current:
        chunks.append(current)

    return chunks


def split_long_paragraph(paragraph: str, *, max_chars: int) -> list[str]:
    sentences = [sentence.strip() for sentence in SENTENCE_BOUNDARY_PATTERN.split(paragraph) if sentence.strip()]

    if len(sentences) <= 1:
        return [paragraph.strip()]

    groups: list[str] = []
    current = ""

    for sentence in sentences:
        candidate = sentence if not current else f"{current} {sentence}"

        if len(candidate) <= max_chars:
            current = candidate
            continue

        if current:
            groups.append(current)
        current = sentence

    if current:
        groups.append(current)

    return groups


def fetch_spell_check_html(
    text: str,
    *,
    strong_rules: bool = True,
    timeout: int = DEFAULT_TIMEOUT,
    url: str = DEFAULT_RESULTS_URL,
) -> str:
    body = {
        "text1": text,
        "chkKey": "",
    }

    if strong_rules:
        body["btnModeChange"] = "on"

    request = urllib.request.Request(
        url,
        data=urllib.parse.urlencode(body).encode("utf-8"),
        headers=DEFAULT_HEADERS,
        method="POST",
    )

    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.read().decode("utf-8", "ignore")
    except urllib.error.HTTPError as error:  # type: ignore[attr-defined]
        if error.code == 403:
            raise RuntimeError(
                "The spell-check service returned HTTP 403. "
                "This environment may be hitting a Cloudflare/browser challenge. "
                "Retry later with lower request volume or from a browser-friendly network."
            ) from error

        raise RuntimeError(f"The spell-check service returned HTTP {error.code}.") from error


def extract_result_payload(html: str) -> list[dict]:
    match = RESULT_PAYLOAD_PATTERN.search(html)

    if not match:
        raise ValueError("Unable to find the spell-check payload in the returned HTML.")

    payload = json.loads(match.group(1))

    if not isinstance(payload, list):
        raise ValueError("The extracted spell-check payload was not a list.")

    return payload


def apply_page_corrections(page: dict) -> str:
    source = str(page.get("str", ""))
    corrected = source

    for error in sorted(page.get("errInfo", []), key=lambda item: int(item.get("start", -1)), reverse=True):
        suggestions = split_candidates(error.get("candWord"))
        original = str(error.get("orgStr", ""))

        if not suggestions:
            continue

        start = int(error.get("start", -1))
        end = int(error.get("end", -1))

        if start < 0 or end < start or end >= len(source):
            continue

        slice_end = end + 1
        if original:
            while slice_end > start and source[start:slice_end] != original and source[start : slice_end - 1] == original:
                slice_end -= 1

        corrected = f"{corrected[:start]}{suggestions[0]}{corrected[slice_end:]}"

    return corrected


def build_issue(chunk_index: int, page_index: int, issue_index: int, page: dict, error: dict) -> SpellCheckIssue:
    return SpellCheckIssue(
        chunk_index=chunk_index,
        page_index=page_index,
        issue_index=issue_index,
        sentence=str(page.get("str", "")),
        original=str(error.get("orgStr", "")),
        suggestions=split_candidates(error.get("candWord")),
        reason=strip_html(error.get("help")) or strip_html(error.get("errMsg")),
        start=int(error["start"]) if str(error.get("start", "")).strip() else None,
        end=int(error["end"]) if str(error.get("end", "")).strip() else None,
        correct_method=int(error["correctMethod"])
        if str(error.get("correctMethod", "")).strip()
        else None,
        error_message=strip_html(error.get("errMsg")),
    )


def check_text(
    text: str,
    *,
    max_chars: int = DEFAULT_MAX_CHARS,
    strong_rules: bool = True,
    timeout: int = DEFAULT_TIMEOUT,
    throttle_seconds: float = DEFAULT_THROTTLE_SECONDS,
    requester: Callable[..., str] = fetch_spell_check_html,
    sleep_fn: Callable[[float], None] = time.sleep,
) -> dict:
    chunks = split_text_into_chunks(text, max_chars=max_chars)
    corrected_chunks: list[str] = []
    issues: list[SpellCheckIssue] = []
    chunk_reports: list[dict] = []

    for chunk_index, chunk in enumerate(chunks):
        if chunk_index > 0 and throttle_seconds > 0:
            sleep_fn(throttle_seconds)

        html = requester(chunk, strong_rules=strong_rules, timeout=timeout)
        pages = extract_result_payload(html)
        corrected_pages = [apply_page_corrections(page) for page in pages]

        corrected_chunks.append("".join(corrected_pages))
        chunk_reports.append(
            {
                "chunk_index": chunk_index,
                "original_text": chunk,
                "corrected_text": "".join(corrected_pages),
                "page_count": len(pages),
            }
        )

        for page_index, page in enumerate(pages):
            for issue_index, error in enumerate(page.get("errInfo", [])):
                issues.append(build_issue(chunk_index, page_index, issue_index, page, error))

    return {
        "original_text": str(text or "").strip(),
        "corrected_text": "\n\n".join(corrected_chunks),
        "chunks": chunk_reports,
        "issues": issues,
        "meta": {
            "chunk_count": len(chunks),
            "strong_rules": strong_rules,
            "max_chars": max_chars,
        },
    }


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run the official Nara/PNU Korean spell checker.")
    parser.add_argument("--text", help="Inline Korean text to inspect.")
    parser.add_argument("--file", help="UTF-8 text/markdown file to inspect.")
    parser.add_argument("--max-chars", type=int, default=DEFAULT_MAX_CHARS)
    parser.add_argument("--timeout", type=int, default=DEFAULT_TIMEOUT)
    parser.add_argument("--throttle-seconds", type=float, default=DEFAULT_THROTTLE_SECONDS)
    parser.add_argument("--weak-rules", action="store_true", help="Disable the strong-rules checkbox.")
    parser.add_argument("--format", choices=["json", "text"], default="json")
    args = parser.parse_args(argv)

    if not args.text and not args.file:
        parser.error("Either --text or --file is required.")

    return args


def load_input(args: argparse.Namespace) -> str:
    if args.text:
        return args.text

    return Path(args.file).read_text(encoding="utf-8")


def serialize_report(report: dict) -> dict:
    return {
        **report,
        "issues": [asdict(issue) for issue in report["issues"]],
    }


def print_text_report(report: dict) -> None:
    print("# corrected_text")
    print(report["corrected_text"])
    print()
    print("# issues")

    for issue in report["issues"]:
        print(f"- chunk={issue.chunk_index} page={issue.page_index} issue={issue.issue_index}")
        print(f"  original: {issue.original}")
        print(f"  suggestions: {', '.join(issue.suggestions) if issue.suggestions else '(없음)'}")
        print(f"  reason: {issue.reason or '(없음)'}")


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    report = check_text(
        load_input(args),
        max_chars=args.max_chars,
        strong_rules=not args.weak_rules,
        timeout=args.timeout,
        throttle_seconds=args.throttle_seconds,
    )

    if args.format == "json":
        print(json.dumps(serialize_report(report), ensure_ascii=False, indent=2))
    else:
        print_text_report(report)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
