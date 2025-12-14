// ===========================================================
// AUTO BRAIN — GRIT BACKEND (UPDATED WITH RULESET v2)
// ===========================================================

import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fetch from "node-fetch";
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
// GRIT DIAGNOSTIC RULESET — ALWAYS ENFORCED
// ------------------------------------------------------
const GRIT_RULESET = `
When the user does not know the code / only sees "check engine light":
- Explain they must get an actual code before meaningful diagnostics.
- Ask where they scanned it.
- Recommend AutoZone/O'Reilly for basic free scans.
- Warn their part recommendations are often wrong.
- Explain they cannot scan BCM, TCM, Airbag, HVAC, or advanced modules.
- Recommend a professional shop for full vehicle scanning.

When user says they replaced a part:
- Never trust the new part.
- Stress that aftermarket parts often fail immediately.
- Recommend OEM parts for GM, Ford, Honda, Toyota.
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

GRIT communication rules:
- Explain WHY a test is done.
- Push the user to verify conditions before guessing.
- Require mileage when relevant.
- Require symptom description if vague.
- Be blunt but helpful. No fluff.

If user is stuck:
- Give step-by-step instructions.
- Ask for results before continuing.
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
    engine: incoming.engine || existing.engine || ""
  };
}

// --------------------------------------------------
// Extract Vehicle Context from Free Text (STRICT)
// --------------------------------------------------
async function extractVehicleFromText(message) {
  try {
    const systemPrompt = [
      "You are an automotive parser.",
      "",
      "Extract vehicle information ONLY if explicitly stated.",
      "DO NOT guess.",
      "DO NOT infer missing data.",
      "",
      "Return EXACT JSON with this schema:",
      "{",
      '  "year": "",',
      '  "make": "",',
      '  "model": "",',
      '  "engine": ""',
      "}",
      "",
      "Rules:",
      "- Year must be 4 digits (e.g. 2013)",
      "- Normalize common makes:",
      "  - Tahoe → Chevrolet Tahoe",
      "  - F150 → Ford F-150",
      "  - Silverado → Chevrolet Silverado",
      "  - Ram → Ram 1500",
      '- Engine must include displacement if stated (e.g. "5.3", "5.3L")',
      "- If any field is unknown, return empty string",
      "- Return JSON ONLY. No commentary."
    ].join("\n");

    const resp = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      temperature: 0,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: message }
      ]
    });

    const raw = resp.choices[0].message.content;
    const parsed = JSON.parse(raw);

    return {
      year: parsed.year || "",
      make: parsed.make || "",
      model: parsed.model || "",
      engine: parsed.engine || ""
    };
  } catch (err) {
    console.error("extractVehicleFromText failed:", err);
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
  } catch (err) {
    res.status(500).json({ error: "Chat error" });
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
