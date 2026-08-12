#!/usr/bin/env python3
"""oc-go-luna-vision: send image(s) to the gpt-5.6-luna vision model via the opencode-go provider.

Reads model config from ~/.pi/agent/models-store.json and API key from ~/.pi/agent/auth.json.
Accepts Windows paths (C:\\Users\\...) and WSL paths (/mnt/c/...).
"""

import argparse
import base64
import json
import mimetypes
import os
import pathlib
import re
import sys
import urllib.error
import urllib.request


def load_json(path):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError) as e:
        sys.exit(f"ERROR: cannot read {path}: {e}")


def resolve_path(p):
    """Resolve a Windows-style or WSL-style path to a real file."""
    cand = None
    p = p.strip().replace("\\", "/")
    if os.path.exists(p):
        return p
    m = re.match(r"^([A-Za-z]):/(.*)$", p)
    if m:
        cand = f"/mnt/{m.group(1).lower()}/{m.group(2)}"
        if os.path.exists(cand):
            return cand
    raise FileNotFoundError(f"image not found: {p!r} (also tried {cand!r})")


def find_luna_model(store, model_id=None):
    """Find gpt-5.6-luna (or a model id override) in the models-store."""
    for provider, pv in store.items():
        for m in pv.get("models", []):
            mid = m.get("id", "")
            if model_id:
                if mid == model_id:
                    return mid, m, provider
            elif "luna" in mid and "image" in m.get("input", []):
                return mid, m, provider
    return None, None, None


def main():
    ap = argparse.ArgumentParser(
        description="Vision understanding via gpt-5.6-luna (opencode-go provider)."
    )
    ap.add_argument(
        "images", nargs="+", help="image file path(s): Windows or WSL style"
    )
    ap.add_argument(
        "--prompt",
        required=True,
        help=(
            "REQUIRED: the question to ask about the image(s). Must be explicitly "
            "constructed by the calling model for the user's specific intent; the skill "
            "forbids omitting it. Example: '请详细描述这张图片的内容'"
        ),
    )
    ap.add_argument(
        "--model",
        default=None,
        help="override model id (default: gpt-5.6-luna from models-store)",
    )
    ap.add_argument(
        "--max-tokens",
        type=int,
        default=4096,
        help="max output tokens incl. reasoning (default 4096; xhigh/max effort needs more)",
    )
    ap.add_argument(
        "--effort",
        default="high",
        choices=["off", "low", "medium", "high", "xhigh", "max"],
        help="reasoning effort (default high; xhigh/max burn budget fast, raise --max-tokens)",
    )
    ap.add_argument(
        "--json",
        action="store_true",
        help="print the full raw JSON response instead of extracted text",
    )
    args = ap.parse_args()

    agent_dir = pathlib.Path.home() / ".pi" / "agent"
    store_path = agent_dir / "models-store.json"
    auth_path = agent_dir / "auth.json"
    if not store_path.exists() or not auth_path.exists():
        sys.exit(f"ERROR: need {store_path} and {auth_path}")

    store = load_json(store_path)
    auth = load_json(auth_path)

    model_id, cfg, provider = find_luna_model(store, args.model)
    if cfg is None:
        sys.exit("ERROR: vision-capable 'luna' model not found in models-store.json")

    key = (auth.get(provider) or {}).get("key")
    if not key:
        sys.exit(f"ERROR: no API key for provider {provider!r} in auth.json")

    # Build content: prompt first, then each image as a base64 data URL.
    content = [{"type": "input_text", "text": args.prompt}]
    for img in args.images:
        fp = resolve_path(img)
        mime = mimetypes.guess_type(fp)[0] or "image/jpeg"
        try:
            with open(fp, "rb") as f:
                b64 = base64.b64encode(f.read()).decode("ascii")
        except OSError as e:
            sys.exit(f"ERROR: cannot read {fp}: {e}")
        content.append(
            {"type": "input_image", "image_url": f"data:{mime};base64,{b64}"}
        )
        print(
            f"[oc-go-luna-vision] attached {fp} ({mime}, {len(b64) * 3 // 4} bytes)",
            file=sys.stderr,
        )

    payload = {
        "model": model_id,
        "instructions": (
            "You are a vision assistant. Answer the user's question about the provided "
            "image(s) accurately and in detail. If the image contains text, transcribe it verbatim."
        ),
        "input": [{"role": "user", "content": content}],
        "max_output_tokens": args.max_tokens,
        # Without an explicit effort the API defaults to medium, which skips deep
        # reasoning and produces shallower, more hallucination-prone answers.
        "reasoning": {"effort": args.effort},
    }

    base = cfg.get("baseUrl", "https://opencode.ai/zen/go/v1").rstrip("/")
    url = base + "/responses"
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
            # Cloudflare on opencode.ai rejects the default Python-urllib UA (HTTP 403, error 1010)
            "User-Agent": "curl/8.5.0",
            "Accept": "*/*",
        },
    )

    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            data = json.load(r)
    except urllib.error.HTTPError as e:
        sys.exit(
            f"HTTP {e.code} from {url}:\n{e.read().decode(errors='replace')[:2000]}"
        )
    except Exception as e:  # noqa: BLE001
        sys.exit(f"ERROR: {e}")

    if args.json:
        print(json.dumps(data, ensure_ascii=False, indent=2))
        return

    usage = data.get("usage") or {}
    print(
        f"[oc-go-luna-vision] model={data.get('model')} status={data.get('status')} "
        f"usage={usage.get('input_tokens')}in/{usage.get('output_tokens')}out "
        f"({usage.get('output_tokens_details', {}).get('reasoning_tokens', 0)} reasoning)",
        file=sys.stderr,
    )

    def collect_text(items):
        texts = []
        for it in items or []:
            t = it.get("type")
            if t == "output_text":
                texts.append(it.get("text", ""))
            elif t == "message":
                texts.extend(collect_text(it.get("content")))
        return texts

    texts = collect_text(data.get("output"))
    if not texts:
        sys.exit(
            "ERROR: no output_text in response (raw response below):\n"
            + json.dumps(data, ensure_ascii=False, indent=2)
        )
    print("\n".join(texts))


if __name__ == "__main__":
    main()
