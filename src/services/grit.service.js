// ===========================================================
// AUTO BRAIN — GRIT SERVICE (HYBRID v1)
// Code controls truth (gates/state). GPT controls language.
// ===========================================================

import { getOpenAI } from "./openai.service.js";
import { supabase } from "./supabase.service.js"; // kept for future use
import { GRIT_RULESET } from "../rules/grit.ruleset.js";

import {
  mergeVehicleContexts,
  inferEngineStringFromYMM
} from "../utils/vehicle.util.js";

import {
  checkSafetyHardStop,
  collectSafetyWarnings
} from "../utils/safety.util.js";

import { diagnosticState } from "../state/diagnostic.state.js";

/* ======================================================
   INTERNAL HELPERS
====================================================== */
function normalize(msg = "") {
  return String(msg || "").trim();
}

function vehicleIsComplete(v = {}) {
  return Boolean(v?.year && v?.make && v?.model && (v?.engine || v?.engineCode));
}

function resetDiagnosticSession() {
  diagnosticState.mode = "idle";
  diagnosticState.domain = null;
  diagnosticState.activePath = null;

  diagnosticState.activeDTCs = [];
  diagnosticState.primaryDTC = null;

  diagnosticState.codeExplained = false;
  diagnosticState.lastExplainedDTC = null;

  diagnosticState.awaitingResponse = false;
  diagnosticState.lastQuestion = null;

  // keep existing nested objects if you already use them
  diagnosticState.classification = diagnosticState.classification || {};
  diagnosticState.phase = null;
  diagnosticState.nextExpected = null;
}

/* ======================================================
   🔐 MULTI-DTC EXPLANATION HELPERS
====================================================== */
function getNextUnexplainedDTC(state) {
  if (!state.activeDTCs || !state.activeDTCs.length) return null;

  if (!state.lastExplainedDTC) return state.activeDTCs[0];

  const idx = state.activeDTCs.indexOf(state.lastExplainedDTC);
  return state.activeDTCs[idx + 1] || null;
}

function requiresDTCExplanation(state) {
  return Boolean(state.primaryDTC && state.codeExplained === false);
}

/* ======================================================
   DTC EXTRACTION
====================================================== */
function extractDTCs(message) {
  const m = normalize(message);
  const codes = Array.from(m.matchAll(/\b([PBUC]\d{4})\b/gi)).map((x) =>
    x[1].toUpperCase()
  );
  return [...new Set(codes)];
}

/* ======================================================
   DOMAIN DETECTION (READ-ONLY)
====================================================== */
const DOMAINS = {
  engine_drivability: "engine_drivability",
  starting_charging: "starting_charging",
  cooling: "cooling",
  evap: "evap",
  network: "network",
  brakes_abs: "brakes_abs",
  transmission: "transmission",
  hvac: "hvac",
  diesel_emissions: "diesel_emissions",
  steering_suspension: "steering_suspension",
  hybrid_ev: "hybrid_ev",
  body_electrical: "body_electrical",
  srs_airbag: "srs_airbag",
  tpms: "tpms",
  adas: "adas",
  unknown: "unknown"
};

