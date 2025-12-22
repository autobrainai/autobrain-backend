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

/* ======================================================
   🔑 GLOBAL ACCESSIBILITY INTERPRETER (ALL DOMAINS)
====================================================== */
function interpretAccessibility(msg = "") {
  const m = normalize(msg).toLowerCase();

  if (m.startsWith("y")) return "completed";
  if (m.startsWith("n")) return "not_done";

  if (
    m.includes("hard") ||
    m.includes("not accessible") ||
    m.includes("can't reach") ||
    m.includes("cannot reach") ||
    m.includes("drop") ||
    m.includes("remove") ||
    m.includes("pull") ||
    m.includes("tear") ||
    m.includes("intake") ||
    m.includes("tank")
  ) {
    return "requires_labor";
  }

  return "unknown";
}

/* ======================================================
   🔑 DIAGNOSTIC TIERS (GLOBAL PRIORITY ENGINE)
====================================================== */
const DIAGNOSTIC_TIERS = ["tier_0", "tier_1", "tier_2", "tier_3"];

/*
tier_0 = no labor (scan data, freeze frame)
tier_1 = easy access (engine bay, visible connectors)
tier_2 = moderate access (wheel off, shields)
tier_3 = labor required (intake, tank, teardown)
*/
const INTENT_META = {
  scan_data_review: { tier: "tier_0" },
  freeze_frame_review: { tier: "tier_0" },

  visual_connector_check: { tier: "tier_1" },
  underhood_visual_check: { tier: "tier_1" },

  underbody_access_check: { tier: "tier_2" },
  wheel_off_inspection: { tier: "tier_2" },

  labor_required_access: { tier: "tier_3" }
};

function getNextTier(currentIntent) {
  const currentTier = INTENT_META[currentIntent]?.tier;
  if (!currentTier) return null;

  const idx = DIAGNOSTIC_TIERS.indexOf(currentTier);
  if (idx === -1 || idx === DIAGNOSTIC_TIERS.length - 1) return null;

  return DIAGNOSTIC_TIERS[idx + 1];
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
   DETERMINISTIC FIRST-QUESTION INTENTS
====================================================== */
function getFirstDiagnosticIntent({ message, dtcs, domain }) {
  const m = normalize(message).toLowerCase();

  if (/no start/i.test(m)) return "classify_no_start";
  if (/overheat|running hot|temp gauge/i.test(m)) return "classify_overheat";
  if (/misfire|p030[0-8]/i.test(m)) return "classify_misfire";
  if (/p0171|p0174|lean/i.test(m)) return "classify_lean";

  return "scan_data_review"; // default easiest step
}

/* ======================================================
   GPT HELPERS
====================================================== */
async function gptExplainDTC({ openai, code, mergedVehicle }) {
  const explanationPrompt = `
Explain diagnostic trouble code ${code} briefly.

Constraints:
- Max 4 sentences
- Technician language
- No steps, no questions
`;

  const explanation = await openai.chat.completions.create({
    model: "gpt-4.1",
    temperature: 0.3,
    messages: [
      { role: "system", content: explanationPrompt }
    ]
  });

  return normalize(explanation.choices[0].message.content);
}

async function gptAskOneQuestion({ openai, intent, mergedVehicle, domain, dtc, safetyWarnings }) {
  const prompt = `
Ask ONE diagnostic question.

Rules:
- Start with easiest / least intrusive
- If physical access is required, say:
  "Only if easily accessible. If not, say so."
- If not accessible, move to next lowest-effort step
`;

  const ai = await openai.chat.completions.create({
    model: "gpt-4.1",
    temperature: 0.3,
    messages: [
      { role: "system", content: `${prompt}\n${GRIT_RULESET}` }
    ]
  });

  return normalize(ai.choices[0].message.content);
}

/* ======================================================
   MAIN ENTRY
====================================================== */
export async function runGrit({ message, context = [], vehicleContext = {} }) {
  const openai = getOpenAI();

  const hardStop = checkSafetyHardStop(message);
  if (hardStop) return { reply: hardStop, vehicle: vehicleContext };

  let mergedVehicle = mergeVehicleContexts(vehicleContext, {});
  mergedVehicle.engine = inferEngineStringFromYMM(mergedVehicle);

  const dtcs = extractDTCs(message);
  if (dtcs.length) {
    diagnosticState.mode = "active";
    diagnosticState.activeDTCs = dtcs;
    diagnosticState.primaryDTC = dtcs[0];
    diagnosticState.codeExplained = false;
    diagnosticState.lastExplainedDTC = null;
    diagnosticState.lastQuestion = null;
  }

  if (diagnosticState.primaryDTC && !vehicleIsComplete(mergedVehicle)) {
    return {
      reply: `I need year, make, model, and engine before diagnosing ${diagnosticState.primaryDTC}.`,
      vehicle: mergedVehicle
    };
  }

  const nextDTC = getNextUnexplainedDTC(diagnosticState);
  if (nextDTC && requiresDTCExplanation(diagnosticState)) {
    const explanation = await gptExplainDTC({ openai, code: nextDTC, mergedVehicle });
    diagnosticState.lastExplainedDTC = nextDTC;
    diagnosticState.codeExplained = true;

    return {
      reply: `${explanation}\n\nLet’s start diagnostics.`,
      vehicle: mergedVehicle
    };
  }

  /* ======================================================
     GLOBAL ACCESSIBILITY ESCALATION (ALL DOMAINS)
  ====================================================== */
  if (diagnosticState.awaitingResponse) {
    const access = interpretAccessibility(message);

    if (access === "requires_labor") {
      const nextTier = getNextTier(diagnosticState.lastQuestion);

      if (!nextTier) {
        return {
          reply: `All non-intrusive diagnostic options are exhausted. Further diagnosis requires labor.`,
          vehicle: mergedVehicle
        };
      }

      diagnosticState.lastQuestion = nextTier;
      diagnosticState.awaitingResponse = true;

      const q = await gptAskOneQuestion({
        openai,
        intent: nextTier,
        mergedVehicle,
        domain: diagnosticState.domain,
        dtc: diagnosticState.primaryDTC
      });

      return { reply: q, vehicle: mergedVehicle };
    }
  }

  if (!diagnosticState.awaitingResponse) {
    const intent = getFirstDiagnosticIntent({
      message,
      dtcs,
      domain: diagnosticState.domain
    });

    diagnosticState.awaitingResponse = true;
    diagnosticState.lastQuestion = intent;

    const q = await gptAskOneQuestion({
      openai,
      intent,
      mergedVehicle,
      domain: diagnosticState.domain,
      dtc: diagnosticState.primaryDTC
    });

    return { reply: q, vehicle: mergedVehicle };
  }

  return {
    reply: "Answer the last diagnostic question to continue.",
    vehicle: mergedVehicle
  };
}
