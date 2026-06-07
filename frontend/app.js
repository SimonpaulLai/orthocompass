let sessionId;
try {
  sessionId = crypto.randomUUID();
} catch (_) {
  sessionId = Math.random().toString(36).slice(2) + Date.now().toString(36);
}

let isSending = false;
let fhirData  = null;

// ── Frontend Demo Constants ────────────────────────

const SEV_LABELS_FE = {
  1: ["沒事",    "繼續觀察即可，若有不適再就醫。"],
  2: ["小傷自理", "建議冰敷、清潔傷口，至藥局購買所需用品。"],
  3: ["建議就醫", "建議 48 小時內至骨科或診所確認。"],
  4: ["需要就醫", "建議今天前往急診，如有可能請人陪同。"],
  5: ["緊急送醫", "請立即聯絡 119 或請旁人協助送醫。"],
};

const DEMO_R1 = {
  '扭傷拉傷': {
    reply: "扭傷拉傷，先定位一下——是腳踝、膝蓋，還是手腕和肩膀的位置？\n\n患部現在有多痛？",
    data: { body_site: "Ankle / knee sprain", mechanism: "Ligamentous sprain from inversion or twisting", severity: 2 },
  },
  '撞傷跌倒': {
    reply: "撞跌倒，受傷的部位有沒有馬上腫起來或瘀青？\n\n最痛的地方在哪裡，大概有多痛？",
    data: { body_site: "Contusion from fall / blunt impact", mechanism: "Fall or blunt force trauma to extremity", severity: 2 },
  },
  '運動傷害': {
    reply: "運動傷害，先確認一下——是突然一個動作拉到，還是碰撞衝擊後才開始痛？\n\n患部現在有多痛？",
    data: { body_site: "Muscular strain / sports injury", mechanism: "Sports-related muscle or joint injury", severity: 2 },
  },
};

// Rounds 2–5（index 1–4 對應 _demoTurn 1–4 後要顯示的選項）
const DEMO_ROUNDS = [
  null, // index 0 佔位（不用）
  // index 1：第二輪問答（疼痛強度）
  {
    options: [
      { label: "非常痛，不敢動", sub: "動一下就更痛",    text: "非常痛，不太敢動它" },
      { label: "有點痛，還行",   sub: "在忍受範圍內",     text: "有點痛，還在忍受範圍內" },
      { label: "腫起來了",       sub: "有明顯腫脹或瘀青", text: "患部腫起來了，有些瘀青" },
    ],
    dataMap: [
      { pain_score: 8 },
      { pain_score: 5 },
      { pain_score: 6 },
    ],
    reply: "了解。試著輕輕按壓患部——有沒有某個特定的點，一碰就特別刺痛，還是整個區域都不舒服、沒有明顯痛點？",
  },
  // index 2：第三輪（功能測試 / 承重）
  {
    options: [
      { label: "可以勉強走/用",   sub: "跛著或撐著還能用",  text: "可以勉強走或活動，但很痛" },
      { label: "完全沒辦法承重", sub: "根本踩不下去",       text: "完全沒辦法承重，無法走路" },
      { label: "有腫但撐得住",   sub: "腫了但還能移動",     text: "有腫脹但勉強還能活動" },
    ],
    dataMap: [
      { weight_bearing: "partial" },
      { weight_bearing: "none"    },
      { weight_bearing: "partial" },
    ],
    reply: "好。問一個關鍵問題：受傷當下，有沒有聽到什麼聲音——啪、喀、或清脆的一聲？就算很輕微也算。",
  },
  // index 3：第四輪（臨床細節）
  {
    options: [
      { label: "有聽到聲音",   sub: "啪 / 喀 的一聲",   text: "有，聽到一聲啪或喀" },
      { label: "沒有特殊聲音", sub: "只是痛，沒有聲音", text: "沒有特別的聲音" },
      { label: "有特定壓痛點", sub: "按壓某點特別痛",   text: "有一個點按下去特別痛" },
    ],
    dataMap: [
      { key_finding: "Audible pop at time of injury — possible ligament involvement" },
      { key_finding: "No audible pop; diffuse tenderness without focal point"        },
      { key_finding: "Localised point tenderness on palpation"                       },
    ],
    reply: "快到尾聲了，最後一個確認——這個部位以前有沒有受過傷的記錄？",
  },
  // index 4：第五輪（最終確認）
  {
    options: [
      { label: "今天剛受傷",   sub: "第一次，沒有舊傷",   text: "今天剛發生的，沒有舊傷" },
      { label: "舊傷再度受傷", sub: "同部位之前受過傷",   text: "這個部位之前受傷過" },
      { label: "比剛才好一點", sub: "稍微有在改善",       text: "比剛受傷時好一點了" },
    ],
    dataMap: [
      { priorInjury: false, improving: false },
      { priorInjury: true,  improving: false },
      { priorInjury: false, improving: true  },
    ],
    isFinal: true,
  },
];

