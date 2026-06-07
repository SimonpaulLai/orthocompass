#!/usr/bin/env python3
"""
OrthoCompass 對話測試
對話: Gemini 2.5 Pro  |  JSON 萃取: Gemini 2.5 Flash

用法:
  python test_chat.py                          # 純對話
  python test_chat.py --show-json             # 顯示每輪結構化資料
  python test_chat.py --model gemini-2.0-pro-exp  # 換對話模型
"""
import os, sys, json, argparse
from pathlib import Path

from dotenv import load_dotenv
load_dotenv(Path(__file__).parent / ".env")

from google import genai
from google.genai import types

sys.path.insert(0, str(Path(__file__).parent))
from prompts import SYSTEM_PROMPT

# ── Models ─────────────────────────────────────────────────────────────────
CONV_MODEL = "gemini-2.5-pro"       # 對話推理
JSON_MODEL = "gemini-2.5-flash"     # 結構化萃取

# 對話模型只需要說話，不輸出 JSON
_split = SYSTEM_PROMPT.split("## 輸出格式")
CONV_SYSTEM = _split[0].rstrip() + "\n\n只用自然語言回覆，不要輸出任何 JSON 或 code block。"

JSON_SYSTEM = """你是結構化資料萃取器。根據對話內容回傳評估 JSON。

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

client = genai.Client(api_key=os.environ["GEMINI_API_KEY"])


def _extract_text(resp, debug: bool = False) -> str:
    """resp.text 在 thinking model 下可能是 None，從 parts 直接取。"""
    if debug:
        print(f"\n{DIM}[DEBUG raw resp]{RESET}\n{resp}\n")

    if resp.text:
        return resp.text.strip()

    for cand in (resp.candidates or []):
        parts = getattr(getattr(cand, "content", None), "parts", None) or []
        for part in parts:
            text = getattr(part, "text", None)
            if text:
                return text.strip()

    raise ValueError(
        "空回應 — 可能是模型名稱錯誤或 API key 無權限。"
        f"\n  candidates={resp.candidates}"
        f"\n  加 --debug 查看完整回應"
    )


# ── ANSI colors ─────────────────────────────────────────────────────────────
CYAN  = "\033[36m"
DIM   = "\033[2m"
BOLD  = "\033[1m"
RESET = "\033[0m"


def call_conv(model: str, history: list, user_msg: str, debug: bool = False) -> str:
    contents = [
        types.Content(
            role="user" if m["role"] == "user" else "model",
            parts=[types.Part(text=m["parts"][0])]
        )
        for m in history
    ]
    contents.append(types.Content(role="user", parts=[types.Part(text=user_msg)]))

    resp = client.models.generate_content(
        model=model,
        config=types.GenerateContentConfig(
            system_instruction=CONV_SYSTEM,
            max_output_tokens=1500,
            temperature=0.5,
            thinking_config=types.ThinkingConfig(thinking_budget=512),
        ),
        contents=contents,
    )
    return _extract_text(resp, debug=debug)


def call_json(history: list, user_msg: str, reply: str) -> dict:
    lines = []
    for m in history[-6:]:
        role = "Patient" if m["role"] == "user" else "AI"
        lines.append(f"{role}: {m['parts'][0]}")
    lines.append(f"Patient: {user_msg}")
    lines.append(f"AI: {reply}")

    resp = client.models.generate_content(
        model=JSON_MODEL,
        config=types.GenerateContentConfig(
            system_instruction=JSON_SYSTEM,
            response_mime_type="application/json",
            temperature=0.1,
            max_output_tokens=300,
        ),
        contents=[types.Content(role="user", parts=[types.Part(text="\n".join(lines))])],
    )
    return json.loads(_extract_text(resp))


def main():
    parser = argparse.ArgumentParser(description="OrthoCompass 對話測試")
    parser.add_argument("--show-json", action="store_true", help="顯示每輪 JSON 萃取結果")
    parser.add_argument("--model", default=CONV_MODEL, help=f"對話模型 ID（預設: {CONV_MODEL}）")
    parser.add_argument("--debug", action="store_true", help="印出原始 API 回應")
    args = parser.parse_args()

    history = []

    print(f"\n{BOLD}OrthoCompass 對話測試{RESET}")
    print(f"{DIM}對話模型: {args.model}{RESET}")
    if args.show_json:
        print(f"{DIM}JSON 模型: {JSON_MODEL}{RESET}")
    print(f"{DIM}輸入 q 結束 | 加 --show-json 顯示結構化資料{RESET}")
    print("─" * 50)

    while True:
        try:
            user_input = input(f"\n{BOLD}你:{RESET} ").strip()
        except (KeyboardInterrupt, EOFError):
            print(f"\n{DIM}對話結束。{RESET}")
            break

        if user_input.lower() in ("q", "quit", "exit"):
            break
        if not user_input:
            continue

        try:
            reply = call_conv(args.model, history, user_input, debug=args.debug)
        except Exception as e:
            print(f"\n[對話錯誤] {e}")
            continue

        print(f"\n{CYAN}AI:{RESET} {reply}")

        history.append({"role": "user",  "parts": [user_input]})
        history.append({"role": "model", "parts": [reply]})

        if args.show_json:
            try:
                data = call_json(history[:-2], user_input, reply)
                pretty = json.dumps(data, ensure_ascii=False, indent=2)
                print(f"\n{DIM}[JSON]{RESET}")
                for line in pretty.splitlines():
                    print(f"  {DIM}{line}{RESET}")
            except Exception as e:
                print(f"\n{DIM}[JSON 萃取失敗] {e}{RESET}")


if __name__ == "__main__":
    main()
