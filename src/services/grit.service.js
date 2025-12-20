// ===========================================================
// AUTO BRAIN — GRIT SERVICE (RESET / STABLE BASELINE)
// OPTION A — DETERMINISTIC MODE
// ===========================================================

import { getOpenAI } from "./openai.service.js";
import { supabase } from "./supabase.service.js";
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

/* ======================================================
   🔐 MULTI-DTC EXPLANATION HELPERS
====================================================== */
function getNextUnexplainedDTC(state) {
  if (!state.activeDTCs || !state.activeDTCs.length) return null;

  if (!state.lastExplainedDTC) {
    return state.activeDTCs[0];
  }

  const idx = state.activeDTCs.indexOf(state.lastExplainedDTC);
  return state.activeDTCs[idx + 1] || null;
}

/* ======================================================
   🔐 DTC EXPLANATION GATE HELPER
====================================================== */
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
   FIRST-QUESTION GATES (ONLY QUESTION SOURCE)
====================================================== */
function firstQuestionGate({ message, dtcs }) {
  const m = normalize(message).toLowerCase();

  if (/no start/i.test(m)) {
    diagnosticState.awaitingResponse = true;
    return `Before any testing, classify the failure.

When you turn the key:
1) Does it CRANK but not start?
2) Is it a NO-CRANK condition?

Reply with one.`;
  }

  if (/overheat|running hot|temp gauge/i.test(m)) {
    diagnosticState.awaitingResponse = true;
    return `Classify the overheating condition:

1) Idle / stopped
2) Driving
3) Highway / load
4) Heats immediately after startup
5) Gauge reads hot only

Reply with the number.`;
  }

  if (
    /misfire|p030[0-8]/i.test(m) ||
    dtcs.some((c) => /^P030[0-8]$/i.test(c))
  ) {
    diagnosticState.awaitingResponse = true;
    return `Classify the misfire:

• Single cylinder or multiple/random?
• Idle, load, cold, or all the time?

Reply briefly.`;
  }

  if (/p0171|p0174|lean/i.test(m)) {
    diagnosticState.awaitingResponse = true;
    return `Lean condition detected.

Which applies?
1) Bank 1
2) Bank 2
3) Both banks

Reply with the number.`;
  }

  if (/evap|p04\d{2}/i.test(m)) {
    diagnosticState.awaitingResponse = true;
    return `EVAP fault detected.

Have you verified:
• Gas cap seal/tightness
• Visible purge/vent lines

Yes or no?`;
  }

  return null;
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

  /* ---------- QUICK ACK ---------- */
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

  // 🔒 PATH LOCK
  if (/^P030[0-8]$/i.test(dtcs[0])) {
    diagnosticState.activePath = "misfire";
  }
}


  /* ======================================================
     🔐 MULTI-DTC EXPLANATION SEQUENCE — HARD STOP
  ====================================================== */
  const nextDTC = getNextUnexplainedDTC(diagnosticState);

  if (nextDTC && requiresDTCExplanation(diagnosticState)) {
    const explanationPrompt = `
You are GRIT — a professional automotive diagnostic mentor.

Explain diagnostic trouble code ${nextDTC} clearly and concisely.

Required structure:
1) What this code means (plain English)
2) What system is involved
3) How the PCM/ECM detects it (high level)
4) What this code does NOT automatically mean

Rules:
- Be concise
- No repair instructions
- No testing steps
- No questions
`;

    const explanation = await openai.chat.completions.create({
      model: "gpt-4.1",
      temperature: 0.3,
      messages: [{ role: "system", content: explanationPrompt }]
    });

    diagnosticState.lastExplainedDTC = nextDTC;

    const moreRemaining =
      diagnosticState.activeDTCs.indexOf(nextDTC) <
      diagnosticState.activeDTCs.length - 1;

    diagnosticState.codeExplained = !moreRemaining;

    const handoff = `

Now that we understand what ${nextDTC} means, let’s start diagnosing it properly.
`;

    const diagnosticKickoff = firstQuestionGate({
      message: nextDTC,
      dtcs: diagnosticState.activeDTCs
    });

    return {
      reply:
        explanation.choices[0].message.content +
        handoff +
        (diagnosticKickoff ? `\n\n${diagnosticKickoff}` : ""),
      vehicle: mergedVehicle
    };
  }

  /* ======================================================
     ✅ CONSUME DIAGNOSTIC RESPONSE (FIXED)
  ====================================================== */
  if (
    diagnosticState.awaitingResponse &&
    diagnosticState.primaryDTC &&
    /^P030[0-8]$/i.test(diagnosticState.primaryDTC) &&
    !diagnosticState.classification.misfire
  ) {
    diagnosticState.classification.misfire = normalize(message);
    diagnosticState.awaitingResponse = false;

    return {
      reply: `Got it — misfire occurs ${message.toLowerCase()}.

Next step:
We need to determine whether this is ignition, fuel, or mechanical.

Before continuing:
• Is the misfire worse at idle, under load, or both?`,
      vehicle: mergedVehicle
    };
  }