// Demo session state（由 clearSession 重置）
let _demoTurn     = 0;
let _demoData     = {};
let _demoEvidence = {};

// ── Page navigation ───────────────────────────────

function show(id) {
  document.querySelectorAll(".page").forEach(p => p.classList.remove("active"));
  const target = document.getElementById(id);
  if (target) target.classList.add("active");
}

function startAssessment() {
  show("main-app");
  // Reset scroll to chat panel (left)
  const body = document.querySelector("#main-app .app-body");
  if (body) body.scrollLeft = 0;
  updateTabIndicator(0);

  appendBubble("ai", "說說看——發生什麼事了？");
  showQuickLayer(1);
}

function goEmergency() {
  const reasonEl = document.getElementById("emg-reason");
  if (reasonEl) reasonEl.style.display = "none";
  const step2 = document.getElementById("emg-step2-text");
  if (step2) step2.textContent = "有出血 → 用乾淨布料用力持續壓住，不要放開";
  show("emergency-page");
}

function goBack() {
  show("gateway");
  clearSession();
}

function switchTab(tab) {
  if (window.innerWidth >= 768) return;
  const body = document.querySelector("#main-app .app-body");
  if (!body) return;

  if (tab === "summary") {
    body.scrollTo({ left: body.offsetWidth, behavior: "smooth" });
    const dot = document.getElementById("summary-dot");
    if (dot) dot.style.display = "none";
  } else {
    body.scrollTo({ left: 0, behavior: "smooth" });
    setTimeout(() => document.getElementById("user-input")?.focus(), 320);
  }
}

// ── Swipe sync ─────────────────────────────────────

function updateTabIndicator(progress) {
  const indicator = document.getElementById("tab-indicator");
  const chatBtn   = document.querySelector(".tab-btn[data-tab='chat']");
  const summBtn   = document.querySelector(".tab-btn[data-tab='summary']");

  if (indicator) {
    const tabBar = document.querySelector(".tab-bar");
    const halfW  = tabBar ? tabBar.offsetWidth / 2 : 0;
    indicator.style.transform = `translateX(${Math.max(0, progress) * halfW}px)`;
  }
  if (chatBtn) chatBtn.classList.toggle("active", progress < 0.5);
  if (summBtn) summBtn.classList.toggle("active", progress >= 0.5);
}

function initSwipe() {
  const body = document.querySelector("#main-app .app-body");
  if (!body) return;

  body.addEventListener("scroll", () => {
    if (window.innerWidth >= 768) return;
    const progress = body.scrollLeft / (body.offsetWidth || 1);
    updateTabIndicator(progress);

    // Auto-hide dot when user scrolls to summary
    if (progress >= 0.45) {
      const dot = document.getElementById("summary-dot");
      if (dot) dot.style.display = "none";
    }
  }, { passive: true });
}

// ── Message send ──────────────────────────────────

