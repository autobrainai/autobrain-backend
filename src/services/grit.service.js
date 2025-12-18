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
   Extract vehicle from technician text
====================================================== */
async function extractVehicleFromText(message) {
  try {
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
  if (
    /\b(p0|p1|u0|b0|c0)\d{3}\b/i.test(message) ||
    lower.includes("check engine") ||
    lower.includes("diagnose")
  ) {
    diagnosticState.mode = "active";
  }

  /* ---------- CLASSIFICATION GATES ---------- */
  if (diagnosticState.mode === "active" && !diagnosticState.lastStep) {
    if (/no start/i.test(message)) {
      diagnosticState.lastStep = "classify_crank";
      diagnosticState.awaitingResponse = true;
      return {
        reply:
          "Before testing, classify the failure:\n\n" +
          "1) Cranks but will not start\n" +
          "2) No crank\n\nReply with ONLY one.",
        vehicle: mergedVehicle
      };
    }

    if (/overheat|overheating|running hot/i.test(message)) {
      diagnosticState.lastStep = "classify_overheat";
      diagnosticState.awaitingResponse = true;
      return {
        reply:
          "Classify the overheating condition:\n\n" +
          "1) Idle only\n2) Driving\n3) Highway/load\n4) Immediately after startup\n5) Gauge only\n\nReply with the number.",
        vehicle: mergedVehicle
      };
    }

    if (/misfire|rough idle|shaking/i.test(message)) {
      diagnosticState.lastStep = "classify_misfire";
      diagnosticState.awaitingResponse = true;
      return {
        reply:
          "Classify the misfire:\n\n" +
          "1) Single cylinder\n2) Multiple/random\n" +
          "When does it occur?\n\nReply briefly.",
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
