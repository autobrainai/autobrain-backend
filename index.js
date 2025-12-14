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
- Verify customer is actually experiencing death wobble and not just an unbalanced tire. Two very differen't types of vibrations. (Death wobble is extremely violent).
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
- Vehicles operated in dusty or dirty environments (construction, off-road, fleet use) are highly prone to ESIM contamination.
- In these conditions, charcoal canister contamination is common.

Replacement rules:
- When replacing a failed ESIM on vehicles exposed to dust/debris, strongly consider replacing the charcoal canister at the same time.
- ESIM sensors are extremely sensitive to contamination.

Parts rules:
- ESIM MUST be OEM.
- Aftermarket ESIM units frequently cause repeat failures, false EVAP codes, or failed monitors.

Do NOT:
- Skip ESIM inspection when diagnosing EVAP leaks on these platforms.
- Install aftermarket ESIM components.

EVAP purge valve diagnostics (applies to MOST makes and models):

Fundamental rule:
- EVAP purge valves are normally CLOSED when unplugged.
- Any vacuum present with the valve unplugged = FAILED purge valve.

Ford-specific guidance:
- Ford vehicles have a HIGH failure rate of purge valves across many platforms.
- On Ford products, purge valve failure should be considered one of the FIRST diagnostic checks for EVAP-related faults.
- Cold start rough idle, stalling after refuel, hard starts, or random lean codes on Ford vehicles commonly point to a leaking purge valve.

Base test (no scan tool required):
1. Unplug the electrical connector from the purge valve.
2. Disconnect the hose that runs from the purge valve to the fuel tank.
3. Start the engine and allow it to idle.
4. Place a finger over the purge valve port.

Results interpretation:
- NO vacuum present → purge valve is sealing correctly (normal).
- ANY vacuum present → purge valve is leaking internally and MUST be replaced.

Rules:
- Do NOT assume a purge valve is good just because it clicks.
- A purge valve that leaks when de-energized is FAILED, regardless of codes.

Scan tool verification (preferred when available):
- Use a scan tool to command the purge valve ON and OFF.
- Valve should:
  - Hold vacuum when commanded OFF
  - Flow only when commanded ON

Smoke test guidance:
- During EVAP smoke testing, the purge valve must seal completely when closed.
- A leaking purge valve will prevent proper system pressurization and cause false leak results.

Common mistakes to avoid:
- Do NOT replace gas caps, vent valves, or charcoal canisters before verifying purge valve sealing.
- Do NOT rely solely on EVAP codes without performing this physical test.

Diagnostic priority:
- Purge valve sealing test should be one of the FIRST checks in EVAP-related faults, especially on Ford vehicles.




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
// POST /decode-vin
// ------------------------------------------------------
app.post("/decode-vin", async (req, res) => {
  try {
    const decoded = await decodeVinWithCache(req.body.vin);
    let merged = mergeVehicleContexts(req.body.vehicleContext, decoded);
    merged.engine = inferEngineStringFromYMM(merged);
    res.json({ vehicle: merged });
  } catch {
    res.status(500).json({ error: "VIN decode error" });
  }
});

// ------------------------------------------------------
// POST /chat
// ------------------------------------------------------
app.post("/chat", async (req, res) => {
  try {
    const { message, context, vehicleContext } = req.body;

    const extracted = await extractVehicleFromText(message);
    let mergedVehicle = mergeVehicleContexts(vehicleContext, extracted);
    mergedVehicle.engine = inferEngineStringFromYMM(mergedVehicle);

    // Quick short response
    const quick = buildGritResponse(message, mergedVehicle);
    if (quick) {
      return res.json({ reply: quick, vehicle: mergedVehicle });
    }

    // AI Response with full GRIT RULESET
    const ai = await openai.chat.completions.create({
      model: "gpt-4.1",
      temperature: 0.3,
      messages: [
        {
          role: "system",
          content: `
You are GRIT — a ruthless diagnostic mentor for technicians.
You must strictly follow the rules below:

${GRIT_RULESET}

Vehicle Context:
${JSON.stringify(mergedVehicle)}
`
        },
        ...(context || []),
        { role: "user", content: message }
      ]
    });

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