async function sendMessage(overrideText) {
  if (isSending) return;
  const input = document.getElementById("user-input");
  const text  = overrideText || input.value.trim();
  if (!text) return;

  isSending = true;
  const userRow = appendBubble("user", text);
  input.value  = "";
  hideQuickButtons();

  const typingRow    = appendBubble("ai", "...");
  const typingBubble = typingRow.querySelector(".bubble");

  try {
    const isMock = new URLSearchParams(window.location.search).get("mock") === "true";

    // ── Frontend demo mode (no backend call) ──────
    if (isMock) {
      await new Promise(r => setTimeout(r, 650 + Math.random() * 450));
      const result = processDemoTurn(text);
      typingBubble.innerHTML = "";
      result.reply.split("\n").forEach((line, i) => {
        if (i > 0) typingBubble.appendChild(document.createElement("br"));
        typingBubble.appendChild(document.createTextNode(line));
      });
      if (result.turn) { userRow.dataset.turn = result.turn; typingRow.dataset.turn = result.turn; }
      updateSummaryCard(result.summary);
      if (result.fhir) { fhirData = result.fhir; showFhirSection(result.fhir); }
      if (result.summary?.severity === 5) {
        showAlertBanner(); showEmergencyAction(result.summary);
      } else if (!result.summary?.assessment_complete) {
        showDemoOptions();
      }
      return;
    }

    // ── Real API ───────────────────────────────────
    const res = await fetch(`${CONFIG.BACKEND_URL}/chat`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ session_id: sessionId, message: text }),
    });

    if (res.status === 429) {
      typingBubble.innerHTML = "";
      typingBubble.textContent = "問診已達上限，請整理摘要後前往就醫。";
      return;
    }

    const data = await res.json();
    typingBubble.innerHTML = "";

    if (data.error) { typingBubble.textContent = data.error; return; }

    data.reply.split("\n").forEach((line, i) => {
      if (i > 0) typingBubble.appendChild(document.createElement("br"));
      typingBubble.appendChild(document.createTextNode(line));
    });

    if (data.turn) {
      userRow.dataset.turn   = data.turn;
      typingRow.dataset.turn = data.turn;
    }

    updateSummaryCard(data.summary);

    if (data.fhir) {
      fhirData = data.fhir;
      showFhirSection(data.fhir);
    }

    if (data.summary?.severity === 5) {
      showAlertBanner();
      showEmergencyAction(data.summary);
    } else if (!data.summary?.assessment_complete) {
      showQuickLayer(2);
    }

  } catch (_) {
    typingBubble.innerHTML  = "";
    typingBubble.textContent = "連線失敗，請確認網路後再試。";
  } finally {
    isSending = false;
  }
}

function quickSelect(text) { sendMessage(text); }

// ── Chat bubbles ──────────────────────────────────

// Returns the row element (msg-row) so callers can tag data-turn on it
function appendBubble(role, text) {
  const area = document.getElementById("chat-messages");
  const row  = document.createElement("div");
  row.className = `msg-row ${role}`;

  if (role === "ai") {
    const dot = document.createElement("div");
    dot.className = "ai-dot";
    row.appendChild(dot);
  }

  const bubble = document.createElement("div");
  bubble.className = `bubble ${role}`;

  if (text === "...") {
    bubble.innerHTML = '<div class="typing-dots"><span></span><span></span><span></span></div>';
  } else {
    bubble.textContent = text;
  }

  row.appendChild(bubble);
  area.appendChild(row);
  requestAnimationFrame(() => { area.scrollTop = area.scrollHeight; });
  return row;
}

// ── Jump to turn (evidence click) ─────────────────

function jumpToTurn(n) {
  // Jump to the user's row for that turn (first row with this turn)
  const target = document.querySelector(`.msg-row.user[data-turn="${n}"]`)
               || document.querySelector(`.msg-row[data-turn="${n}"]`);
  if (!target) return;
  target.scrollIntoView({ behavior: "smooth", block: "center" });
  target.classList.remove("highlight-flash");
  void target.offsetWidth; // force reflow to restart animation
  target.classList.add("highlight-flash");
  setTimeout(() => target.classList.remove("highlight-flash"), 2300);
}

// ── UI helpers ────────────────────────────────────

function updateTurnCounter() {} // kept as no-op; counter is hidden

function showAlertBanner() {
  document.getElementById("alert-banner").style.display = "block";
}

function hideQuickButtons() {
  document.getElementById("quick-buttons").style.display = "none";
}

function showQuickLayer(layer) {
  const qb    = document.getElementById("quick-buttons");
  qb.style.display = "";
  const l1    = document.getElementById("quick-layer-1");
  const l2    = document.getElementById("quick-layer-2");
  const lDemo = document.getElementById("quick-layer-demo");
  if (lDemo) { lDemo.innerHTML = ""; lDemo.style.display = "none"; }
  if (layer === 1) { l1.style.display = ""; l2.style.display = "none"; }
  else             { l1.style.display = "none"; l2.style.display = ""; }
}

// ── SOAP summary card ─────────────────────────────

const WB_LABEL = { full: "可完全承重", partial: "可部分承重", none: "無法承重" };
const SEV_COLOR = { 1: "sev-1", 2: "sev-2", 3: "sev-3", 4: "sev-4", 5: "sev-5" };

