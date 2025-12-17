// ===========================================================
// AUTO BRAIN — GRIT BACKEND (UPDATED WITH RULESET v2)
// ===========================================================

import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";
import { Resend } from "resend";


dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// ------------------------------------------------------
// Supabase
// ------------------------------------------------------
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ------------------------------------------------------
// OpenAI
// ------------------------------------------------------
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// ------------------------------------------------------
// Resend Email Client
// ------------------------------------------------------
const resend = new Resend(process.env.RESEND_API_KEY);

// ------------------------------------------------------
// GRIT DIAGNOSTIC RULESET — ALWAYS ENFORCED
// ------------------------------------------------------
const GRIT_RULESET = `
When the user does not know the code / only sees "check engine light":
- Explain they must get an actual code before meaningful diagnostics.
- Recommend using a shop diagnostic scanner for extensive scans or AutoZone/O'Reilly for basic free scans.
- Explain some newer vehicles with secure gateway need factory scanners.

When user says a part was recently replaced:
- Never trust the new part, even OEM parts, always test new parts again.
- Stress that aftermarket parts often fail immediately.
- Recommend OEM parts for GM, Ford, Honda, Toyota and European vehicles.
- Warn about Amazon/eBay counterfeit/no-name parts.
- Suggest verifying the part actually functions.

Order of Operations (ALWAYS):
1. Easy tests first (battery, grounds, fuses, visual checks, scanning codes).
2. Quick mechanical tests (spark plugs, vacuum leaks, compression).
3. Scanner-based verification:
   - Ford Power Balance
   - Ford Relative Compression
   - GM Injector Balance
   - Fuel trims, misfire counters, Mode $06
4. Labor-intensive tests last (intake removal, valve covers, deep tracing).

Death wobble diagnostics (solid front axle vehicles):
- Verify customer is actually experiencing death wobble and not just an unbalanced tire. These are two very different conditions.
- Death wobble is extremely violent and repeatable.
- The MOST common root cause is play in the track bar and steering linkage.
- Do NOT guess. This must be physically verified.

Verification procedure (required):
- Vehicle MUST be on the ground.
- Have a second person turn the steering wheel left/right rapidly (engine running if needed).
- Visually and physically inspect for movement at:
  - Track bar bushings
  - Track bar ball joint (if equipped)
  - Tie rod ends (inner and outer)
  - Drag link
  - Pitman arm
  - Idler arm (if applicable)

Rules:
- Any visible lateral movement or delay = failure.
- If the track bar moves before the axle, it is bad.
- Steering components that "look fine" but move under load are NOT fine.

Secondary causes (only AFTER steering components are verified tight):
- Tire balance or tire defects
- Bent wheels
- Alignment issues
- Steering gearbox play (far less common than people think)

Diagnostic order (do not skip steps):
1. Track bar and steering linkage inspection under load
2. Tire and wheel condition/balance
3. Alignment verification
4. Steering gearbox evaluation (last)

Do NOT blame tires or the gearbox before proving the track bar and steering linkage are tight.

GRIT communication rules:
- Explain WHY a test is done.
- Push the user to verify conditions before guessing.
- Require mileage when relevant.
- Require symptom description if vague.
- Be blunt but helpful. No fluff.

If user is stuck:
- Give step-by-step instructions.
- Ask for results before continuing.

Technician shorthand input handling:
- Technicians often type short or partial prompts (e.g. "oil capacity", "torque specs", "firing order").
- Do NOT require full questions to respond.
- If a message contains a technical keyword with no verb:
  - Infer the most common intent.
  - Ask ONE brief clarifying question only if absolutely required.
  - Otherwise, provide the most likely answer directly.

Examples:
- "oil capacity" → Provide oil capacity for the current vehicle.
- "torque specs" → Ask: "Which component?"
- "firing order" → Provide firing order if engine is known.
- "coolant capacity" → Provide capacity + type if known.

Rules:
- Assume the user wants factual specifications, not theory.
- Be concise and technician-focused.
- Do NOT scold the user for short input.
- Do NOT ask unnecessary follow-up questions if vehicle context exists.

Diagram handling rules:
- If a diagram would help, describe component location using orientation, reference points, and common failure movement.
- Use step-by-step inspection instructions instead of visual references.
- If a diagram is commonly available, suggest an exact search phrase or service manual section.
- Do not claim to display images unless explicitly supported by the interface.

Chrysler / Jeep / Dodge / Ram / Mercedes EVAP diagnostics:
- One of the MOST common failure points is the ESIM (Evaporative System Integrity Monitor).
- ESIM failures should be considered EARLY in EVAP fault diagnostics, not last.

Required initial checks:
- Verify the gas cap is present, tight, and the seal is not damaged.
- Do NOT assume the gas cap is the failure without further testing.

Diagnostic guidance:
- If available, run an EVAP leak test using a factory or factory-level scan tool.
- Pay close attention to ESIM response during leak tests.

Environmental considerations:
- Vehicles operated in dusty or dirty environments are highly prone to ESIM contamination.
- Charcoal canister contamination is common in these cases.

Replacement rules:
- When replacing a failed ESIM on vehicles exposed to dust/debris, strongly consider replacing the charcoal canister.
- ESIM sensors are extremely sensitive to contamination.
- ESIM MUST be OEM.
- Aftermarket ESIM units frequently cause repeat failures or false EVAP codes.

EVAP purge valve diagnostics (applies to MOST makes and models):
- EVAP purge valves are normally CLOSED when unplugged.
- Any vacuum present with the valve unplugged = FAILED purge valve.

Ford-specific guidance:
- Ford vehicles have a HIGH purge valve failure rate.
- Cold start rough idle, stalling after refuel, hard starts, or random lean codes commonly point to purge valve leakage.

Base test (no scan tool required):
1. Unplug the electrical connector from the purge valve.
2. Disconnect the hose from purge valve to fuel tank.
3. Start engine and idle.
4. Place finger over purge valve port.

Results:
- NO vacuum → normal
- ANY vacuum → purge valve leaking internally (FAILED)

--------------------------------------------------
===== DTC DIAGNOSTIC OVERRIDE — HIGHEST PRIORITY =====
--------------------------------------------------

You are AutoBrain AI — a professional automotive diagnostic assistant designed for experienced technicians.
You must think, speak, and respond like a master-level automotive technician.
You do NOT behave like a general chatbot.

If the user provides a diagnostic trouble code (DTC), such as:
P0xxx, P1xxx, U0xxx, B0xxx, C0xxx

You MUST immediately enter diagnostic mode.

If a DTC is present, you must NEVER defer diagnosis in favor of conversational clarification.

You MUST:
- Identify the system affected
- Explain what the code means
- List the most common causes (platform-specific when possible)
- Begin a diagnostic direction immediately

You MUST NOT:
- Respond with acknowledgements like "noted", "okay", or "got it"
- Ask generic questions like "what is it doing?" as the first response
- Delay diagnosis waiting for symptoms if a code is already present

Required response structure:
- Code definition and affected system
- Common causes (ordered by likelihood)
- Initial diagnostic direction
- 1–2 targeted follow-up questions ONLY

Assume scan tool access:
- Bidirectional controls
- Live data
- Freeze-frame data
- Network topology when applicable


----------------------------------------
DIAGNOSTIC CONTINUITY — CONTEXT LOCK (CRITICAL)
----------------------------------------

Once a diagnostic path is started, you MUST maintain continuity.

If you instruct the user to test, inspect, or measure a specific component:
- You must assume all follow-up questions refer to that SAME component
- You must NOT switch systems, components, or circuits unless the user explicitly asks to change focus

If the user asks a follow-up such as:
- "Which pins?"
- "What should I see?"
- "Is that normal?"
- "What resistance should it be?"

You MUST:
- Reference the exact component previously discussed
- Stay on the same harness, connector, and system
- Continue the diagnostic flow without resetting or redirecting

You MUST NOT:
- Jump to a different system (e.g., fuel tank instead of DEF tank)
- Restart diagnostics from a high-level explanation
- Assume the user changed topics without explicit instruction

If ambiguity exists:
- Ask ONE clarifying question
- Do NOT guess or redirect

----------------------------------------
COMPONENT MEMORY RULE
----------------------------------------

You must internally track:
- Current system under test
- Current component under test
- Current test being performed

Until the test is completed or results are given, that component remains the active context.

----------------------------------------
ANTI-RESET RULE
----------------------------------------

You must NEVER forget or override a test you instructed in the immediately previous message.

If a contradiction would occur:
- Pause
- Acknowledge the prior step
- Correct yourself explicitly

Example:
"Staying on the DEF tank heater circuit we discussed..."

----------------------------------------

DIAGNOSTIC GUARDRAIL — VEHICLE REQUIRED BEFORE CODE ANALYSIS

If the user provides any diagnostic trouble code (DTC) and vehicle context is missing or incomplete (year, make, model, engine):

• DO NOT begin diagnostics
• DO NOT assume vehicle details
• DO NOT provide test steps or likely causes

Instead, respond immediately with:

1) Acknowledge the code
2) Explain that diagnostics vary by vehicle
3) Request the required vehicle information before proceeding

Required vehicle info:
• Year
• Make
• Model
• Engine (or engine code if applicable)

Once vehicle information is provided, resume diagnostics from the beginning using the confirmed vehicle context.


END OF RULESET — DO NOT DEVIATE
`;

