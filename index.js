import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fetch from "node-fetch"; // required for NHTSA API
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// ------------------------------------------------------
// Supabase Client
// ------------------------------------------------------
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ------------------------------------------------------
// OpenAI Client
// ------------------------------------------------------
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ------------------------------------------------------
// ENGINE INFERENCE MAP (fallback based on Y/M/M only)
// ------------------------------------------------------
const ENGINE_MAP = {
  "2013|Chevrolet|Tahoe": "5.3L V8",
  "2013|Chevy|Tahoe": "5.3L V8",
};

// ------------------------------------------------------
// GM ENGINE CLASSIFICATION FROM ENGINE MODEL (RPO)
// ------------------------------------------------------
function classifyGMEngine(engineModelRaw, displacementLRaw) {
  if (!engineModelRaw) return null;

  const code = String(engineModelRaw).trim().toUpperCase();
  const displacementL = displacementLRaw ? String(displacementLRaw) : "";

  // Defaults
  let generation = "";
  let hasAFM = false;
  let isDirectInjected = false;
  let notes = "";

  switch (code) {
    // ---------------- Gen IV 5.3 AFM ----------------
    case "LC9":
    case "LH6":
    case "L59":
    case "L76":
    case "L77":
      generation = "Gen IV";
      hasAFM = true;
      isDirectInjected = false;
      notes =
        "5.3L Gen IV with Active Fuel Management. Known for AFM lifter and VLOM issues, especially on cylinders 1,4,6,7.";
      break;

    // ---------------- Gen IV 5.3 non-AFM -------------
    case "LMG":
    case "LY5":
      generation = "Gen IV";
      hasAFM = false;
      isDirectInjected = false;
      notes =
        "5.3L Gen IV non-AFM. AFM lifter failures less of a concern; focus more on ignition, fuel, and mechanical.";
      break;

    // ---------------- Gen V 5.3 DI AFM ---------------
    case "L83":
      generation = "Gen V";
      hasAFM = true;
      isDirectInjected = true;
      notes =
        "5.3L Gen V direct-injected with AFM. Pay attention to injector balance, HPFP, carbon buildup, and AFM lifters.";
      break;

    // ---------------- Gen V 6.2 DI AFM ---------------
    case "L86":
    case "L94":
      generation = "Gen V";
      hasAFM = true;
      isDirectInjected = true;
      notes =
        "6.2L Gen V DI with AFM. Known for AFM lifter issues, DI injector balance problems, and HPFP/low-side fuel issues.";
      break;

    // ---------------- 6.0 HD / others ----------------
    case "L96":
      generation = "Gen IV";
      hasAFM = false;
      isDirectInjected = false;
      notes =
        "6.0L HD (iron block). No AFM. Common issues: ignition coils, plug wires, exhaust leaks, and work-truck abuse.";
      break;

    case "L92":
    case "L9H":
      generation = "Gen IV";
      hasAFM = false;
      isDirectInjected = false;
      notes =
        "6.2L Gen IV non-AFM. Focus more on ignition and mechanical checks than AFM.";
      break;

    default:
      generation = "";
      hasAFM = false;
      isDirectInjected = false;
      notes = "";
      break;
  }

  if (!generation && !notes) {
    // Unknown / unclassified engine code
    return {
      code,
      generation: "",
      displacement_l: displacementL,
      has_afm: false,
      is_direct_injected: false,
      notes: "",
    };
  }

  return {
    code,
    generation,
    displacement_l: displacementL,
    has_afm: hasAFM,
    is_direct_injected: isDirectInjected,
    notes,
  };
}

// ------------------------------------------------------
// ENGINE STRING INFERENCE (using ENGINE_MAP fallback)
// ------------------------------------------------------
function inferEngineStringFromYMM(vehicle) {
  if (vehicle.engine && vehicle.engine.trim() !== "") return vehicle.engine;

  const key = `${vehicle.year || ""}|${vehicle.make || ""}|${vehicle.model || ""}`;
  const inferred = ENGINE_MAP[key];
  return inferred || vehicle.engine || "";
}

