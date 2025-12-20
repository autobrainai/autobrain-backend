// state/diagnostic.state.js

export const diagnosticState = {
  // Core mode / flow
  mode: "idle",
  lastStep: null,
  expectedTest: null,
  awaitingResponse: false,
  disclaimerSent: false,

  // Vehicle & DTC context
  vehicleContext: null,
  activeDTCs: [],
  primaryDTC: null,

  // 🔐 REQUIRED — DTC EXPLANATION GATE
  codeExplained: false,

  // Diagnostic tracking
  currentStep: null,
  diagnosticPath: [],
  lastUserMessage: null,

  // Classifications
  classification: {
    misfire: null,
    smoke: null
  }
};

// 🔁 AUTHORITATIVE RESET
export function resetDiagnosticState() {
  diagnosticState.mode = "idle";
  diagnosticState.lastStep = null;
  diagnosticState.expectedTest = null;
  diagnosticState.awaitingResponse = false;
  diagnosticState.disclaimerSent = false;

  diagnosticState.vehicleContext = null;
  diagnosticState.activeDTCs = [];
  diagnosticState.primaryDTC = null;

  // 🔐 RESET THE GATE
  diagnosticState.codeExplained = false;

  diagnosticState.currentStep = null;
  diagnosticState.diagnosticPath = [];
  diagnosticState.lastUserMessage = null;

  diagnosticState.classification = {
    misfire: null,
    smoke: null
  };
}