// ------------------------------------------------------
// ENGINE MAP — fallback inference
// ------------------------------------------------------
const ENGINE_MAP = {
  "2013|Chevrolet|Tahoe": "5.3L V8",
  "2013|Chevy|Tahoe": "5.3L V8"
};

// ------------------------------------------------------
// GM ENGINE CLASSIFICATION LOGIC
// ------------------------------------------------------
function classifyGMEngine(engineModelRaw, displacementLRaw) {
  if (!engineModelRaw) return null;

  const code = String(engineModelRaw).trim().toUpperCase();
  const disp = displacementLRaw ? String(displacementLRaw) : "";

  let generation = "";
  let hasAFM = false;
  let isDI = false;
  let notes = "";

  switch (code) {
    case "LC9":
    case "LH6":
    case "L59":
    case "L76":
    case "L77":
      generation = "Gen IV";
      hasAFM = true;
      notes = "Gen IV AFM — common AFM lifter/VLOM failures.";
      break;

    case "LMG":
    case "LY5":
      generation = "Gen IV";
      hasAFM = false;
      notes = "Gen IV non-AFM.";
      break;

    case "L83":
      generation = "Gen V";
      hasAFM = true;
      isDI = true;
      notes = "Gen V DI AFM — injector, AFM lifter, HPFP failures.";
      break;

    case "L86":
    case "L94":
      generation = "Gen V";
      hasAFM = true;
      isDI = true;
      notes = "Gen V DI AFM 6.2L — injector & AFM issues.";
      break;

    case "L96":
      generation = "Gen IV";
      hasAFM = false;
      notes = "6.0 HD work engine.";
      break;

    case "L92":
    case "L9H":
      generation = "Gen IV";
      notes = "6.2 non-AFM.";
      break;

    default:
      return {
        code,
        generation: "",
        displacement_l: disp,
        has_afm: false,
        is_direct_injected: false,
        notes: ""
      };
  }

  return {
    code,
    generation,
    displacement_l: disp,
    has_afm: hasAFM,
    is_direct_injected: isDI,
    notes
  };
}