function evChip(evidence, field) {
  const e = evidence?.[field];
  if (!e) return "";
  const q = (e.quote || "").replace(/"/g, "&quot;");
  return `<button class="ev-chip" onclick="jumpToTurn(${e.turn})" title="${q}">第${e.turn}輪 ↗</button>`;
}

function soapRow(label, value, chipHtml) {
  if (!value) return "";
  return `<div class="soap-row">
    <span class="soap-field">${label}</span>
    <span class="soap-val">${value}</span>
    ${chipHtml || ""}
  </div>`;
}

function updateSummaryCard(summary) {
  if (!summary) return;
  const card = document.getElementById("summary-card");
  const ev   = summary.evidence || {};

  const sections = [];

  // 主訴
  if (summary.mechanism) {
    sections.push(`
      <div class="soap-section">
        <div class="soap-label">主訴</div>
        <div class="soap-row">
          <span class="soap-val">${summary.mechanism}</span>
          ${evChip(ev, "mechanism")}
        </div>
      </div>`);
  }

  // 自述症狀
  const subjRows = [
    soapRow("受傷部位", summary.body_site,  evChip(ev, "body_site")),
    soapRow("疼痛程度", summary.pain_score != null ? `${summary.pain_score} / 10` : null, evChip(ev, "pain_score")),
    soapRow("承重狀況", WB_LABEL[summary.weight_bearing] || null, evChip(ev, "weight_bearing")),
  ].filter(Boolean).join("");

  if (subjRows) {
    sections.push(`
      <div class="soap-section">
        <div class="soap-label">自述症狀</div>
        ${subjRows}
      </div>`);
  }

  // 評估
  const sevClass = SEV_COLOR[summary.severity] || "";
  const assessRows = [
    soapRow("關鍵發現", summary.key_finding, evChip(ev, "key_finding")),
    summary.severity ? `<div class="soap-row">
      <span class="soap-field">嚴重度</span>
      <span class="soap-val ${sevClass}">Level ${summary.severity} — ${summary.severity_label || ""}</span>
    </div>` : "",
  ].filter(Boolean).join("");

  if (assessRows) {
    sections.push(`
      <div class="soap-section">
        <div class="soap-label">評估</div>
        ${assessRows}
      </div>`);
  }

  // 建議
  if (summary.advice) {
    sections.push(`
      <div class="soap-section">
        <div class="soap-label">建議</div>
        <div class="advice-box">${summary.advice}</div>
      </div>`);
  }

  card.innerHTML = sections.length
    ? sections.join("")
    : '<div class="summary-placeholder"><div class="pulse-dot"></div>評估進行中</div>';

  // Progressive FHIR: show as soon as we have meaningful data (don't wait for assessment_complete)
  if (!fhirData && (summary.body_site || summary.mechanism)) {
    const preview = buildFhirFromSummary(summary);
    if (preview) showFhirSection(preview);
  }

  // Show red dot on summary tab if user is viewing chat panel (mobile)
  if (sections.length && window.innerWidth < 768) {
    const body = document.querySelector("#main-app .app-body");
    const onChat = !body || body.scrollLeft < body.offsetWidth * 0.5;
    if (onChat) {
      const dot = document.getElementById("summary-dot");
      if (dot) dot.style.display = "block";
    }
  }
}

// ── FHIR preview from summary data ───────────────

function buildFhirFromSummary(s) {
  if (!s || (!s.body_site && !s.mechanism)) return null;
  const now = new Date().toISOString();
  const condition = {
    resourceType: "Condition",
    clinicalStatus: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/condition-clinical", code: "active" }] },
    verificationStatus: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/condition-ver-status", code: "unconfirmed" }] },
    recordedDate: now,
  };
  if (s.body_site)   condition.bodySite = [{ text: s.body_site }];
  if (s.key_finding) condition.note     = [{ text: s.key_finding }];

  const components = [];
  if (s.pain_score != null)
    components.push({ code: { text: "Pain Score (NRS)" }, valueInteger: s.pain_score });
  if (s.weight_bearing && s.weight_bearing !== "unknown")
    components.push({ code: { text: "Weight Bearing" }, valueString: s.weight_bearing.charAt(0).toUpperCase() + s.weight_bearing.slice(1) });
  if (s.mechanism)
    components.push({ code: { text: "Mechanism of Injury" }, valueString: s.mechanism });
  if (s.key_finding)
    components.push({ code: { text: "Key Finding" }, valueString: s.key_finding });

  return {
    resourceType: "Bundle", type: "collection", timestamp: now,
    entry: [
      { resource: condition },
      { resource: {
        resourceType: "Observation",
        status: s.assessment_complete ? "final" : "preliminary",
        code: { text: "Musculoskeletal Triage Assessment" },
        effectiveDateTime: now,
        component: components,
      }},
    ],
  };
}

// ── FHIR section ──────────────────────────────────

function showFhirSection(fhir) {
  const sec = document.getElementById("fhir-section");
  sec.style.display = "block";
  document.getElementById("fhir-json").textContent = JSON.stringify(fhir, null, 2);
}

function toggleFhir() {
  const content  = document.getElementById("fhir-content");
  const icon     = document.getElementById("fhir-toggle-icon");
  const isHidden = content.style.display !== "block";
  content.style.display = isHidden ? "block" : "none";
  icon.textContent       = isHidden ? "▲" : "▼";
}

function copyFhir() {
  if (!fhirData) return;
  navigator.clipboard.writeText(JSON.stringify(fhirData, null, 2));
  const btn = event.target;
  btn.textContent = "已複製 ✓";
  setTimeout(() => btn.textContent = "複製 JSON", 2000);
}

// ── Session cleanup ───────────────────────────────

async function clearSession() {
  try {
    await fetch(`${CONFIG.BACKEND_URL}/session/${sessionId}`, { method: "DELETE" });
  } catch (_) {}

  // Reset scroll to chat panel
  const body = document.querySelector("#main-app .app-body");
  if (body) body.scrollLeft = 0;
  updateTabIndicator(0);
  const dot = document.getElementById("summary-dot");
  if (dot) dot.style.display = "none";

  document.getElementById("chat-messages").innerHTML = "";
  document.getElementById("summary-card").innerHTML =
    '<div class="summary-placeholder"><div class="pulse-dot"></div>評估進行中</div>';
  document.getElementById("fhir-section").style.display   = "none";
  document.getElementById("fhir-content").style.display   = "none";
  document.getElementById("alert-banner").style.display   = "none";
  document.getElementById("turn-counter").textContent      = "";
  document.getElementById("quick-buttons").style.display  = "";
  showQuickLayer(1);
  fhirData = null;

  // Reset demo state
  _demoTurn     = 0;
  _demoData     = {};
  _demoEvidence = {};
  _emergencySummary = null;
}

// ── Demo Mode Logic ───────────────────────────────

function processDemoTurn(text) {
  _demoTurn++;

  // ── Round 1: identify injury category ──
  if (_demoTurn === 1) {
    const r1Key = Object.keys(DEMO_R1).find(k => text === k) || Object.keys(DEMO_R1)[0];
    const r1    = DEMO_R1[r1Key] || DEMO_R1['扭到或拉傷，肌肉關節疼痛'];
    _demoData   = { ...r1.data, pain_score: null, weight_bearing: "unknown", key_finding: null, assessment_complete: false };
    _demoEvidence.mechanism = { turn: 1, quote: text.slice(0, 80) };
    return { reply: r1.reply, summary: buildDemoSummary(), fhir: null, turn: _demoTurn };
  }

  // ── Rounds 2–5: apply dataMap by option index ──
  const roundDef = DEMO_ROUNDS[_demoTurn - 1];
  if (!roundDef) {
    return { reply: "好的，謝謝你告訴我。", summary: buildDemoSummary(), fhir: null, turn: _demoTurn };
  }

  const optIdx = roundDef.options.findIndex(o => o.text === text);
  const idx    = optIdx >= 0 ? optIdx : 0;
  const extra  = roundDef.dataMap[idx];

  if (!roundDef.isFinal) {
    // Merge standard fields into _demoData
    Object.assign(_demoData, extra);
    const changedKey = Object.keys(extra)[0];
    if (changedKey) _demoEvidence[changedKey] = { turn: _demoTurn, quote: text.slice(0, 80) };
    _demoData.severity = computeDemoSeverity(_demoData, false);

    return { reply: roundDef.reply, summary: buildDemoSummary(), fhir: null, turn: _demoTurn };
  }

  // ── Final round ──
  if (extra.priorInjury) {
    _demoData.key_finding = (_demoData.key_finding
      ? _demoData.key_finding + "; prior injury at same site"
      : "Prior injury at same site");
    _demoEvidence.key_finding = { turn: _demoTurn, quote: text.slice(0, 80) };
  }
  _demoData.severity           = computeDemoSeverity(_demoData, extra.improving);
  _demoData.assessment_complete = true;

  const finalReply = buildDemoFinalReply(_demoData, extra);
  const fhir       = buildDemoFhir(_demoData);

  return { reply: finalReply, summary: buildDemoSummary(), fhir, turn: _demoTurn };
}

function computeDemoSeverity(data, improving) {
  const wb      = data.weight_bearing;
  const pain    = data.pain_score ?? 5;
  const finding = (data.key_finding || "").toLowerCase();
  const hasSound = finding.includes("pop");

  let sev;
  if      (wb === "none" && pain >= 8)        sev = 4;
  else if (wb === "none")                     sev = 3;
  else if (pain >= 8 && hasSound)             sev = 4;
  else if (pain >= 7)                         sev = 3;
  else if (wb === "partial" && pain >= 6)     sev = 3;
  else                                        sev = 2;

  if (improving && sev > 1 && wb !== 'none') sev = Math.max(sev - 1, 1);
  return sev;
}

function buildDemoFinalReply(data, extra) {
  const wb    = data.weight_bearing;
  const pain  = data.pain_score ?? 5;
  const finding = (data.key_finding || "").toLowerCase();
  const sev   = data.severity;

  const parts = [];
  if (wb === "none")                     parts.push("完全無法承重");
  if (wb === "partial")                  parts.push("可以部分承重");
  if (pain >= 8)                         parts.push(`疼痛強烈（${pain} 分）`);
  if (pain <= 5)                         parts.push(`疼痛可忍受（${pain} 分）`);
  if (finding.includes("pop"))           parts.push("受傷時有聽到聲音");
  if (finding.includes("tenderness"))    parts.push("有局部壓痛點");
  if (extra?.priorInjury)                parts.push("同部位有舊傷史");
  if (extra?.improving)                  parts.push("症狀已稍有改善");

  const intro = parts.length
    ? '根據你說的這些——' + parts.join('、') + '——'
    : '根據你描述的狀況——';

  // 根據 body_site 推導傷勢描述
  const site = (data.body_site || '').toLowerCase();
  const injuryType =
    site.includes('sprain') || site.includes('ligament') ? '軟組織扭傷' :
    site.includes('contusion') || site.includes('fall')  ? '挫傷'       :
    site.includes('strain')  || site.includes('sports')  ? '肌肉拉傷'   : '軟組織受傷';

  let assessment, action;
  if (sev >= 4) {
    assessment = '這個組合需要今天去急診確認，不建議等到明天。';
    action     = '如果可以請人陪你過去，告訴急診室：外傷、' + (wb === 'none' ? '無法承重' : '部分承重') + '。';
  } else if (sev === 3) {
    assessment = '比較像是' + injuryType + '，骨折可能性相對低，但 48 小時內去骨科或診所確認比較安心。';
    action     = '先 RICE：冰敷（每次 15 分鐘，一小時內 2–3 次）、休息、輕微加壓、抬高患部。';
  } else {
    assessment = '看起來是輕度' + injuryType + '，結構性損傷的可能性低。';
    action     = 'RICE 處理，觀察 24–48 小時。若出現大範圍瘀青或疼痛加劇，再去看醫生。';
  }

  return `${intro}${assessment}\n\n${action}`;
}

function buildDemoSummary() {
  const sev  = _demoData.severity || 1;
  const [label, advice] = SEV_LABELS_FE[sev] || ["評估中", ""];
  return {
    body_site:           _demoData.body_site          || null,
    pain_score:          _demoData.pain_score          ?? null,
    weight_bearing:      _demoData.weight_bearing      || "unknown",
    mechanism:           _demoData.mechanism           || null,
    key_finding:         _demoData.key_finding         || null,
    severity:            sev,
    severity_label:      label,
    advice:              advice,
    assessment_complete: _demoData.assessment_complete || false,
    evidence:            _demoEvidence,
  };
}

function buildDemoFhir(data) {
  const now = new Date().toISOString();

  const condition = {
    resourceType: "Condition",
    clinicalStatus: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/condition-clinical", code: "active" }] },
    verificationStatus: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/condition-ver-status", code: "unconfirmed" }] },
    recordedDate: now,
  };
  if (data.body_site)   condition.bodySite = [{ text: data.body_site }];
  if (data.key_finding) condition.note     = [{ text: data.key_finding }];

  const components = [];
  if (data.pain_score != null)
    components.push({ code: { text: "Pain Score (NRS)" }, valueInteger: data.pain_score });
  if (data.weight_bearing && data.weight_bearing !== "unknown")
    components.push({ code: { text: "Weight Bearing" }, valueString: data.weight_bearing.charAt(0).toUpperCase() + data.weight_bearing.slice(1) });
  if (data.mechanism)
    components.push({ code: { text: "Mechanism of Injury" }, valueString: data.mechanism });
  if (data.key_finding)
    components.push({ code: { text: "Key Finding" }, valueString: data.key_finding });

  return {
    resourceType: "Bundle",
    type:         "collection",
    timestamp:    now,
    entry: [
      { resource: condition },
      { resource: {
        resourceType: "Observation",
        status:           data.assessment_complete ? "final" : "preliminary",
        code:             { text: "Musculoskeletal Triage Assessment" },
        effectiveDateTime: now,
        component:        components,
      }},
    ],
  };
}

function showDemoOptions() {
  const roundDef = DEMO_ROUNDS[_demoTurn]; // 顯示「下一輪」的選項
  if (!roundDef) return;

  const l1    = document.getElementById("quick-layer-1");
  const l2    = document.getElementById("quick-layer-2");
  const lDemo = document.getElementById("quick-layer-demo");
  if (!lDemo) return;

  if (l1) l1.style.display = "none";
  if (l2) l2.style.display = "none";

  lDemo.innerHTML = roundDef.options.map((opt, i) =>
    `<button class="qtile" onclick="quickSelect('${opt.text.replace(/'/g, "\\'")}')" data-idx="${i}">
      <div class="qtile-text">
        <span class="qtile-title">${opt.label}</span>
        <span class="qtile-sub">${opt.sub}</span>
      </div>
    </button>`
  ).join("");

  document.getElementById("quick-buttons").style.display = "";
  lDemo.style.display = "";
}

// ── Emergency context ─────────────────────────────

let _emergencySummary = null;

function showEmergencyAction(summary) {
  _emergencySummary = summary;
  const area = document.getElementById("chat-messages");
  const row  = document.createElement("div");
  row.className = "msg-row";
  row.innerHTML = `<div class="emg-action-card">
    <span class="emg-action-text">根據評估結果，建議立即撥打 119 求救</span>
    <button class="emg-action-btn" onclick="goEmergencyWithContext()">🚨 查看緊急指引 → 撥打 119</button>
  </div>`;
  area.appendChild(row);
  area.scrollTop = area.scrollHeight;
}

function goEmergencyWithContext() {
  const s = _emergencySummary;

  // 顯示 AI 評估原因
  const reasonEl   = document.getElementById("emg-reason");
  const reasonText = document.getElementById("emg-reason-text");
  if (s && (s.advice || s.key_finding)) {
    reasonEl.style.display = "block";
    reasonText.textContent  = s.advice
      || `評估發現：${s.key_finding}，建議立即叫救護車。`;
  } else if (reasonEl) {
    reasonEl.style.display = "none";
  }

  // 根據傷況客製化 Step 2
  const body    = (s?.body_site   || "").toLowerCase();
  const finding = (s?.key_finding || "").toLowerCase();
  const step2   = document.getElementById("emg-step2-text");
  if (step2) {
    if (finding.includes("出血")) {
      step2.textContent = "有出血 → 用乾淨布料用力持續壓住，不要放開";
    } else if (body.includes("頸") || finding.includes("頸")) {
      step2.textContent = "懷疑頸椎受傷 → 不要移動傷者頸部，保持現有姿勢等待救援";
    } else if (body.includes("頭") || finding.includes("頭")) {
      step2.textContent = "頭部受傷 → 讓傷者平躺，不要給飲水，持續觀察意識狀態";
    } else {
      step2.textContent = "不要移動傷肢，讓傷者保持舒適姿勢等待救援";
    }
  }

  show("emergency-page");
}

// ── DOM ready ─────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("user-input").addEventListener("keydown", e => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });

  const btnEmergency = document.querySelector(".triage-card.emergency");
  const btnAssess    = document.querySelector(".triage-card.assess");
  if (btnEmergency) btnEmergency.addEventListener("click", goEmergency);
  if (btnAssess)    btnAssess.addEventListener("click", startAssessment);

  initSwipe();
});
