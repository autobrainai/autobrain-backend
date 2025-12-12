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
// Helper: engine inference map (expand as needed)
// ------------------------------------------------------
const ENGINE_MAP = {
  // key format: "year|make|model"
  "2013|Chevrolet|Tahoe": "5.3L V8",
  "2013|Chevy|Tahoe": "5.3L V8",
  // add more common combos here
};

function inferEngine(vehicle) {
  if (vehicle.engine && vehicle.engine.trim() !== "") return vehicle;

  const key = `${vehicle.year || ""}|${vehicle.make || ""}|${vehicle.model || ""}`;
  const inferred = ENGINE_MAP[key];

  if (inferred) {
    return {
      ...vehicle,
      engine: inferred,
    };
  }

  return vehicle;
}

// ------------------------------------------------------
// Helper: merge existing vehicle context with new data
// (keeps values that already exist, fills blanks with new)
// ------------------------------------------------------
function mergeVehicleContexts(existing = {}, incoming = {}) {
  return {
    vin: incoming.vin || existing.vin || "",
    year: incoming.year || existing.year || "",
    make: incoming.make || existing.make || "",
    model: incoming.model || existing.model || "",
    engine: incoming.engine || existing.engine || "",
  };
}

// ------------------------------------------------------
// Utility — Extract Year / Make / Model / Engine from text
// ------------------------------------------------------
async function extractVehicleFromText(message) {
  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [
        {
          role: "system",
          content: `
You extract structured vehicle data from ANY user text.
Return ONLY a JSON object with these keys:

{
  "year": "",
  "make": "",
  "model": "",
  "engine": ""
}

- "year" is the 4-digit model year if present, otherwise "".
- "make" is the manufacturer (Chevrolet, Ford, Honda, etc.).
- "model" is the model name (Tahoe, F-150, Accord, etc.).
- "engine" includes displacement and/or key descriptor if clearly stated (e.g., "5.3L", "3.5L EcoBoost").

If any field cannot be determined, return an empty string for that field.
Respond ONLY with valid JSON — no explanation.
`
        },
        {
          role: "user",
          content: message,
        },
      ],
      temperature: 0,
    });

    const raw = response.choices[0].message.content;
    return JSON.parse(raw);
  } catch (err) {
    console.error("Vehicle extraction error:", err);
    return {
      year: "",
      make: "",
      model: "",
      engine: "",
    };
  }
}

