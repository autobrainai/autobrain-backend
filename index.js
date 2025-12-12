// ===========================================================
// AUTO BRAIN — GRIT BACKEND (FINAL UPDATED VERSION)
// Includes:
// - VIN Decoding + Supabase Cache
// - Engine Code Classification (GM RPO -> Gen IV/V, AFM, DI)
// - Chat Endpoint
// - Diagnostic Tree Endpoint
// - Feedback Email Endpoint (RESEND VERSION - RELIABLE)
// ===========================================================

import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fetch from "node-fetch";
import { Resend } from "resend";
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
// Resend Email Client
// ------------------------------------------------------
const resend = new Resend(process.env.RESEND_API_KEY);

// ------------------------------------------------------
// ENGINE MAP (Simple inference if engine missing)
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
      notes = "Gen IV AFM — known AFM lifter failures, VLOM faults.";
      break;

    case "LMG":
    case "LY5":
      generation = "Gen IV";
      hasAFM = false;
      notes = "Gen IV non-AFM — fewer AFM lifter issues.";
      break;

    case "L83":
      generation = "Gen V";
      hasAFM = true;
      isDI = true;
      notes = "Gen V DI AFM — DI injector issues, AFM lifter collapse, HPFP failures.";
      break;

    case "L86":
    case "L94":
      generation = "Gen V";
      hasAFM = true;
      isDI = true;
      notes = "Gen V 6.2 DI AFM — common injector balancing & AFM issues.";
      break;

    case "L96":
      generation = "Gen IV";
      hasAFM = false;
      notes = "6.0 HD Work Engine — common ignition & exhaust issues.";
      break;

    case "L92":
    case "L9H":
      generation = "Gen IV";
      notes = "Gen IV 6.2 non-AFM.";
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
Unknown -> empty string.`
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
// GRIT SHORT RESPONSE
// ------------------------------------------------------
function buildGritResponse(msg, v) {
  const lower = msg.toLowerCase();

  const hasSymptoms =
    lower.includes("code") ||
    lower.includes("p0") ||
    lower.includes("misfir") ||
    lower.includes("noise") ||
    lower.includes("overheat") ||
    lower.includes("stall") ||
    lower.includes("no start");

  const short = msg.trim().split(/\s+/).length <= 6;

  if (!short || hasSymptoms || !(v.year || v.make || v.model)) return null;

  return `
A ${v.year} ${v.make} ${v.model}. Noted.
But what's it *doing*?

Codes?
Misfires?
No-start?
Noises?
Overheating?

Give symptoms and mileage so I can build a real diagnostic plan.`;
}

// ------------------------------------------------------
// VIN DECODE
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

  let engineString = "";
  if (engineDetails?.code) {
    engineString = `${engineDetails.displacement_l}L ${engineDetails.code} ${engineDetails.has_afm ? "AFM" : ""} ${engineDetails.is_direct_injected ? "DI" : ""}`.trim();
  } else {
    engineString = engineModel || disp || "";
  }

  const decoded = {
    vin,
    year,
    make,
    model,
    engine: engineString,
    engineDetails
  };

  await supabase.from("vin_decodes").upsert({
    vin,
    year,
    make,
    model,
    engine: engineString,
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

    const quick = buildGritResponse(message, mergedVehicle);
    if (quick) {
      return res.json({ reply: quick, vehicle: mergedVehicle });
    }

    const ai = await openai.chat.completions.create({
      model: "gpt-4.1",
      temperature: 0.4,
      messages: [
        {
          role: "system",
          content: `
You are GRIT — ruthless diagnostic mentor.
Use engineDetails to modify diagnosis (AFM, DI, Gen V, etc).
No fluff. Crisp instructions only.`
        },
        {
          role: "system",
          content: `Vehicle: ${JSON.stringify(mergedVehicle)}`
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
// POST /send-feedback (RESEND EMAIL)
// ------------------------------------------------------
app.post("/send-feedback", async (req, res) => {
  try {
    const { feedback } = req.body;

    if (!feedback || feedback.trim() === "") {
      return res.status(400).json({ error: "Feedback required" });
    }

    await resend.emails.send({
      from: "AutoBrain Feedback <feedback@autobrain-ai.com>",
      to: "support@autobrain-ai.com",
      subject: "New AutoBrain GRIT Feedback",
      html: `
        <h2>Technician Feedback Submitted</h2>
        <p>${feedback.replace(/\n/g, "<br>")}</p>
      `
    });

    res.json({ status: "ok" });
  } catch (err) {
    console.error("Feedback error:", err);
    res.status(500).json({ error: "Email send failed" });
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