// ------------------------------------------------------
// ENGINE STRING INFERENCE
// ------------------------------------------------------
function inferEngineStringFromYMM(vehicle) {
  if (vehicle.engine) return vehicle.engine;

  const key = `${vehicle.year}|${vehicle.make}|${vehicle.model}`;
  return ENGINE_MAP[key] || "";
}

// ------------------------------------------------------
// MERGE VEHICLE CONTEXT
// ------------------------------------------------------
function mergeVehicleContexts(existing = {}, incoming = {}) {
  return {
    vin: incoming.vin || existing.vin || "",
    year: incoming.year || existing.year || "",
    make: incoming.make || existing.make || "",
    model: incoming.model || existing.model || "",
    engine: incoming.engine || existing.engine || "",
    engineDetails: {
      ...(existing.engineDetails || {}),
      ...(incoming.engineDetails || {})
    }
  };
}

// ------------------------------------------------------
// Extract YMM from user text
// ------------------------------------------------------
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

// ------------------------------------------------------
// QUICK SHORT-GRIT RESPONSE (when appropriate)
// ------------------------------------------------------
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

// ------------------------------------------------------
// VIN DECODE (with Supabase cache)
// ------------------------------------------------------
async function decodeVinWithCache(vinRaw) {
  const vin = vinRaw.trim().toUpperCase();

  const { data } = await supabase
    .from("vin_decodes")
    .select("*")
    .eq("vin", vin)
    .maybeSingle();

  if (data) {
    return {
      vin,
      year: data.year,
      make: data.make,
      model: data.model,
      engine: data.engine,
      engineDetails: data.engine_details
    };
  }

  const resp = await fetch(
    `https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVin/${vin}?format=json`
  );
  const json = await resp.json();
  const results = json.Results;

  const get = (label) => {
    const row = results.find((r) => r.Variable === label);
    return row?.Value && row.Value !== "Not Applicable" ? row.Value : "";
  };

  const year = get("Model Year");
  const make = get("Make");
  const model = get("Model");
  const engineModel = get("Engine Model");
  const disp = get("Displacement (L)");

  const engineDetails = classifyGMEngine(engineModel, disp);

  const decoded = {
    vin,
    year,
    make,
    model,
    engine: engineDetails?.code
      ? `${engineDetails.displacement_l}L ${engineDetails.code}`
      : engineModel || disp || "",
    engineDetails
  };

  await supabase.from("vin_decodes").upsert({
    vin,
    year,
    make,
    model,
    engine: decoded.engine,
    engine_details: engineDetails,
    raw: results
  });

  return decoded;
}

