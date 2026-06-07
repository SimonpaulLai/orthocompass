import os
from dotenv import load_dotenv
load_dotenv()

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, field_validator
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.util import get_remote_address
from slowapi.errors import RateLimitExceeded

import session as session_store
import gemini
import fhir
from prompts import MOCK_RESPONSES

limiter = Limiter(key_func=get_remote_address)
app = FastAPI()
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


class ChatRequest(BaseModel):
    session_id: str
    message: str
    mock: bool = False

    @field_validator("message")
    @classmethod
    def message_length(cls, v):
        if len(v) > 200:
            raise ValueError("訊息長度不可超過 200 字")
        return v


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/chat")
@limiter.limit("20/hour")
async def chat_endpoint(request: Request, body: ChatRequest):
    sid = body.session_id

    if session_store.is_over_limit(sid):
        return JSONResponse({"error": "問診已達上限，請整理摘要後前往就醫。"}, status_code=429)

    turn = session_store.get_turn(sid)

    if body.mock:
        idx = min(turn, len(MOCK_RESPONSES) - 1)
        mock = MOCK_RESPONSES[idx]
        session_store.append_turn(sid, body.message, mock["reply"], mock["data"])
        accumulated = session_store.get_assessment_data(sid)
        evidence    = session_store.get_evidence(sid)
        return {
            "reply":   mock["reply"],
            "summary": fhir.build_summary_card(accumulated, evidence),
            "fhir":    fhir.build_fhir_bundle(accumulated) if accumulated.get("assessment_complete") else None,
            "turn":    turn + 1,
        }

    history = session_store.get_history(sid)
    reply, data = gemini.chat(history, body.message)
    session_store.append_turn(sid, body.message, reply, data)

    accumulated = session_store.get_assessment_data(sid)
    evidence    = session_store.get_evidence(sid)

    return {
        "reply":   reply,
        "summary": fhir.build_summary_card(accumulated, evidence),
        "fhir":    fhir.build_fhir_bundle(accumulated) if accumulated.get("assessment_complete") else None,
        "turn":    turn + 1,
    }


@app.delete("/session/{session_id}")
async def clear_session(session_id: str):
    session_store.clear(session_id)
    return {"cleared": True}