function detectDomain({ message, dtcs }) {
  const m = normalize(message).toLowerCase();

  if (dtcs.some((c) => /^U\d{4}$/i.test(c))) return DOMAINS.network;
  if (dtcs.some((c) => /^C\d{4}$/i.test(c))) return DOMAINS.brakes_abs;
  if (dtcs.some((c) => /^B\d{4}$/i.test(c))) return DOMAINS.body_electrical;

  if (/(srs|airbag|clock spring)/i.test(m)) return DOMAINS.srs_airbag;
  if (/(hybrid|ev|high voltage|orange cable)/i.test(m)) return DOMAINS.hybrid_ev;
  if (/(evap|p04\d{2}|purge|vent)/i.test(m)) return DOMAINS.evap;
  if (/(overheat|running hot|temp gauge)/i.test(m)) return DOMAINS.cooling;
  if (/(no crank|no start|starter|battery light|alternator)/i.test(m))
    return DOMAINS.starting_charging;
  if (/(abs|traction|stabilitrak|brake)/i.test(m)) return DOMAINS.brakes_abs;
  if (/(transmission|slip|harsh shift|no movement)/i.test(m))
    return DOMAINS.transmission;
  if (/(hvac|no heat|no a\/c|blower)/i.test(m)) return DOMAINS.hvac;
  if (/(def|dpf|regen|soot|scr)/i.test(m)) return DOMAINS.diesel_emissions;
  if (/(death wobble|track bar|tie rod|wander|clunk)/i.test(m))
    return DOMAINS.steering_suspension;
  if (/(tpms|tire pressure)/i.test(m)) return DOMAINS.tpms;
  if (/(adas|lane keep|radar|camera)/i.test(m)) return DOMAINS.adas;

  if (dtcs.some((c) => /^P\d{4}$/i.test(c))) return DOMAINS.engine_drivability;
  if (/(misfire|rough idle|stall|smoke|lean)/i.test(m))
    return DOMAINS.engine_drivability;

  return DOMAINS.unknown;
}

/* ======================================================
   DETERMINISTIC FIRST-QUESTION INTENTS (CODE CHOOSES)
   GPT may phrase, but the intent is fixed.
====================================================== */
function getFirstDiagnosticIntent({ message, dtcs, domain }) {
  const m = normalize(message).toLowerCase();

  // priority: strong keyword triggers
  if (/no start/i.test(m)) return "classify_no_start";
  if (/overheat|running hot|temp gauge/i.test(m)) return "classify_overheat";

  if (
    /misfire|p030[0-8]/i.test(m) ||
    dtcs.some((c) => /^P030[0-8]$/i.test(c))
  ) {
    return "classify_misfire";
  }

  if (/p0171|p0174|lean/i.test(m)) return "classify_lean";

  if (/evap|p04\d{2}|purge|vent/i.test(m) || domain === DOMAINS.evap) {
    return "evap_initial_checks";
  }

  // fallback by domain
  switch (domain) {
    case DOMAINS.network:
      return "network_topology_freeze_frame";
    case DOMAINS.brakes_abs:
      return "abs_basics_speed_sensors";
    case DOMAINS.transmission:
      return "trans_basics_fluid_codes";
    case DOMAINS.hvac:
      return "hvac_basics_command_actual";
    case DOMAINS.diesel_emissions:
      return "diesel_emissions_basics_regen_data";
    default:
      return "general_kickoff";
  }
}

/* ======================================================
   GPT HELPERS (HYBRID: GPT LANGUAGE, CODE CONTROL)
====================================================== */
async function gptExplainDTC({ openai, code, mergedVehicle }) {
  const explanationPrompt = `
You are GRIT — a professional automotive diagnostic mentor speaking to an experienced technician.

Explain diagnostic trouble code ${code} briefly and clearly.

Constraints:
- Maximum 4 total sentences
- Technician-level language
- No headings, numbering, bullets, or formatting labels
- No repair instructions
- No testing steps
- No questions
`;

  const explanation = await openai.chat.completions.create({
    model: "gpt-4.1",
    temperature: 0.3,
    messages: [
      {
        role: "system",
        content: `${explanationPrompt}\n\nVehicle Context:\n${JSON.stringify(
          mergedVehicle
        )}`
      }
    ]
  });

  return normalize(explanation?.choices?.[0]?.message?.content || "");
}

async function gptAskOneQuestion({ openai, intent, mergedVehicle, domain, dtc, safetyWarnings }) {
  const prompt = `
You are GRIT — a master-level automotive diagnostic assistant.

Your job right now: ask ONE targeted diagnostic question (or ONE short yes/no check) that matches the diagnostic intent.

Context:
- Vehicle: ${JSON.stringify(mergedVehicle)}
- Domain: ${domain || "unknown"}
- Primary DTC: ${dtc || "none"}
- Diagnostic intent: ${intent}

Rules:
- Ask ONE question only (no lists of questions)
- Be concise and technician-focused
- Do not add explanations unless absolutely required for the question
- Do not provide repair instructions
- Do not add multiple steps
- If the intent is a classification intent, offer clear A/B style choices in the question
`;

  const ai = await openai.chat.completions.create({
    model: "gpt-4.1",
    temperature: 0.3,
    messages: [
      {
        role: "system",
        content: `${(safetyWarnings?.length ? safetyWarnings.join("\n") + "\n\n" : "")}${prompt}\n\n${GRIT_RULESET}`
      }
    ]
  });

  return normalize(ai?.choices?.[0]?.message?.content || "");
}

