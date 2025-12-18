import { getOpenAI } from "./openai.service.js";
import { supabase } from "./supabase.service.js";
import { GRIT_RULESET } from "../rules/grit.ruleset.js";

import { classifyGMEngine } from "../utils/engine.util.js";
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
   DIAGNOSTIC STEP MAP (MVP v1)
====================================================== */
const DIAGNOSTIC_STEPS = {
  awaiting_test_result: {
    pass: "next_logical_test",
    fail: "failure_path_analysis"
  },
  fuel_pressure_koeo: {
    pass: "fuel_trim_analysis",
    fail: "fuel_supply_diagnostics"
  }
};

/* ======================================================
   DTC AUTO-CLASSIFIERS (CRITICAL)
====================================================== */
function extractMisfireFromDTC(message) {
  const single = message.match(/p030([1-8])/i);
  if (single) {
    return {
      type: "single",
      cylinder: Number(single[1])
    };
  }

  if (/p0300/i.test(message)) {
    return { type: "multiple" };
  }

  return null;
}

function extractLeanFromDTC(message) {
  if (/p0171/i.test(message)) return { banks: "bank1" };
  if (/p0174/i.test(message)) return { banks: "bank2" };
  if (/p0171.*p0174|p0174.*p0171/i.test(message))
    return { banks: "both" };
  return null;
}

function extractEvapFromDTC(message) {
  if (/p0455|large leak/i.test(message)) return "large";
  if (/p0456|small leak/i.test(message)) return "small";
  if (/p0443|purge|vent/i.test(message)) return "purge_or_vent";
  return null;
}

function extractNetworkFromDTC(message) {
  if (/u0\d{3}/i.test(message)) return "network";
  return null;
}

/* ======================================================
   Extract vehicle from technician text
====================================================== */
async function extractVehicleFromText(message) {
  try {
    const openai = getOpenAI();
    const resp = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      temperature: 0,
      messages: [
        {
          role: "system",
          content: `
Extract ONLY this JSON:
{ "year": "", "make": "", "model": "", "engine": "" }
Unknown => empty string.
`
        },
        { role: "user", content: message }
      ]
    });

    return JSON.parse(resp.choices[0].message.content);
  } catch {
    return { year: "", make: "", model: "", engine: "" };
  }
}

/* ======================================================
   Short GRIT acknowledgement
====================================================== */
function buildGritResponse(msg, v) {
  const lower = msg.toLowerCase();
  const hasSymptoms =
    lower.includes("code") ||
    lower.includes("p0") ||
    lower.includes("misfir") ||
    lower.includes("no start") ||
    lower.includes("stall") ||
    lower.includes("noise") ||
    lower.includes("overheat");

  const short = msg.trim().split(/\s+/).length <= 6;
  if (!short || hasSymptoms || !(v.year || v.make || v.model)) return null;

  return `
A ${v.year} ${v.make} ${v.model}. Noted.
But what's it *doing*?

Codes?
Misfires?
No-start?
Noise?
Overheating?

Give mileage + symptoms so I can build a real plan.`;
}

/* ======================================================
   TECH RESPONSE CLASSIFIER
====================================================== */
function classifyTechResponse(message) {
  const m = message.toLowerCase().trim();

  if (
    /(^|\b)(pass|passed|good|ok|okay|normal|yes|done|checked|tested|verified|confirmed)(\b|$)/i.test(m)
  ) return "pass";

  if (
    diagnosticState.awaitingResponse &&
    /(checked|measured|found|showed|reading|was|were)/i.test(m)
  ) return "pass";

  if (
    /(^|\b)(fail|failed|bad|no|nope|nah|negative|zero|not yet|not done|did not|didn't|haven't|not sure|idk)(\b|$)/i.test(m)
  ) return "fail";

  return null;
}