// ------------------------------------------------------
// MERGE VEHICLE CONTEXT (includes engineDetails)
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
      ...(incoming.engineDetails || {}),
    },
  };
}

// ------------------------------------------------------
// EXTRACT VEHICLE DATA FROM USER TEXT
// ------------------------------------------------------
async function extractVehicleFromText(message) {
  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [
        {
          role: "system",
          content: `
Extract structured vehicle data from ANY user message.
Return ONLY valid JSON:

{
  "year": "",
  "make": "",
  "model": "",
  "engine": ""
}

Unknown fields -> empty string.
`,
        },
        { role: "user", content: message },
      ],
      temperature: 0,
    });

    return JSON.parse(response.choices[0].message.content || "{}");
  } catch (err) {
    console.error("Vehicle extraction error:", err);
    return { year: "", make: "", model: "", engine: "" };
  }
}

// ------------------------------------------------------
// GRIT OPTION A: VEHICLE-ONLY RESPONSE
// ------------------------------------------------------
function buildGritResponse(userMessage, v) {
  const lower = userMessage.toLowerCase();

  const hasSymptoms =
    lower.includes("code") ||
    lower.includes("p0") ||
    lower.includes("light") ||
    lower.includes("noise") ||
    lower.includes("knock") ||
    lower.includes("misfir") ||
    lower.includes("stall") ||
    lower.includes("no start") ||
    lower.includes("won't start") ||
    lower.includes("overheat") ||
    lower.includes("smoke");

  const short = userMessage.trim().split(/\s+/).length <= 6;
  const hasVehicle = v.year || v.make || v.model;

  if (!hasVehicle || hasSymptoms || !short) return null;

  return `
A ${v.year} ${v.make} ${v.model} — got it.
But that’s the *vehicle*, not the problem.

What’s it actually doing?
Any warning lights, codes, misfires, no-start, noises, stalling — what’s the complaint?
What’s the mileage?
Has anything been checked or replaced already?

The more detail you give me, the tighter the diagnostic plan.
Right now, I’m working with a silhouette — give me the picture.
`;
}

// ------------------------------------------------------
// VIN DECODE WITH SUPABASE CACHE + NHTSA API
// ------------------------------------------------------
async function decodeVinWithCache(rawVin) {
  const vin = rawVin.trim().toUpperCase();
  if (!vin || vin.length < 11) {
    throw new Error("VIN must be at least 11 characters.");
  }

  // 1) Try cache first
  const { data } = await supabase
    .from("vin_decodes")
    .select("*")
    .eq("vin", vin)
    .maybeSingle();

  if (data) {
    return {
      vin,
      year: data.year || "",
      make: data.make || "",
      model: data.model || "",
      engine: data.engine || "",
      engineDetails: data.engine_details || {},
    };
  }

  // 2) Hit NHTSA
  const url = `https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVin/${vin}?format=json`;
  const response = await fetch(url);
  const json = await response.json();
  const results = json.Results || [];

  const getValue = (label) => {
    const r = results.find((e) => e.Variable === label);
    if (!r || !r.Value || r.Value === "Not Applicable") return "";
    return String(r.Value);
  };

  const year = getValue("Model Year");
  const make = getValue("Make");
  const model = getValue("Model");
  const engineModel = getValue("Engine Model"); // often contains RPO like L83, L86
  const engineDispL = getValue("Displacement (L)");
  const engineCyl = getValue("Engine Number of Cylinders");
  const engineConfig = getValue("Engine Configuration");

  // Classify GM engine if possible
  let engineDetails = classifyGMEngine(engineModel, engineDispL);

  // Human-friendly engine string
  let engineString = "";
  if (engineDetails && engineDetails.code) {
    const disp = engineDetails.displacement_l || engineDispL;
    const diTag = engineDetails.is_direct_injected ? "DI" : "";
    const afmTag = engineDetails.has_afm ? "AFM" : "";
    const tags = [diTag, afmTag].filter(Boolean).join(" ");
    engineString = `${disp || "Engine"}L ${engineDetails.code}${
      tags ? " " + tags : ""
    }`.trim();
  } else {
    // Fallback if we didn't classify
    if (engineModel) engineString = engineModel;
    else if (engineDispL && engineConfig)
      engineString = `${engineDispL}L ${engineConfig}`;
    else if (engineDispL && engineCyl)
      engineString = `${engineDispL}L ${engineCyl}-cyl`;
    else if (engineDispL) engineString = `${engineDispL}L`;
    else engineString = "";
  }

  const decoded = {
    vin,
    year,
    make,
    model,
    engine: engineString,
    engineDetails: engineDetails || {
      code: engineModel || "",
      displacement_l: engineDispL || "",
      generation: "",
      has_afm: false,
      is_direct_injected: false,
      notes: "",
    },
  };

  // 3) Cache in Supabase (including engineDetails)
  await supabase.from("vin_decodes").upsert({
    vin,
    year,
    make,
    model,
    engine: decoded.engine,
    engine_details: decoded.engineDetails,
    raw: results,
  });

  return decoded;
}

