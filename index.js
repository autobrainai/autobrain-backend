// ===========================================================
// AUTO BRAIN — GRIT BACKEND (LOCKED VERSION)
// DO NOT EDIT TEMPLATE STRINGS UNLESS INSTRUCTED
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
4. Labor-intensive tests last.

Rules:
- Explain WHY a test is done.
- Require mileage when relevant.
- Require symptoms if vague.
- Be blunt. No fluff.
`;

// ------------------------------------------------------
// ENGINE MAP (fallback only)
// ------------------------------------------------------
const ENGINE_MAP = {
  "2013|Chevrolet|Tahoe": "5.3L",
  "2013|Chevy|Tahoe": "5.3L"
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

// ------------------------------------------------------
// Extract Vehicle Context from Free Text (STRICT)
// ------------------------------------------------------
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
      '- Engine must include displacement if stated (e.g. "5.3L")',
      "- If unknown, return empty string",
      "- Return JSON ONLY"
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
// SHORT GRIT RESPONSE (context only)
// ------------------------------------------------------
function buildGritResponse(msg, v) {
  const short = msg.trim().split(/\s+/).length <= 6;
  if (!short || !(v.year || v.make || v.model)) return null;

  return `
A ${v.year} ${v.make} ${v.model}. Noted.

But what’s it doing?

Codes?
Misfires?
No-start?
Noise?
Overheating?

Give mileage + symptoms so I can build a real plan.
`.trim();
}

// ------------------------------------------------------
// POST /chat
// ------------------------------------------------------
app.post("/chat", async (req, res) => {
  try {
    const { message, context, vehicleContext } = req.body;

    const extracted = await extractVehicleFromText(message);
    let mergedVehicle = mergeVehicleContexts(vehicleContext, extracted);
    mergedVehicle.engine = inferEngineStringFromYMM(mergedVehicle);

    // Ambiguous engine guard
    const ambiguous = ["v8", "v6", "4cyl", "4 cylinder"];
    if (
      mergedVehicle.engine &&
      ambiguous.includes(mergedVehicle.engine.toLowerCase())
    ) {
      return res.json({
        reply: `
I can help — but engine choice matters here.

This vehicle came with multiple engine options, and guessing leads to bad diagnostics.

If you can, drop the VIN.
With the VIN I can confirm the exact engine and build the correct diagnostic path.

If VIN isn’t available, tell me the exact engine size (e.g. 5.3L or 6.2L).
`.trim(),
        vehicle: mergedVehicle
      });
    }

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
You are GRIT — a ruthless diagnostic mentor.

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
    console.error(err);
    res.status(500).json({ error: "Chat error" });
  }
});

// ------------------------------------------------------
// HEALTH CHECK
// ------------------------------------------------------
app.get("/", (req, res) => {
  res.send("AutoBrain / GRIT backend running (LOCKED)");
});

// ------------------------------------------------------
// START SERVER
// ------------------------------------------------------
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