// ------------------------------------------------------
// DIAGNOSTIC STATE (v1 — in-memory, MVP-safe)
// ------------------------------------------------------
let diagnosticState = {
  mode: "idle",            // "idle" | "active"
  lastStep: null,          // e.g. "awaiting_test_result"
  expectedTest: null,      // 👈 ADD THIS
  awaitingResponse: false
};


// ------------------------------------------------------
// DIAGNOSTIC STEP MAP (MVP v1)
// ------------------------------------------------------
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



// ------------------------------------------------------
// POST /decode-vin
// ------------------------------------------------------
app.post("/decode-vin", async (req, res) => {
  try {
    const decoded = await decodeVinWithCache(req.body.vin);
    let merged = mergeVehicleContexts(req.body.vehicleContext, decoded);
    merged.engine = inferEngineStringFromYMM(merged);

diagnosticState = {
  mode: "idle",
  lastStep: null,
  expectedTest: null,  
  awaitingResponse: false
};


res.json({ vehicle: merged });


  } catch {
    res.status(500).json({ error: "VIN decode error" });
  }
});

// ------------------------------------------------------
// POST /chat
// ------------------------------------------------------

function classifyTechResponse(message) {
  const m = message.toLowerCase().trim();

  // ✅ PASS / COMPLETED
  if (
 /(^|\b)(pass|passed|good|ok|okay|normal|yes|done|checked|tested|looks good|seems fine|within spec|verified|confirmed)(\b|$)/i.test(m)

  ) {
    return "pass";
  }

if (
  diagnosticState.awaitingResponse &&
  /(checked|measured|found|showed|reading|was|were)/i.test(m) &&
  /(oil|carbon|crack|fouled|burnt|worn|gap|resistance|voltage)/i.test(m)
) {
  return "pass";
}


  // ❌ FAIL / NOT DONE
  if (
  /(^|\b)(fail|failed|bad|no|nope|nah|negative|zero|not yet|not done|did not|didn't|haven't|have not|haven't checked|haven't tested|haven't verified|not checked|not tested|not sure yet|don't know yet|idk yet)(\b|$)/i.test(m)

  ) {
    return "fail";
  }

  // 🤷 Ambiguous → do nothing
  return null;
}



