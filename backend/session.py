import time

SESSION_TTL = 1800  # 30 分鐘
MAX_TURNS = 10

_sessions: dict[str, dict] = {}


def get_or_create(session_id: str) -> dict:
    now = time.time()
    if session_id not in _sessions:
        _sessions[session_id] = {
            "history": [],
            "turn": 0,
            "last_active": now,
            "assessment_data": {},
            "evidence": {},          # {field: {turn: N, quote: "..."}}
        }
    else:
        _sessions[session_id]["last_active"] = now
    _cleanup_expired()
    return _sessions[session_id]


def append_turn(session_id: str, user_msg: str, assistant_msg: str, data: dict):
    session = get_or_create(session_id)
    next_turn = session["turn"] + 1

    session["history"].append({"role": "user", "parts": [user_msg]})
    session["history"].append({"role": "model", "parts": [assistant_msg]})
    session["turn"] = next_turn

    quote = user_msg[:120].strip()
    for key, value in data.items():
        if value is None or value == "" or value == "unknown":
            continue
        # Record evidence when a field appears or changes
        if session["assessment_data"].get(key) != value:
            session["evidence"][key] = {"turn": next_turn, "quote": quote}
        session["assessment_data"][key] = value


def get_history(session_id: str) -> list:
    return _sessions.get(session_id, {}).get("history", [])


def get_turn(session_id: str) -> int:
    return _sessions.get(session_id, {}).get("turn", 0)


def get_assessment_data(session_id: str) -> dict:
    return _sessions.get(session_id, {}).get("assessment_data", {})


def get_evidence(session_id: str) -> dict:
    return _sessions.get(session_id, {}).get("evidence", {})


def clear(session_id: str):
    _sessions.pop(session_id, None)


def is_over_limit(session_id: str) -> bool:
    return get_turn(session_id) >= MAX_TURNS


def _cleanup_expired():
    now = time.time()
    expired = [sid for sid, s in _sessions.items() if now - s["last_active"] > SESSION_TTL]
    for sid in expired:
        del _sessions[sid]
