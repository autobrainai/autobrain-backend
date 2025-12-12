import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// --- Supabase client ---
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// --- OpenAI client ---
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Health check endpoint
app.get("/", (req, res) => {
  res.json({ status: "ok", message: "AutoBrain backend running" });
});


// ======================================================
// ✅ FIXED /api/chat ROUTE (SAFE VERSION)
// ======================================================
app.post("/api/chat", async (req, res) => {
  try {
    // Safely read body even if undefined
    const {
      technicianId = "demo-tech",
      vehicle = {},
      symptom = "",
      notes = "",
    } = req.body || {};

    // Validate required fields
    if (!symptom || !vehicle) {
      return res.status(400).json({
        error: "Missing data: 'vehicle' and 'symptom' are required.",
      });
    }

    // 1. Create conversation
    const { data: conv, error: convError } = await supabase
      .from("conversations")
      .insert({
        technician_id: technicianId,
      })
      .select()
      .single();

    if (convError) {
      console.error(convError);
      return res.status(500).json({ error: "Failed to create conversation" });
    }

    // 2. Pull relevant diagnostic cases
    let relevantCasesText = "";
    if (vehicle.make && vehicle.model) {
      const { data: cases, error: caseError } = await supabase
        .from("diagnostic_cases")
        .select("*")
        .ilike("make", `%${vehicle.make}%`)
        .ilike("model", `%${vehicle.model}%`)
        .limit(5);

      if (!caseError && cases?.length > 0) {
        relevantCasesText = cases
          .map((c) => {
            return `
Vehicle: ${c.vehicle_year} ${c.make} ${c.model} ${c.engine_code || ""}
Symptom: ${c.symptom}
Known Failure Patterns: ${c.known_failure_patterns}
Quick Tests: ${c.quick_tests}
Diagnostic Steps: ${c.diagnostic_steps}
Notes: ${c.notes}
`;
          })
          .join("\n\n");
      }
    }

    // 3. Build diagnostic prompt
    const userDescription = `
Vehicle: ${vehicle.year || "unknown"} ${vehicle.make || ""} ${
      vehicle.model || ""
    } ${vehicle.engine || ""}
Symptom: ${symptom}
Notes: ${notes || "none"}
`;

    const systemPrompt = `
You are AutoBrain AI, a diagnostic assistant for professional automotive technicians.
Return:
1. Probable Causes (ranked)
2. Known Failure Patterns (use real-world data if available)
3. Step-by-Step Diagnostic Path
4. Tests with expected values
5. Notes or cautions

Reference data:
${relevantCasesText || "No reference data available."}
`;

    // 4. Call OpenAI
    const completion = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userDescription },
      ],
    });

    const aiText = completion.choices[0].message.content.trim();

    // 5. Log chat messages
    await supabase.from("messages").insert([
      {
        conversation_id: conv.id,
        sender: "user",
        text: userDescription,
      },
      {
        conversation_id: conv.id,
        sender: "ai",
        text: aiText,
      },
    ]);

    res.json({
      conversationId: conv.id,
      response: aiText,
    });
  } catch (err) {
    console.error("Chat error:", err);
    res.status(500).json({ error: "Chat error" });
  }
});


// ======================================================
// SPECS LOOKUP ROUTE
// ======================================================
app.post("/api/specs", async (req, res) => {
  try {
    const { query } = req.body;

    const systemPrompt = `
You are AutoBrain AI, a fast specification lookup assistant.
Return ONLY the requested values.
If unsure, say "Not enough data".
`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: query },
      ],
    });

    const result = completion.choices[0].message.content.trim();

    res.json({ result });
  } catch (err) {
    console.error("Specs error:", err);
    res.status(500).json({ error: "Specs lookup error" });
  }
});


// ======================================================
// START SERVER
// ======================================================
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`AutoBrain backend listening on port ${PORT}`);
});
