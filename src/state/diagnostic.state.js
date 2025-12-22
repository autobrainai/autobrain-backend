// ===========================================================
// AUTO BRAIN — GRIT DIAGNOSTIC STATE (HYBRID v1)
// Code controls truth. GPT controls language.
// ===========================================================

export const diagnosticState = {
  // -------------------------------------------
  // Core mode / session control
  // -------------------------------------------
  mode: "idle",                // "idle" | "active"
  awaitingResponse: false,     // waiting for user to answer a diagnostic question
  lastQuestion: null,          // intent or identifier of last asked question

  // -------------------------------------------
  // Vehicle & DTC context (AUTHORITATIVE)
  // -------------------------------------------
  vehicleContext: {
    confirmed: false,          // 🔒 true once Vehicle Context box is confirmed

    year: null,
    make: null,
    model: null,
    engine: null,
    engineCode: null,
    vin: null,                 // optional
    source: null               // "vin" | "manual" | "mixed"
  },

  activeDTCs: [],              // all detected DTCs
  primaryDTC: null,            // first / active DTC

  // -------------------------------------------
  // 🔐 REQUIRED — DTC EXPLANATION GATE
  // -------------------------------------------
  codeExplained: false,        // must be true before diagnostics
  lastExplainedDTC: null,      // supports multi-DTC sequencing

  // -------------------------------------------
  // Diagnostic routing
  // -------------------------------------------
  domain: null,                // locked diagnostic domain (engine, evap, etc.)
  activePath: null,            // deterministic path (e.g. "misfire") or null

  // -------------------------------------------
  // Deterministic flow tracking (used only when activePath !== null)
  // -------------------------------------------
  phase: null,                 // current phase in locked flows
  nextExpected: null,          // optional hint for next step

  // -------------------------------------------
  // Classification buckets (lightweight)
  // -------------------------------------------
  classification: {
    misfire: null,
    misfireLoad: null,
    smoke: null
  }
};

/* ===========================================================
   🔁 AUTHORITATIVE RESET — HYBRID SAFE
   This is the ONLY way vehicle context should be cleared.
=========================================================== */
export function resetDiagnosticState() {
  diagnosticState.mode = "idle";
  diagnosticState.awaitingResponse = false;
  diagnosticState.lastQuestion = null;

  diagnosticState.vehicleContext = {
    confirmed: false,

    year: null,
    make: null,
    model: null,
    engine: null,
    engineCode: null,
    vin: null,
    source: null
  };

  diagnosticState.activeDTCs = [];
  diagnosticState.primaryDTC = null;

  // 🔐 RESET DTC EXPLANATION GATE
  diagnosticState.codeExplained = false;
  diagnosticState.lastExplainedDTC = null;

  diagnosticState.domain = null;
  diagnosticState.activePath = null;

  diagnosticState.phase = null;
  diagnosticState.nextExpected = null;

  diagnosticState.classification = {
    misfire: null,
    misfireLoad: null,
    smoke: null
  };
}