// ------------------------------------------------------
// GRIT Tone Response (Option A)
// Triggered when user only gives year/make/model with no symptoms
// ------------------------------------------------------
function buildGritResponse(userMessage, vehicleDataProvided) {
  const lower = userMessage.toLowerCase();

  const clearlyHasSymptoms =
    lower.includes("code") ||
    lower.includes("p0") ||
    lower.includes("light") ||
    lower.includes("noise") ||
    lower.includes("knock") ||
    lower.includes("misfir") ||
    lower.includes("stall") ||
    lower.includes("no start") ||
    lower.includes("no-start") ||
    lower.includes("won't start") ||
    lower.includes("smoke") ||
    lower.includes("overheat");

  const shortMessage = userMessage.trim().split(/\s+/).length <= 6;

  const hasBasicVehicle =
    vehicleDataProvided.year ||
    vehicleDataProvided.make ||
    vehicleDataProvided.model;

  const containsVehicleOnly =
    hasBasicVehicle && !clearlyHasSymptoms && shortMessage;

  if (!containsVehicleOnly) return null;

  const year = vehicleDataProvided.year || "";
  const make = vehicleDataProvided.make || "";
  const model = vehicleDataProvided.model || "";

  return `
A ${year} ${make} ${model} — got it.
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
// VIN Decode Helper (with Supabase cache + NHTSA fallback)
// ------------------------------------------------------
async function decodeVinWithCache(rawVin) {
  const vin = rawVin.trim().toUpperCase();

  if (!vin || vin.length < 11) {
    throw new Error("VIN must be at least 11 characters.");
  }

  // 1) Try Supabase cache first
  try {
    const { data, error } = await supabase
      .from("vin_decodes")
      .select("*")
      .eq("vin", vin)
      .maybeSingle();

    if (error) {
      console.error("Supabase VIN cache read error:", error);
    }

    if (data) {
      return {
        vin: data.vin,
        year: data.year || "",
        make: data.make || "",
        model: data.model || "",
        engine: data.engine || "",
      };
    }
  } catch (err) {
    console.error("VIN cache lookup failed:", err);
  }

  // 2) Decode via NHTSA
  const url = `https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVin/${vin}?format=json`;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error("NHTSA VIN API request failed.");
  }

  const json = await response.json();
  const results = json.Results || [];

  const getValue = (label) => {
    const row = results.find((r) => r.Variable === label);
    if (!row || !row.Value || row.Value === "Not Applicable") return "";
    return String(row.Value);
  };

  const year = getValue("Model Year");
  const make = getValue("Make");
  const model = getValue("Model");
  const engineModel = getValue("Engine Model");
  const engineConfig = getValue("Engine Configuration");
  const engineDispL = getValue("Displacement (L)");
  const engineCyl = getValue("Engine Number of Cylinders");

  let engine = "";
  if (engineModel) engine = engineModel;
  else if (engineConfig && engineDispL)
    engine = `${engineDispL}L ${engineConfig}`;
  else if (engineDispL && engineCyl)
    engine = `${engineDispL}L ${engineCyl}-cyl`;
  else if (engineDispL) engine = `${engineDispL}L`;
  else if (engineConfig) engine = engineConfig;

  const decodedVehicle = {
    vin,
    year: year || "",
    make: make || "",
    model: model || "",
    engine: engine || "",
  };

  // 3) Cache result in Supabase (best-effort)
  try {
    const { error: upsertError } = await supabase.from("vin_decodes").upsert(
      {
        vin,
        year: decodedVehicle.year,
        make: decodedVehicle.make,
        model: decodedVehicle.model,
        engine: decodedVehicle.engine,
        raw: results, // jsonb
      },
      { onConflict: "vin" }
    );

    if (upsertError) {
      console.error("Supabase VIN cache upsert error:", upsertError);
    }
  } catch (err) {
    console.error("VIN cache upsert failed:", err);
  }

  return decodedVehicle;
}

// ------------------------------------------------------
// POST /decode-vin
// Body: { vin: string, vehicleContext?: { ... } }
// Returns: { vehicle: {...merged+inferred} }
// ------------------------------------------------------
app.post("/decode-vin", async (req, res) => {
  const { vin, vehicleContext } = req.body || {};

  if (!vin) {
    return res.status(400).json({ error: "VIN is required." });
  }

  try {
    const decoded = await decodeVinWithCache(vin);

    // Merge with any existing vehicle context and infer engine if needed
    const merged = mergeVehicleContexts(vehicleContext, decoded);
    const withEngine = inferEngine(merged);

    return res.json({
      vehicle: withEngine,
    });
  } catch (err) {
    console.error("VIN decode error:", err);
    return res.status(500).json({
      error: "Failed to decode VIN.",
      details: err.message,
    });
  }
});

// ------------------------------------------------------
// MAIN CHAT ENDPOINT
// Body: {
//   message: string,
//   context?: OpenAI messages array,
//   vehicleContext?: { vin, year, make, model, engine }
// }
// Returns: {
//   reply: string,
//   vehicle: { ... }   // merged + inferred, for auto-fill
// }
// ------------------------------------------------------
app.post("/chat", async (req, res) => {
  const { message, context, vehicleContext } = req.body || {};

  if (!message || typeof message !== "string") {
    return res.status(400).json({ error: "Message is required." });
  }

  try {
    // 1) Extract vehicle details from the user's message
    const extractedVehicle = await extractVehicleFromText(message);

    // 2) Merge with existing vehicle context (frontend "session memory")
    let combinedVehicle = mergeVehicleContexts(vehicleContext, extractedVehicle);

    // 3) Try simple engine inference if engine still blank
    combinedVehicle = inferEngine(combinedVehicle);

    // 4) Optional GRIT "vehicle only" response
    const gritToneReply = buildGritResponse(message, combinedVehicle);

    if (gritToneReply) {
      return res.json({
        reply: gritToneReply,
        vehicle: combinedVehicle,
      });
    }

    // 5) Full GRIT reasoning via OpenAI
    const aiResponse = await openai.chat.completions.create({
      model: "gpt-4.1",
      messages: [
        {
          role: "system",
          content: `
You are **GRIT** — a blunt, direct diagnostic mentor for professional automotive technicians.

Tone:
- Assertive, clear, no fluff.
- Never rude or insulting.
- No sugarcoating: you push for data, not guesses.

Behavior:
- Always push for concrete symptoms, conditions, and patterns.
- Require details: when it happens, how often, hot vs cold, load vs idle, etc.
- Use structured thinking: possible causes -> tests -> next steps.
- If the user only gives a vehicle, demand the actual problem and data.
- Use the vehicle context when provided (year, make, model, engine) to tailor your plan.

Be concise, sharp, and useful. Avoid long walls of text when a tight plan will do.
`
        },
        ...(Array.isArray(context) ? context : []),
        { role: "user", content: message },
      ],
      temperature: 0.4,
    });

    const finalReply = aiResponse.choices[0].message.content;

    return res.json({
      reply: finalReply,
      vehicle: combinedVehicle,
    });
  } catch (err) {
    console.error("Chat endpoint error:", err);
    return res.status(500).json({ error: "Chat endpoint failed." });
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