/* ======================================================
   ✅ CONSUME MISFIRE LOAD RESPONSE (LOCKED)
====================================================== */
if (
  diagnosticState.primaryDTC &&
  /^P030[0-8]$/i.test(diagnosticState.primaryDTC) &&
  diagnosticState.classification.misfire &&
  !diagnosticState.classification.misfireLoad
)
 {
  diagnosticState.classification.misfireLoad = normalize(message);

  // 🔒 Advance diagnostic state
  diagnosticState.awaitingResponse = true;
  diagnosticState.nextExpected = "component_history";
  diagnosticState.phase = "component_history";

  return {
    reply: `Understood — misfire occurs at ${message.toLowerCase()}.

Based on this pattern, we can narrow the direction:

• Ignition issues often worsen under load  
• Mechanical issues usually affect idle and load  
• Fuel delivery problems can affect both  

Next question:
Has any ignition component (spark plug, wire, or coil) been replaced recently on cylinder ${diagnosticState.primaryDTC.slice(-1)}?

Yes or no.`,
    vehicle: mergedVehicle
  };
}

/* ======================================================
   ✅ CONSUME COMPONENT HISTORY RESPONSE (LOCKED)
====================================================== */
if (
  diagnosticState.activePath === "misfire" &&
  diagnosticState.phase === "component_history" &&
  diagnosticState.awaitingResponse
) {
  const answer = normalize(message).toLowerCase();

  // 🔒 Consume response once
  diagnosticState.awaitingResponse = false;

  // ------------------------------------------
  // YES / COMPONENT ALREADY REPLACED
  // ------------------------------------------
  if (
    answer.startsWith("y") ||
    answer.includes("plug") ||
    answer.includes("coil") ||
    answer.includes("wire")
  ) {
    diagnosticState.phase = "component_swapped";

    return {
      reply: `Good to know.

Since components have already been replaced, the next step is to verify whether the misfire follows the component or stays on cylinder ${diagnosticState.primaryDTC.slice(-1)}.

Have you swapped the coil or plug with another cylinder to see if the misfire moved?

Yes or no.`,
      vehicle: mergedVehicle
    };
  }

  // ------------------------------------------
  // NO / ORIGINAL COMPONENTS
  // ------------------------------------------
  if (answer.startsWith("n")) {
    diagnosticState.phase = "original_components";

    return {
      reply: `Understood.

Before replacing anything, we should confirm whether this is ignition, fuel, or mechanical.

Next step:
Have you checked spark on cylinder ${diagnosticState.primaryDTC.slice(-1)}?

Yes or no.`,
      vehicle: mergedVehicle
    };
  }

  // ------------------------------------------
  // INVALID RESPONSE
  // ------------------------------------------
  diagnosticState.awaitingResponse = true;

  return {
    reply: `Please answer yes or no so we can continue.`,
    vehicle: mergedVehicle
  };
}


/* ======================================================
   ✅ CONSUME COMPONENT SWAP RESPONSE
====================================================== */
if (
  diagnosticState.activePath === "misfire" &&
  diagnosticState.phase === "component_swapped" &&
  diagnosticState.awaitingResponse
) {
  const answer = normalize(message).toLowerCase();
  diagnosticState.awaitingResponse = false;

  if (answer.startsWith("y")) {
    return {
      reply: `Perfect.

If the misfire moved with the component, that confirms a faulty ignition part.

Next step:
Replace the component that caused the misfire to move and clear codes.

If you'd like, we can also verify wiring or PCM driver concerns.`,
      vehicle: mergedVehicle
    };
  }

  if (answer.startsWith("n")) {
    diagnosticState.phase = "original_components";

    return {
      reply: `Understood.

Since the misfire did NOT move with a swapped component, ignition is less likely.

Next step:
We need to check:
• Injector operation on cylinder ${diagnosticState.primaryDTC.slice(-1)}
• Compression / mechanical integrity

Have you checked injector pulse or compression yet?`,
      vehicle: mergedVehicle
    };
  }

  return {
    reply: "Please answer yes or no so we can continue.",
    vehicle: mergedVehicle
  };
}





  /* ---------- DOMAIN (READ-ONLY) ---------- */
  if (!diagnosticState.domain) {
    diagnosticState.domain = detectDomain({ message, dtcs });
  }

  /* ---------- FIRST QUESTION GATE ---------- */
  if (!diagnosticState.activePath && !diagnosticState.awaitingResponse) {
  const gate = firstQuestionGate({
  message,
  dtcs: diagnosticState.activeDTCs || []
});
  if (gate) {
    return { reply: gate, vehicle: mergedVehicle };
  }
}


  /* ---------- SAFETY WARNINGS ---------- */
  const lastAssistant =
    context?.length ? context[context.length - 1]?.content || "" : "";
  const safetyWarnings = collectSafetyWarnings([message, lastAssistant]);

  /* ---------- AI RESPONSE (EXPLANATION ONLY) ---------- */
  if (!diagnosticState.activePath) {
  const ai = await openai.chat.completions.create({
    model: "gpt-4.1",
    temperature: 0.3,
    messages: [
      {
        role: "system",
        content: `
You are GRIT — a professional automotive diagnostic mentor.

You may EXPLAIN or CLARIFY.
You may NOT introduce new diagnostic questions unless explicitly instructed.

${safetyWarnings.length ? safetyWarnings.join("\n") + "\n\n" : ""}
ACTIVE DOMAIN (locked): ${diagnosticState.domain}

${GRIT_RULESET}

Vehicle Context:
${JSON.stringify(mergedVehicle)}
`
      },
      ...(context || []),
      { role: "user", content: message }
    ]
  });

  return {
    reply: ai.choices[0].message.content,
    vehicle: mergedVehicle
  };
}

return {
  reply: "Answer the last diagnostic question to continue.",
  vehicle: mergedVehicle
};
}