/* ======================================================
   SHORT NON-DIAGNOSTIC ACK
====================================================== */
function buildShortAck(msg, v) {
  const lower = normalize(msg).toLowerCase();
  const short = normalize(msg).split(/\s+/).length <= 6;

  if (
    !short ||
    /(code|p0|misfire|no start|stall|noise|overheat)/i.test(lower) ||
    !(v.year || v.make || v.model)
  ) {
    return null;
  }

  return `A ${v.year} ${v.make} ${v.model}. Noted.

What’s the symptom?
Codes?
Mileage?
When does it occur?`;
}

/* ======================================================
   MAIN ENTRY
====================================================== */
export async function runGrit({ message, context = [], vehicleContext = {} }) {
  const openai = getOpenAI();

  /* ---------- HARD SAFETY STOP ---------- */
  const hardStop = checkSafetyHardStop(message);
  if (hardStop) {
    return {
      reply: hardStop,
      vehicle: mergeVehicleContexts(vehicleContext, {})
    };
  }

  /* ---------- VEHICLE CONTEXT ---------- */
  let mergedVehicle = mergeVehicleContexts(vehicleContext, {});
  mergedVehicle.engine = inferEngineStringFromYMM(mergedVehicle);

  /* ---------- QUICK ACK (only when not active) ---------- */
  if (diagnosticState.mode !== "active") {
    const quick = buildShortAck(message, mergedVehicle);
    if (quick) return { reply: quick, vehicle: mergedVehicle };
  }

  /* ---------- ENTER DIAGNOSTIC MODE ---------- */
  const dtcs = extractDTCs(message);
  if (
    dtcs.length ||
    /(check engine|diagnose|misfire|no start|overheat|noise)/i.test(message)
  ) {
    diagnosticState.mode = "active";
  }

  /* ---------- STORE DTCs + RESET EXPLANATION GATE ---------- */
  if (dtcs.length) {
    diagnosticState.activeDTCs = dtcs;
    diagnosticState.primaryDTC = dtcs[0];

    diagnosticState.codeExplained = false;
    diagnosticState.lastExplainedDTC = null;

    diagnosticState.domain = null; // re-detect on new code
    diagnosticState.lastQuestion = null;

    // ensure these exist
    diagnosticState.classification = diagnosticState.classification || {};
    diagnosticState.phase = null;
    diagnosticState.awaitingResponse = false;

    // path lock only for dedicated deterministic flows
    if (/^P030[0-8]$/i.test(dtcs[0])) {
      diagnosticState.activePath = "misfire";
    } else {
      diagnosticState.activePath = null;
    }
  }

  /* ======================================================
     ✅ HARD GATE: VEHICLE REQUIRED BEFORE CODE ANALYSIS
  ====================================================== */
  if (diagnosticState.primaryDTC && !vehicleIsComplete(mergedVehicle)) {
    return {
      reply: `Got it — ${diagnosticState.primaryDTC}.

Diagnostics vary by vehicle. I need:
• Year
• Make
• Model
• Engine (or engine code)

Reply with those and I’ll start from the top.`,
      vehicle: mergedVehicle
    };
  }

  /* ======================================================
     🔐 MULTI-DTC EXPLANATION SEQUENCE — HARD STOP
  ====================================================== */
  const nextDTC = getNextUnexplainedDTC(diagnosticState);

  if (nextDTC && requiresDTCExplanation(diagnosticState)) {
    const explanationText = await gptExplainDTC({
      openai,
      code: nextDTC,
      mergedVehicle
    });

    diagnosticState.lastExplainedDTC = nextDTC;

    const moreRemaining =
      diagnosticState.activeDTCs.indexOf(nextDTC) <
      diagnosticState.activeDTCs.length - 1;

    diagnosticState.codeExplained = !moreRemaining;

    // After explanation, kick off with deterministic first intent (code chooses)
    if (!diagnosticState.domain) {
      diagnosticState.domain = detectDomain({ message: nextDTC, dtcs: diagnosticState.activeDTCs || [] });
    }

    const intent = getFirstDiagnosticIntent({
      message: nextDTC,
      dtcs: diagnosticState.activeDTCs || [],
      domain: diagnosticState.domain
    });

    diagnosticState.awaitingResponse = true;
    diagnosticState.lastQuestion = intent;

    const lastAssistant =
      context?.length ? context[context.length - 1]?.content || "" : "";
    const safetyWarnings = collectSafetyWarnings([message, lastAssistant]);

    const kickoffQuestion = await gptAskOneQuestion({
      openai,
      intent,
      mergedVehicle,
      domain: diagnosticState.domain,
      dtc: diagnosticState.primaryDTC,
      safetyWarnings
    });

    return {
      reply: `${explanationText}

Now that we understand what ${nextDTC} means, let’s diagnose it.

${kickoffQuestion}`,
      vehicle: mergedVehicle
    };
  }

  /* ======================================================
     ✅ DETERMINISTIC MISFIRE FLOW (KEEP LOCKED)
     Hybrid note: misfire stays deterministic. GPT is not
     allowed to invent the flow here.
  ====================================================== */

  // Ensure classification container exists
  diagnosticState.classification = diagnosticState.classification || {};

  /* ---- MISFIRE: consume first classification reply ---- */
  if (
    diagnosticState.awaitingResponse &&
    diagnosticState.primaryDTC &&
    /^P030[0-8]$/i.test(diagnosticState.primaryDTC) &&
    diagnosticState.activePath === "misfire" &&
    !diagnosticState.classification.misfire &&
    diagnosticState.lastQuestion === "classify_misfire"
  ) {
    diagnosticState.classification.misfire = normalize(message);
    diagnosticState.awaitingResponse = false;

    // ask next (deterministic) — keep your locked wording
    diagnosticState.awaitingResponse = true;
    diagnosticState.lastQuestion = "misfire_load";

    return {
      reply: `Got it — misfire occurs ${normalize(message).toLowerCase()}.

Is the misfire worse at idle, under load, or both?`,
      vehicle: mergedVehicle
    };
  }

  /* ---- MISFIRE: consume load response ---- */
  if (
    diagnosticState.primaryDTC &&
    /^P030[0-8]$/i.test(diagnosticState.primaryDTC) &&
    diagnosticState.activePath === "misfire" &&
    diagnosticState.classification.misfire &&
    !diagnosticState.classification.misfireLoad &&
    diagnosticState.awaitingResponse &&
    diagnosticState.lastQuestion === "misfire_load"
  ) {
    diagnosticState.classification.misfireLoad = normalize(message);
    diagnosticState.awaitingResponse = false;

    diagnosticState.awaitingResponse = true;
    diagnosticState.phase = "component_history";

    return {
      reply: `Understood — misfire occurs at ${normalize(message).toLowerCase()}.

Has any ignition component (spark plug, wire, or coil) been replaced recently on cylinder ${diagnosticState.primaryDTC.slice(-1)}?

Yes or no.`,
      vehicle: mergedVehicle
    };
  }

  /* ---- MISFIRE: component history ---- */
  if (
    diagnosticState.activePath === "misfire" &&
    diagnosticState.phase === "component_history" &&
    diagnosticState.awaitingResponse
  ) {
    const answer = normalize(message).toLowerCase();
    diagnosticState.awaitingResponse = false;

    if (
      answer.startsWith("y") ||
      answer.includes("plug") ||
      answer.includes("coil") ||
      answer.includes("wire")
    ) {
      diagnosticState.phase = "component_swapped";
      diagnosticState.awaitingResponse = true;

      return {
        reply: `Good to know.

Have you swapped the coil or plug with another cylinder to see if the misfire moved?

Yes or no.`,
        vehicle: mergedVehicle
      };
    }

    if (answer.startsWith("n")) {
      diagnosticState.phase = "original_components";
      diagnosticState.awaitingResponse = true;

      return {
        reply: `Understood.

Have you checked spark on cylinder ${diagnosticState.primaryDTC.slice(-1)}?

Yes or no.`,
        vehicle: mergedVehicle
      };
    }

    diagnosticState.awaitingResponse = true;
    return {
      reply: `Please answer yes or no so we can continue.`,
      vehicle: mergedVehicle
    };
  }

  /* ---- MISFIRE: component swapped outcome ---- */
  if (
    diagnosticState.activePath === "misfire" &&
    diagnosticState.phase === "component_swapped" &&
    diagnosticState.awaitingResponse
  ) {
    const answer = normalize(message).toLowerCase();
    diagnosticState.awaitingResponse = false;

    if (answer.startsWith("y")) {
      diagnosticState.phase = "confirmed_component_fault";

      return {
        reply: `That’s important.

If the misfire moved with the coil or plug, the swapped component is the problem.

Replace the affected ignition component, clear codes, and verify the misfire is gone.`,
        vehicle: mergedVehicle
      };
    }

    if (answer.startsWith("n")) {
      diagnosticState.phase = "component_ruled_out";
      diagnosticState.awaitingResponse = true;

      return {
        reply: `Good diagnostic work.

Since the misfire did NOT move, ignition components are less likely.

Have you verified injector operation (pulse/command) on cylinder ${diagnosticState.primaryDTC.slice(-1)}?

Yes or no.`,
        vehicle: mergedVehicle
      };
    }

    diagnosticState.awaitingResponse = true;
    return {
      reply: `Please answer yes or no so we can continue.`,
      vehicle: mergedVehicle
    };
  }

  /* ======================================================
     DOMAIN SET (READ-ONLY)
  ====================================================== */
  if (!diagnosticState.domain) {
    diagnosticState.domain = detectDomain({ message, dtcs });
  }

  /* ======================================================
     HYBRID NEXT-QUESTION HANDLING
     If we're awaiting a response but not in a locked path,
     we let GPT ask ONE good next question based on intent.
====================================================== */
  const lastAssistant =
    context?.length ? context[context.length - 1]?.content || "" : "";
  const safetyWarnings = collectSafetyWarnings([message, lastAssistant]);

  // If we have no activePath and not awaitingResponse, choose the first intent and ask it.
  if (!diagnosticState.activePath && !diagnosticState.awaitingResponse) {
    const intent = getFirstDiagnosticIntent({
      message,
      dtcs: diagnosticState.activeDTCs || [],
      domain: diagnosticState.domain
    });

    diagnosticState.awaitingResponse = true;
    diagnosticState.lastQuestion = intent;

    const q = await gptAskOneQuestion({
      openai,
      intent,
      mergedVehicle,
      domain: diagnosticState.domain,
      dtc: diagnosticState.primaryDTC,
      safetyWarnings
    });

    return { reply: q, vehicle: mergedVehicle };
  }

  // If awaitingResponse but not in a locked deterministic path, ask a single next question (lightweight continuation).
  if (!diagnosticState.activePath && diagnosticState.awaitingResponse) {
    // Keep it simple: use a generic continuation intent that forces ONE next step question.
    const intent = "continue_from_last_answer";
    diagnosticState.lastQuestion = intent;

    const q = await gptAskOneQuestion({
      openai,
      intent,
      mergedVehicle,
      domain: diagnosticState.domain,
      dtc: diagnosticState.primaryDTC,
      safetyWarnings
    });

    return { reply: q, vehicle: mergedVehicle };
  }

  /* ======================================================
     FALLBACK (locked path but not matched)
====================================================== */
  return {
    reply: "Answer the last diagnostic question to continue.",
    vehicle: mergedVehicle
  };
}