app.post("/chat", async (req, res) => {
  try {
    const { message, context, vehicleContext } = req.body;
    const lower = message.toLowerCase();


// 1️⃣ Handle tech confirmation + branching
if (diagnosticState.awaitingResponse && diagnosticState.lastStep) {


  const result = classifyTechResponse(message);

if (result && DIAGNOSTIC_STEPS[diagnosticState.lastStep]) {
  diagnosticState.lastStep =
    DIAGNOSTIC_STEPS[diagnosticState.lastStep][result] || null;

  diagnosticState.awaitingResponse = false;
  diagnosticState.expectedTest = null;

  // 🧠 Acknowledge test completion
if (Array.isArray(context)) {
  context.push({
    role: "system",
    content: "Previous diagnostic test confirmed. Proceeding logically."
  });

}
}
}





// 2️⃣ Enter diagnostic mode
if (
  /\b(p0|p1|u0|b0|c0)\d{3}\b/i.test(message) ||
  lower.includes("check engine") ||
  lower.includes("diagnose")
) {
  diagnosticState.mode = "active";

  // Initialize diagnostic flow only once
  if (!diagnosticState.lastStep) {
    diagnosticState.lastStep = "awaiting_test_result";
  }
}

// 🚨 NO-START FIRST-STEP GATE (CRITICAL)
if (
  diagnosticState.mode === "active" &&
  !diagnosticState.lastStep &&
  /no start/i.test(message)
) {
  diagnosticState.lastStep = "classify_crank";
  diagnosticState.awaitingResponse = true;

  return res.json({
    reply:
      "Before any testing, we must classify the failure.\n\n" +
      "When you turn the key:\n" +
      "1) Does the engine crank (turn over) but not start?\n" +
      "OR\n" +
      "2) Is it a no-crank condition (starter does not engage)?\n\n" +
      "Reply with ONLY one.",
    vehicle: mergeVehicleContexts(vehicleContext, {})
  });
}


// 🚨 OVERHEATING FIRST-STEP GATE (CRITICAL)
if (
  diagnosticState.mode === "active" &&
  !diagnosticState.lastStep &&
  /overheat|overheating|running hot|temp gauge/i.test(message)
) {
  diagnosticState.lastStep = "classify_overheat";
  diagnosticState.awaitingResponse = true;

  return res.json({
    reply:
      "Before testing anything, we must classify the overheating condition.\n\n" +
      "Which best describes it?\n\n" +
      "1) Overheats at idle / stopped\n" +
      "2) Overheats while driving\n" +
      "3) Overheats only at highway speeds or under load\n" +
      "4) Pegs hot very quickly after startup\n" +
      "5) Gauge reads hot but no boil-over or coolant loss\n\n" +
      "Reply with ONLY the number that fits best.",
    vehicle: mergeVehicleContexts(vehicleContext, {})
  });
}

// 🚨 MISFIRE FIRST-STEP GATE
if (
  diagnosticState.mode === "active" &&
  !diagnosticState.lastStep &&
  /misfire|misfiring|rough idle|shaking/i.test(message)
) {
  diagnosticState.lastStep = "classify_misfire";
  diagnosticState.awaitingResponse = true;

  return res.json({
    reply:
      "Before testing anything, classify the misfire.\n\n" +
      "Answer BOTH:\n\n" +
      "1) Is it a SINGLE cylinder misfire or MULTIPLE/random?\n" +
      "2) Does it occur at idle, under load, cold, or hot?\n\n" +
      "Reply briefly.",
    vehicle: mergeVehicleContexts(vehicleContext, {})
  });
}


// 🚨 LEAN CONDITION FIRST-STEP GATE
if (
  diagnosticState.mode === "active" &&
  !diagnosticState.lastStep &&
  /(p0171|p0174|lean condition|running lean)/i.test(message)
) {
  diagnosticState.lastStep = "classify_lean";
  diagnosticState.awaitingResponse = true;

  return res.json({
    reply:
      "Before testing anything, classify the lean condition.\n\n" +
      "Which applies?\n\n" +
      "1) Bank 1 only\n" +
      "2) Bank 2 only\n" +
      "3) Both banks\n\n" +
      "Reply with ONLY the number.",
    vehicle: mergeVehicleContexts(vehicleContext, {})
  });
}

// 🚨 EVAP FIRST-STEP GATE
if (
  diagnosticState.mode === "active" &&
  !diagnosticState.lastStep &&
  /(evap|p04|large leak|small leak|purge|vent)/i.test(message)
) {
  diagnosticState.lastStep = "classify_evap";
  diagnosticState.awaitingResponse = true;

  return res.json({
    reply:
      "Before diagnosing EVAP, classify the fault.\n\n" +
      "Which best fits?\n\n" +
      "1) Large leak\n" +
      "2) Small leak\n" +
      "3) Purge or vent performance\n\n" +
      "Reply with ONLY the number.",
    vehicle: mergeVehicleContexts(vehicleContext, {})
  });
}


// 🚨 CHARGING SYSTEM FIRST-STEP GATE
if (
  diagnosticState.mode === "active" &&
  !diagnosticState.lastStep &&
  /(battery light|charging system|alternator|overcharging|no charge|low voltage)/i.test(message)
) {
  diagnosticState.lastStep = "classify_charging";
  diagnosticState.awaitingResponse = true;

  return res.json({
    reply:
      "Before testing the charging system, classify the issue.\n\n" +
      "Which applies?\n\n" +
      "1) Battery light on\n" +
      "2) Dead battery repeatedly\n" +
      "3) Confirmed no-charge condition\n" +
      "4) Voltage over 15V\n\n" +
      "Reply with ONLY the number.",
    vehicle: mergeVehicleContexts(vehicleContext, {})
  });
}


// 🚨 NETWORK / U-CODE FIRST-STEP GATE
if (
  diagnosticState.mode === "active" &&
  !diagnosticState.lastStep &&
  /(u0|u1|lost communication|network code|can bus)/i.test(message)
) {
  diagnosticState.lastStep = "classify_network";
  diagnosticState.awaitingResponse = true;

  return res.json({
    reply:
      "Before diagnosing network faults, classify the scope.\n\n" +
      "Which applies?\n\n" +
      "1) Single module reporting loss of communication\n" +
      "2) Multiple modules reporting communication faults\n\n" +
      "Reply with ONLY the number.",
    vehicle: mergeVehicleContexts(vehicleContext, {})
  });
}

// 🚨 NOISE FIRST-STEP GATE
if (
  diagnosticState.mode === "active" &&
  !diagnosticState.lastStep &&
  /(noise|rattle|knock|clunk|whine|grinding|squeal)/i.test(message)
) {
  diagnosticState.lastStep = "classify_noise";
  diagnosticState.awaitingResponse = true;

  return res.json({
    reply:
      "Before diagnosing noise, classify it.\n\n" +
      "What best describes it?\n\n" +
      "1) Engine internal\n" +
      "2) Accessory / belt\n" +
      "3) Suspension / steering\n" +
      "4) Drivetrain\n" +
      "5) Brakes\n\n" +
      "Reply with ONLY the number.",
    vehicle: mergeVehicleContexts(vehicleContext, {})
  });
}


// 🚨 BRAKE FIRST-STEP GATE
if (
  diagnosticState.mode === "active" &&
  !diagnosticState.lastStep &&
  /(brake|abs|pedal|grinding|pulling|soft pedal|hard pedal)/i.test(message)
) {
  diagnosticState.lastStep = "classify_brakes";
  diagnosticState.awaitingResponse = true;

  return res.json({
    reply:
      "Before diagnosing brakes, classify the complaint.\n\n" +
      "Which applies?\n\n" +
      "1) Pedal feel issue\n" +
      "2) Noise\n" +
      "3) Warning light (ABS / brake)\n\n" +
      "Reply with ONLY the number.",
    vehicle: mergeVehicleContexts(vehicleContext, {})
  });
}

// 🚨 TRANSMISSION / DRIVABILITY FIRST-STEP GATE
if (
  diagnosticState.mode === "active" &&
  !diagnosticState.lastStep &&
  /(transmission|slipping|harsh shift|no movement|delayed engagement|won't shift)/i.test(message)
) {
  diagnosticState.lastStep = "classify_transmission";
  diagnosticState.awaitingResponse = true;

  return res.json({
    reply:
      "Before diagnosing transmission issues, classify the symptom.\n\n" +
      "Which applies?\n\n" +
      "1) Harsh or delayed shifts\n" +
      "2) Slipping\n" +
      "3) No movement\n" +
      "4) Delayed engagement\n\n" +
      "Reply with ONLY the number.",
    vehicle: mergeVehicleContexts(vehicleContext, {})
  });
}







    // 3️⃣ Vehicle extraction
    const extracted = await extractVehicleFromText(message);
    let mergedVehicle = mergeVehicleContexts(vehicleContext, extracted);
    mergedVehicle.engine = inferEngineStringFromYMM(mergedVehicle);






    // 4️⃣ Short-circuit replies
const quick =
  diagnosticState.mode !== "active"
    ? buildGritResponse(message, mergedVehicle)
    : null;

if (quick) {
  return res.json({ reply: quick, vehicle: mergedVehicle });
}


    // 5️⃣ Diagnostic behavior rules
  let diagnosticInstructions = "";
if (diagnosticState.mode === "active") {
diagnosticInstructions = `
DIAGNOSTIC MODE ACTIVE:
- Provide ONLY ONE test or check per message
- End every response with a direct question
- Wait for user confirmation before continuing

- If the condition is "no start", the FIRST response must ONLY classify crank vs no-crank.
- Do NOT list tests, procedures, or causes until classification is confirmed.

- If the condition is overheating, the FIRST response must ONLY classify WHEN it overheats.
- Do NOT list causes or tests until classification is confirmed.

- Certain conditions REQUIRE classification before testing (no-start, overheating, misfire, lean, EVAP, charging, network, noise, brakes, transmission).
- If classification is required, do NOT list tests, causes, or procedures.


- Current diagnostic step: ${diagnosticState.lastStep || "initial"}
`;

}

// 🧠 Detect GRIT-issued test prompts (bind intent from GRIT, not user)
const lastAssistantMessage =
  context?.length
    ? context[context.length - 1]?.content || ""
    : "";

if (
  diagnosticState.mode === "active" &&
  !diagnosticState.awaitingResponse &&
  !diagnosticState.expectedTest
) {
  if (/exhaust leak/i.test(lastAssistantMessage)) {
    diagnosticState.expectedTest = "exhaust_leak_check";
  }

  if (/vacuum leak/i.test(lastAssistantMessage)) {
    diagnosticState.expectedTest = "vacuum_leak_check";
  }

  if (/fuel pressure/i.test(lastAssistantMessage)) {
    diagnosticState.expectedTest = "fuel_pressure_test";
  }

  if (/o2 sensor|oxygen sensor/i.test(lastAssistantMessage)) {
    diagnosticState.expectedTest = "o2_sensor_check";
  }
}




// 🚫 Prevent diagnostic drift between systems

if (
  diagnosticState.awaitingResponse &&
  diagnosticState.expectedTest === "exhaust_leak_check" &&
  /vacuum/i.test(message)
) {
  return res.json({
    reply:
      "Hold up — we are still verifying the exhaust system. Vacuum leaks come later.\n\nConfirm again: do you hear or feel ANY exhaust leak upstream of the catalytic converter?",
    vehicle: mergedVehicle
  });
}




    // 6️⃣ AI response
    const ai = await openai.chat.completions.create({
      model: "gpt-4.1",
      temperature: 0.3,
      messages: [
        {
          role: "system",
          content: `
You are GRIT — a ruthless diagnostic mentor.

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

// 7️⃣ Only lock waiting state when a diagnostic step exists
if (diagnosticState.mode === "active" && diagnosticState.lastStep) {
  diagnosticState.awaitingResponse = true;
}


    res.json({
      reply: ai.choices[0].message.content,
      vehicle: mergedVehicle
    });

  } catch (err) {
    res.status(500).json({ error: "Chat error" });
  }
});


// ------------------------------------------------------
// POST /diagnostic-tree
// ------------------------------------------------------
app.post("/diagnostic-tree", async (req, res) => {
  try {
    const { message, vehicleContext } = req.body;

    let mergedVehicle = mergeVehicleContexts(vehicleContext, {});
    mergedVehicle.engine = inferEngineStringFromYMM(mergedVehicle);

    const systemPrompt = `
Return ONLY valid JSON:
{
  "symptom_summary": "",
  "likely_causes": [
    { "cause": "", "confidence": 0.0, "notes": "" }
  ],
  "tests": [
    { "test": "", "why": "", "how": "", "tools": "" }
  ],
  "branching_logic": [
    { "if": "", "next": "" }
  ],
  "red_flags": [],
  "recommended_next_steps": []
}`;

    const ai = await openai.chat.completions.create({
      model: "gpt-4.1",
      temperature: 0.2,
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "system",
          content: `Vehicle: ${JSON.stringify(mergedVehicle)}`
        },
        { role: "user", content: message }
      ]
    });

    let json;
    try {
      json = JSON.parse(ai.choices[0].message.content);
    } catch {
      return res.status(500).json({
        error: "Invalid JSON",
        raw: ai.choices[0].message.content
      });
    }

    res.json({ vehicle: mergedVehicle, tree: json });
  } catch {
    res.status(500).json({ error: "Diagnostic tree error" });
  }
});

// ------------------------------------------------------
// POST /send-feedback
// ------------------------------------------------------

app.post("/send-feedback", async (req, res) => {
  try {
    const { feedback } = req.body;

    if (!feedback || !feedback.trim()) {
      return res.status(400).json({ error: "Feedback required" });
    }

    await resend.emails.send({
      from: "AutoBrain Feedback <support@autobrain-ai.com>",
      to: ["support@autobrain-ai.com"],
      subject: "New AutoBrain GRIT Feedback",
      html: `
        <h2>Technician Feedback Submitted</h2>
        <p>${feedback.replace(/\n/g, "<br>")}</p>
      `
    });

    res.json({ status: "ok" });
  } catch (err) {
    console.error("Feedback email failed:", err);
    res.status(500).json({ error: "Email send failed" });
  }
});


// ------------------------------------------------------
// RESET DIAGNOSTIC STATE
// ------------------------------------------------------
app.post("/reset-diagnostic", (req, res) => {
  diagnosticState = {
    mode: "idle",
    lastStep: null,
expectedTest: null, 
    awaitingResponse: false
  };

  res.json({ status: "diagnostic_state_reset" });
});


// ------------------------------------------------------
// HEALTH CHECK
// ------------------------------------------------------
app.get("/", (req, res) => {
  res.send("AutoBrain / GRIT backend running (Ruleset v2)");
});

// ------------------------------------------------------
// START SERVER
// ------------------------------------------------------
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
