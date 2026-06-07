import json
import os
import time

from fastapi import HTTPException
from google import genai
from google.genai import types
from prompts import SYSTEM_PROMPT

_client = genai.Client(api_key=os.environ["GEMINI_API_KEY"])

CONV_MODEL = "gemini-2.5-pro"
JSON_MODEL = "gemini-2.5-flash"
CACHE_TTL  = "3600s"   # 1 hr；每 session 建一次就夠

# Conversation model: pure natural language, no JSON block
_split = SYSTEM_PROMPT.split("## 輸出格式")
_CONV_SYSTEM = _split[0].rstrip() + "\n\n只用自然語言回覆，不要輸出任何 JSON 或 code block。"

_JSON_SYSTEM = """你是結構化資料萃取器。根據對話內容回傳評估 JSON。

規則：
- 只填入患者已明確說出或確認的資訊
- 未確認欄位填 null 或 "unknown"
- special_tests / red_flags 填陣列，沒有就填 []
- 只回傳 JSON，不要有任何其他文字

{
  "severity": 1-5,
  "body_site": "受傷部位（英文含左右側）或 null",
  "pain_score": 0-10 或 null,
  "weight_bearing": "full/partial/none/unknown",
  "mechanism": "受傷機制（英文）或 null",
  "key_finding": "最重要臨床發現摘要（英文）或 null",
  "assessment_complete": true 或 false,
  "ottawa_result": "negative/positive/untested",
  "special_tests": ["Empty Can Test: positive", "Ottawa Ankle Rules: negative"],
  "neuro_intact": true/false/null,
  "red_flags": ["head_trauma_vomiting", "unable_to_weight_bear", "bone_exposure", "neuro_deficit"]
}"""

# ── Context cache ───────────────────────────────────────────────────────────
_cache_name:   str | None = None
_cache_expire: float      = 0.0


def _get_cache() -> str | None:
    """Return cached content name, recreating when close to expiry.
    Returns None if caching is unavailable so callers can fall back gracefully.
    """
    global _cache_name, _cache_expire
    now = time.time()
    if _cache_name and now < _cache_expire:
        return _cache_name
    try:
        cache = _client.caches.create(
            model=CONV_MODEL,
            config=types.CreateCachedContentConfig(
                system_instruction=_CONV_SYSTEM,
                ttl=CACHE_TTL,
            ),
        )
        _cache_name   = cache.name
        _cache_expire = now + 3500  # refresh 100s before actual expiry
        return _cache_name
    except Exception:
        return None


# ── Response text extraction (handles thinking model) ──────────────────────
def _extract_text(resp) -> str:
    if resp.text:
        return resp.text.strip()
    for cand in (resp.candidates or []):
        for part in (getattr(getattr(cand, "content", None), "parts", None) or []):
            if getattr(part, "text", None):
                return part.text.strip()
    raise ValueError("Empty response from model")


# ── Public interface ────────────────────────────────────────────────────────
def chat(history: list, user_message: str) -> tuple[str, dict]:
    contents = [
        types.Content(
            role="user" if m["role"] == "user" else "model",
            parts=[types.Part(text=m["parts"][0])],
        )
        for m in history
    ]
    contents.append(types.Content(role="user", parts=[types.Part(text=user_message)]))

    # ── 1. Conversation: 2.5 Pro with cached system prompt ──────────────────
    cache_name = _get_cache()
    conv_config = types.GenerateContentConfig(
        max_output_tokens=1500,
        temperature=0.5,
        thinking_config=types.ThinkingConfig(thinking_budget=512),
        **({"cached_content": cache_name} if cache_name else {"system_instruction": _CONV_SYSTEM}),
    )
    try:
        resp  = _client.models.generate_content(model=CONV_MODEL, config=conv_config, contents=contents)
        reply = _extract_text(resp)
    except Exception as e:
        msg = str(e)
        if "429" in msg or "RESOURCE_EXHAUSTED" in msg:
            raise HTTPException(status_code=503, detail="AI 服務繁忙，請稍後再試。")
        raise HTTPException(status_code=500, detail=f"AI 服務發生錯誤：{msg}")

    # ── 2. JSON extraction: 2.5 Flash ───────────────────────────────────────
    ctx_lines = []
    for m in history[-6:]:
        ctx_lines.append(f"{'Patient' if m['role'] == 'user' else 'AI'}: {m['parts'][0]}")
    ctx_lines += [f"Patient: {user_message}", f"AI: {reply}"]

    data = {}
    try:
        json_resp = _client.models.generate_content(
            model=JSON_MODEL,
            config=types.GenerateContentConfig(
                system_instruction=_JSON_SYSTEM,
                response_mime_type="application/json",
                temperature=0.1,
                max_output_tokens=300,
            ),
            contents=[types.Content(role="user", parts=[types.Part(text="\n".join(ctx_lines))])],
        )
        data = json.loads(_extract_text(json_resp))
    except Exception:
        pass  # non-fatal: SOAP card updates on next successful turn

    return reply, data
