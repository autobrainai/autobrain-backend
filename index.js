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
[SNIPPED — UNCHANGED RULESET CONTENT]
`;

// ------------------------------------------------------
// ENGINE MAP — fallback inference
// ------------------------------------------------------
const ENGINE_MAP = {
  "2013|Chevrolet|Tahoe": "5.3L V8",
  "2013|Chevy|Tahoe": "5.3L V8"
};

// ------------------------------------------------------
// ENGINE STRING INFERENCE
// ------------------------------------------------------
function inferEngineStringFromYMM(vehicle) {
  if (vehicle.engine) return vehicle.engine;
  const key = \`\${vehicle.year}|\${vehicle.make}|\${vehicle.model}\`;
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
// QUICK SHORT-GRIT RESPONSE
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
      temperature: 0.3,
      messages: [
        {
          role: "system",
          content: `
You are GRIT — a ruthless diagnostic mentor for technicians.

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
  } catch {
    res.status(500).json({ error: "Chat error" });
  }
});

// ------------------------------------------------------
// POST /send-feedback  ✅ SINGLE, LOCKED VERSION
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
      text: feedback
    });

    res.json({ status: "ok" });
  } catch (err) {
    console.error("Feedback email failed:", err);
    res.status(500).json({ error: "Feedback send failed" });
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