// ------------------------------------------------------
// POST /decode-vin
// ------------------------------------------------------
app.post("/decode-vin", async (req, res) => {
  try {
    const { vin, vehicleContext } = req.body;

    const decoded = await decodeVinWithCache(vin);

    // Merge existing context + decoded data
    let merged = mergeVehicleContexts(vehicleContext, decoded);

    // Ensure engine string is filled if missing
    merged.engine = inferEngineStringFromYMM(merged);

    res.json({ vehicle: merged });
  } catch (err) {
    console.error("VIN decode error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ------------------------------------------------------
// POST /chat — MAIN GRIT ENDPOINT
// ------------------------------------------------------
app.post("/chat", async (req, res) => {
  try {
    const { message, context, vehicleContext } = req.body;

    // Extract from free text
    const extracted = await extractVehicleFromText(message);

    // Merge contexts
    let mergedVehicle = mergeVehicleContexts(vehicleContext, extracted);

    // Fallback engine string if we have YMM but no engine yet
    mergedVehicle.engine = inferEngineStringFromYMM(mergedVehicle);

    // Vehicle-only behavior (Option A tone)
    const gritReply = buildGritResponse(message, mergedVehicle);

    if (gritReply) {
      return res.json({
        reply: gritReply,
        vehicle: mergedVehicle,
      });
    }

    // Full GRIT reasoning (now with engineDetails awareness)
    const aiResponse = await openai.chat.completions.create({
      model: "gpt-4.1",
      messages: [
        {
          role: "system",
          content: `
You are GRIT — a blunt, direct diagnostic mentor for professional automotive technicians.
Tone: Assertive, clear, no fluff, never rude.
Push for data, not guesses.

You receive vehicle context as JSON, which may include:
- vin
- year, make, model
- engine (human-friendly)
- engineDetails: {
    code,              // e.g. L83, LC9, LMG, L96, etc.
    generation,        // e.g. Gen IV, Gen V
    displacement_l,    // e.g. 5.3
    has_afm,           // boolean
    is_direct_injected,// boolean
    notes              // summary of engine characteristics / concerns
  }

Use engineDetails aggressively to:
- Adjust your suspicion list (AFM vs non-AFM, DI vs port injection)
- Decide what tests are highest priority
- Call out known pattern failures (e.g. AFM lifter collapse on Gen IV, DI injector issues on Gen V, carbon buildup).
Respond with tight, technician-focused plans: codes -> data -> tests -> next decisions.
`,
        },
        {
          role: "system",
          content: `Current vehicle context (JSON): ${JSON.stringify(
            mergedVehicle
          )}`,
        },
        ...(Array.isArray(context) ? context : []),
        { role: "user", content: message },
      ],
    });

    res.json({
      reply: aiResponse.choices[0].message.content,
      vehicle: mergedVehicle,
    });
  } catch (err) {
    console.error("Chat endpoint error:", err);
    res.status(500).json({ error: "Chat endpoint failed" });
  }
});

// ------------------------------------------------------
// HEALTH CHECK
// ------------------------------------------------------
app.get("/", (req, res) => {
  res.send("AutoBrain / GRIT backend running");
});

// ------------------------------------------------------
// START SERVER
// ------------------------------------------------------
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
