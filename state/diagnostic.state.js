export let diagnosticState = {
  mode: "idle",
  lastStep: null,
  expectedTest: null,
  awaitingResponse: false,
  disclaimerSent: false,
  classification: {
    misfire: null,
    smoke: null
  }
};

export function resetDiagnosticState() {
  diagnosticState = {
    mode: "idle",
    lastStep: null,
    expectedTest: null,
    awaitingResponse: false,
    disclaimerSent: false,
    classification: {
      misfire: null,
      smoke: null
    }
  };
}
