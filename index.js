// ===========================================================
// AUTO BRAIN — GRIT BACKEND (FINAL UPDATED VERSION)
// Includes:
// - VIN Decoding + Supabase Cache
// - Engine Code Classification (GM RPO -> Gen IV/V, AFM, DI)
// - Chat Endpoint
// - Diagnostic Tree Endpoint
// - Feedback Email Endpoint
// ===========================================================

import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fetch from "node-fetch";
import nodemailer from "nodemailer";
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
// ENGINE MAP (Simple inference if engine missing)
// ------------------------------------------------------
const ENGINE_MAP = {
  "2013|Chevrolet|Tahoe": "5.3L V8",
  "2013|Chevy|Tahoe": "5.3L V8"
};

// ------------------------------------------------------
// GM ENGINE CLASSIFICATION LOGIC (RPO decoding)
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
  if (vehicle.engine && vehicle.engine.trim() !== "") return vehicle.engine;

  const key = `${vehicle.year}|${vehicle.make}|${vehicle.model}`;
  return ENGINE_MAP[key] || vehicle.engine || "";
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
// Extract YMM from message
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
Unknown fields -> empty string.`
        },
        { role: "user", content: message }
      ]
    });

    return JSON.parse(resp.choices[0].message.content);
  } catch (err) {
    return { year: "", make: "", model: "", engine: "" };
  }
}

// ------------------------------------------------------
// SHORT VEHICLE-ONLY GRIT RESPONSE
// ------------------------------------------------------
function buildGritResponse(userMessage, v) {
  const lower = userMessage.toLowerCase();

  const hasSymptoms =
    lower.includes("code") ||
    lower.includes("p0") ||
    lower.includes("knock") ||
    lower.includes("noise") ||
    lower.includes("misfir") ||
    lower.includes("stall") ||
    lower.includes("overheat") ||
    lower.includes("no start") ||
    lower.includes("smoke");

  const short = userMessage.trim().split(/\s+/).length <= 6;

  if (!short || hasSymptoms || !(v.year || v.make || v.model)) return null;

  return `
A ${v.year} ${v.make} ${v.model} — got it.
But that’s the vehicle, not the complaint.

What’s it actually doing?
Codes? Misfires? No-start? Noise? Overheating?
Mileage?
Anything replaced already?

Need the symptoms to build the plan.`;
}

// ------------------------------------------------------
// VIN DECODE (Supabase Cache + NHTSA)
// ------------------------------------------------------
async function decodeVinWithCache(vinRaw) {
  const vin = vinRaw.trim().toUpperCase();

  // 1) Cache
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
      engineDetails: data.engine_details || {}
    };
  }

  // 2) NHTSA
  const response = await fetch(
    `https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVin/${vin}?format=json`
  );
  const json = await response.json();
  const results = json.Results;

  const getVal = (label) => {
    const row = results.find((r) => r.Variable === label);
    return row?.Value && row.Value !== "Not Applicable" ? row.Value : "";
  };

  const year = getVal("Model Year");
  const make = getVal("Make");
  const model = getVal("Model");
  const engineModel = getVal("Engine Model");
  const disp = getVal("Displacement (L)");

  const engineDetails = classifyGMEngine(engineModel, disp);

  let engineString = "";
  if (engineDetails && engineDetails.code) {
    const tagAFM = engineDetails.has_afm ? "AFM" : "";
    const tagDI = engineDetails.is_direct_injected ? "DI" : "";
    engineString = `${engineDetails.displacement_l}L ${engineDetails.code} ${tagAFM} ${tagDI}`.trim();
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
  } catch (err) {
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

    const gritReply = buildGritResponse(message, mergedVehicle);
    if (gritReply) {
      return res.json({ reply: gritReply, vehicle: mergedVehicle });
    }

    const ai = await openai.chat.completions.create({
      model: "gpt-4.1",
      temperature: 0.4,
      messages: [
        {
          role: "system",
          content: `
You are GRIT — blunt, no-fluff diagnostic mentor.
Use engineDetails aggressively to modify diagnostic priority.
`
        },
        {
          role: "system",
          content: `Vehicle context: ${JSON.stringify(mergedVehicle)}`
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
You are GRIT — structured diagnostic engine.
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
}
`;

    const ai = await openai.chat.completions.create({
      model: "gpt-4.1",
      temperature: 0.3,
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "system",
          content: `Vehicle context: ${JSON.stringify(mergedVehicle)}`
        },
        { role: "user", content: message }
      ]
    });

    let tree;
    try {
      tree = JSON.parse(ai.choices[0].message.content);
    } catch {
      return res.status(500).json({
        error: "Invalid diagnostic JSON",
        raw: ai.choices[0].message.content
      });
    }

    res.json({ vehicle: mergedVehicle, tree });
  } catch (err) {
    res.status(500).json({ error: "Diagnostic tree error" });
  }
});

// ------------------------------------------------------
// POST /send-feedback (email to support)
// ------------------------------------------------------
app.post("/send-feedback", async (req, res) => {
  const { feedback } = req.body;

  if (!feedback) return res.status(400).json({ error: "Feedback required" });

  try {
    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: process.env.SUPPORT_EMAIL,
        pass: process.env.SUPPORT_EMAIL_PASS
      }
    });

    await transporter.sendMail({
      from: process.env.SUPPORT_EMAIL,
      to: "support@autobrain-ai.com",
      subject: "Technician Feedback — AutoBrain GRIT",
      text: feedback
    });

    res.json({ status: "ok" });
  } catch (err) {
    res.status(500).json({ status: "error", details: err.message });
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
