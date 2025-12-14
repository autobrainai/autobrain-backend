// ===========================================================
// AUTO BRAIN — GRIT BACKEND (LOCKED DIAGNOSTIC CONTRACT v1.0)
// ===========================================================

import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";

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
// 🔒 GRIT SYSTEM PROMPT — NON-NEGOTIABLE
// ------------------------------------------------------
const GRIT_SYSTEM_PROMPT = `
You are GRIT, an ASE Master-level automotive diagnostic technician.

CORE RULES:
- Never diagnose without full vehicle context (year, make, model, engine).
- Never diagnose based on a code alone.
- Never recommend parts without confirmation testing.
- If required information is missing, STOP and ask for it.
- Diagnose systems, not parts.
- Rank causes by likelihood.
- Explain why each test matters.
- Use calibrated language only.

MANDATORY OUTPUT STRUCTURE:
1. System overview
2. Symptom interpretation
3. Likely causes (ranked)
4. Diagnostic tests
5. Decision path

If diagnosis would be unreliable:
Respond exactly with:
"Based on the information available, a reliable diagnosis cannot be made yet."
`;

// ------------------------------------------------------
// ENGINE MAP (Fallback)
// ------------------------------------------------------
const ENGINE_MAP = {
  "2013|Chevrolet|Tahoe": "5.3L V8",
  "2013|Chevy|Tahoe": "5.3L V8"
};

// ------------------------------------------------------
// GM ENGINE CLASSIFICATION
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
      notes = "Gen IV AFM — common lifter/VLOM failures.";
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
      notes = "Gen V DI AFM 6.2L.";
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
// QUICK SHORT RESPONSE (NO DIAGNOSIS)
// ------------------------------------------------------
function buildShortResponse(msg, v) {
  const short = msg.trim().split(/\s+/).length <= 6;
  if (!short) return null;

  if (!v.year || !v.make || !v.model) {
    return "Vehicle info first. Year, make, model, engine.";
  }

  return `A ${v.year} ${v.make} ${v.model}. Noted.
But what’s it *doing*?

Codes?
Symptoms?
Mileage?

I won’t guess.`;
}

// ------------------------------------------------------
// VIN DECODE (Cached)
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

  const get = (label) =>
    results.find((r) => r.Variable === label)?.Value || "";

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
// POST /chat  🔒 LOCKED GRIT
// ------------------------------------------------------
app.post("/chat", async (req, res) => {
  try {
    const { message, vehicleContext } = req.body;

    let mergedVehicle = mergeVehicleContexts(vehicleContext, {});
    mergedVehicle.engine = inferEngineStringFromYMM(mergedVehicle);

    const quick = buildShortResponse(message, mergedVehicle);
    if (quick) {
      return res.json({ reply: quick, vehicle: mergedVehicle });
    }

    const ai = await openai.chat.completions.create({
      model: "gpt-4.1",
      temperature: 0.2,
      messages: [
        {
          role: "system",
          content: `
${GRIT_SYSTEM_PROMPT}

Vehicle Context:
${JSON.stringify(mergedVehicle)}
`
        },
        { role: "user", content: message }
      ]
    });

    res.json({
      reply: ai.choices[0].message.content,
      vehicle: mergedVehicle
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Chat error" });
  }
});

// ------------------------------------------------------
// POST /send-feedback
// ------------------------------------------------------
app.post("/send-feedback", async (req, res) => {
  res.status(503).json({
    error: "Feedback temporarily disabled. Coming back soon."
  });
});


// ------------------------------------------------------
// HEALTH CHECK
// ------------------------------------------------------
app.get("/", (_, res) => {
  res.send("AutoBrain GRIT backend running — LOCKED v1.0");
});

// ------------------------------------------------------
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