/* ======================================================
   MAIN GRIT SERVICE
====================================================== */
export async function runGrit({ message, context = [], vehicleContext = {} }) {
  const lower = message.toLowerCase();

  /* ---------- HARD SAFETY STOP ---------- */
  const hardStop = checkSafetyHardStop(message);
  if (hardStop) {
    return {
      reply: hardStop,
      vehicle: mergeVehicleContexts(vehicleContext, {})
    };
  }

  /* ---------- GLOBAL SAFETY DISCLAIMER ---------- */
  let globalSafetyDisclaimer = "";
  if (!diagnosticState.disclaimerSent) {
    diagnosticState.disclaimerSent = true;
    globalSafetyDisclaimer =
      "⚠️ Safety: AutoBrain GRIT provides diagnostic guidance for trained technicians. " +
      "Follow OEM procedures and shop safety standards. Use proper PPE. " +
      "If unsure or unsafe, stop and verify.\n\n";
  }

  /* ---------- VEHICLE EXTRACTION ---------- */
  const extracted = await extractVehicleFromText(message);
  let mergedVehicle = mergeVehicleContexts(vehicleContext, extracted);
  mergedVehicle.engine = inferEngineStringFromYMM(mergedVehicle);

  /* ---------- QUICK RESPONSE ---------- */
  if (diagnosticState.mode !== "active") {
    const quick = buildGritResponse(message, mergedVehicle);
    if (quick) return { reply: quick, vehicle: mergedVehicle };
  }

  /* ---------- ENTER DIAGNOSTIC MODE ---------- */
  if (/\b(p0|p1|u0|b0|c0)\d{3}\b/i.test(message)) {
    diagnosticState.mode = "active";
  }

  /* ---------- AUTO DTC CLASSIFICATION ---------- */
  if (!diagnosticState.lastStep) {
    const misfire = extractMisfireFromDTC(message);
    if (misfire) {
      diagnosticState.classification.misfire = misfire;
      return {
        reply:
          `Misfire classification locked (${misfire.type}${misfire.cylinder ? ` — cylinder ${misfire.cylinder}` : ""}).\n\n` +
          `When does it occur?\n• Idle\n• Under load\n• Cold start\n• All the time`,
        vehicle: mergedVehicle
      };
    }

    const lean = extractLeanFromDTC(message);
    if (lean) {
      diagnosticState.classification.lean = lean;
      return {
        reply:
          `Lean condition confirmed (${lean.banks}).\n\n` +
          `Is this at idle, cruise, or under load?`,
        vehicle: mergedVehicle
      };
    }

    const evap = extractEvapFromDTC(message);
    if (evap) {
      diagnosticState.classification.evap = evap;
      return {
        reply:
          `EVAP fault type confirmed (${evap}).\n\n` +
          `Has the gas cap and purge/vent been visually verified yet?`,
        vehicle: mergedVehicle
      };
    }

    const network = extractNetworkFromDTC(message);
    if (network) {
      diagnosticState.classification.network = network;
      return {
        reply:
          `Network fault detected.\n\n` +
          `Is this a single-module U-code or multiple modules offline?`,
        vehicle: mergedVehicle
      };
    }
  }

  /* ---------- HANDLE TEST RESULTS ---------- */
  if (diagnosticState.awaitingResponse && diagnosticState.lastStep) {
    const result = classifyTechResponse(message);
    if (result && DIAGNOSTIC_STEPS[diagnosticState.lastStep]) {
      diagnosticState.lastStep =
        DIAGNOSTIC_STEPS[diagnosticState.lastStep][result] || null;
      diagnosticState.awaitingResponse = false;
      diagnosticState.expectedTest = null;

      context.push({
        role: "system",
        content: "Previous diagnostic test confirmed. Continuing."
      });
    }
  }

  /* ---------- DIAGNOSTIC INSTRUCTIONS ---------- */
  let diagnosticInstructions = "";
  if (diagnosticState.mode === "active") {
    diagnosticInstructions = `
DIAGNOSTIC MODE ACTIVE:
- Provide ONLY ONE test or check
- End with a direct question
- Wait for confirmation

Current step: ${diagnosticState.lastStep || "initial"}
`;
  }

  /* ---------- SAFETY WARNINGS ---------- */
  const lastAssistant =
    context?.length ? context[context.length - 1]?.content || "" : "";

  const safetyWarnings = collectSafetyWarnings([
    message,
    lastAssistant,
    diagnosticInstructions
  ]);

  /* ---------- AI RESPONSE ---------- */
  const openai = getOpenAI();
  const ai = await openai.chat.completions.create({
    model: "gpt-4.1",
    temperature: 0.3,
    messages: [
      {
        role: "system",
        content: `
You are GRIT — a ruthless diagnostic mentor.

${globalSafetyDisclaimer}
${safetyWarnings.length ? safetyWarnings.join("\n") + "\n\n" : ""}
${diagnosticInstructions}
${GRIT_RULESET}

Vehicle Context:
${JSON.stringify(mergedVehicle)}
`
      },
      ...(context || []),
      { role: "user", content: message }
    ]
  });

  if (diagnosticState.mode === "active") {
    diagnosticState.awaitingResponse = true;
  }

  return {
    reply: ai.choices[0].message.content,
    vehicle: mergedVehicle
  };
}
