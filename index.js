// index.js (or server.js)

// ===============================
//  Imports & Setup
// ===============================
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// ===============================
//  Supabase Client
// ===============================
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ===============================
//  OpenAI Client (gpt-o1 reasoning)
// ===============================
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ===============================
//  Health Check
// ===============================
app.get("/", (req, res) => {
  res.json({ status: "ok", message: "AutoBrain backend running" });
});

// =====================================================================
//  /api/chat — GRIT: Ruthless Diagnostic Mentor (gpt-o1 reasoning mode)
// =====================================================================
app.post("/api/chat", async (req, res) => {
  const startedAt = Date.now();

  try {
    const {
      conversationId = null,
      technicianId = "demo-tech",
      vehicle = {},
      message = "",
      history = [],
    } = req.body || {};

    if (!message || !message.trim()) {
      return res.status(400).json({ error: "No message provided." });
    }

    // Basic request log
    console.log("[/api/chat] Incoming:", {
      technicianId,
      vehicle,
      message,
    });

    // --------------------------------------------------
    // 1. Create or reuse conversation (for logging)
    // --------------------------------------------------
    let convId = conversationId || null;

    if (!convId) {
      const { data: conv, error: convError } = await supabase
        .from("conversations")
        .insert({
          technician_id: technicianId,
        })
        .select()
        .single();

      if (convError) {
        console.error("[/api/chat] Conversation creation error:", convError);
        // Non-fatal: still answer, just no DB grouping
      } else {
        convId = conv.id;
      }
    }

    // --------------------------------------------------
    // 2. Build memory from frontend history (cap 25 msgs)
    // history is expected as: [{ role: "user"|"assistant", content: "..." }, ...]
    // --------------------------------------------------
    let memoryMessages = [];

    if (Array.isArray(history)) {
      const trimmed = history.slice(-25);
      memoryMessages = trimmed
        .filter((m) => m && m.content)
        .map((m) => ({
          role: m.role === "assistant" ? "assistant" : "user",
          content: m.content,
        }));
    }

    // --------------------------------------------------
    // 3. SYSTEM PROMPT — GRIT personality + advanced logic
    // --------------------------------------------------
    const systemPrompt = `
You are GRIT — AutoBrain's ruthless diagnostic mentor. 
You are an ASE Master Technician with deep real-world experience across brands.

GOAL:
- Turn average techs into killers at diagnostics.
- Build bulletproof diagnostic plans that would not embarrass a top-level tech.
- No fluff. No corporate report formatting. Just what works in the bay.

PERSONALITY:
- Direct, blunt, and honest.
- You do not attack the person, but you absolutely tear apart weak ideas.
- If their approach is trash, you say so clearly and explain why.
- You sound like an experienced lead tech in a busy shop.

HOW YOU RESPOND:
- First, clarify the situation:
  - Ask for missing data: codes, freeze frame, trims, conditions, previous work.
  - If their description is vague, push back:
    - "That's too vague. Give me actual symptoms."
    - "You're missing data: fuel trims, codes, and what it's doing under load."
- Then evaluate their thinking:
  - Call out assumptions and guesswork.
  - Highlight what's solid, what's weak, and what's missing.
  - Point out risks: comebacks, wasted hours, burned modules, safety issues.
- Then give a better plan:
  - Specific tests, ordered logically.
  - What each test proves or rules out.
  - What data you'd want before moving on.

FORMAT:
- Conversational shop talk.
- Short paragraphs, not corporate reports.
- No bullet-point diagnostic worksheets like "1. Probable causes, 2. Failure patterns" etc.
- You can use bullet points sparingly, but sound like you're talking, not printing a report.

ADVANCED DIAGNOSTIC LOGIC (DO NOT EXPLAIN AS "STEPS", JUST ACT ON IT):

MISFIRE CHAINS:
- Always think: load, RPM, temperature, pattern (single cylinder vs random).
- Ask for: 
  - Misfire codes (P0300–P030x), mode 6 data or misfire counters.
  - Feel (idle only, light load, WOT, cold vs hot).
- Strongly discourage "parts cannon."
- Prioritize:
  - Basic ignition check: plugs, coils, wires if present, coil drivers.
  - Fuel delivery: injector balance, current ramp, command vs actual, fuel pressure under load.
  - Mechanical: compression, relative compression, leak-down, cam/crank correlation, valve issues.
- Use fuel trims + O2 data to decide if misfire is lean, rich, or mechanical.

FUEL TRIM LOGIC:
- Interpret trims by bank and operating condition.
- Use rough thresholds (do not present as exact rules):
  - STFT or LTFT above about +10–15% = likely lean or unmetered air.
  - STFT or LTFT below about -10–15% = likely rich or fuel-heavy.
- Ask for: 
  - Idle vs cruise trims, warm engine, closed loop.
  - MAF readings vs expected, MAP behavior, upstream leaks, exhaust leaks.
- Use trims to steer: vacuum leaks vs fuel delivery vs sensor skew.

OXYGEN SENSOR / AFR SENSOR LOGIC:
- Look at upstream sensors for mixture response:
  - If stuck lean or rich with no cross-count = sensor, wiring, or fueling issue.
  - If lazy cross-counts or slow switching = contamination, aging, wiring.
  - If trims are fighting hard but O2 looks flat = sensor or mixture problem.
- Downstream O2:
  - Mostly for catalyst efficiency—do not overuse it for fuel control.

NO-START / HARD START CHAINS:
- Divide quickly: crank-no-start vs no-crank.
- Ask for: 
  - Whether it has spark, fuel pressure, injector pulse, and compression.
  - Whether security/immobilizer or data-bus issues are present.
- Force them to stop guessing and prove where the failure is: air, fuel, spark, timing, compression, or control.

ELECTRICAL / CAN-BUS FAULTS:
- Ask for specific codes (U-codes, communication losses).
- Think about:
  - Power/ground integrity to modules.
  - Shared network branches, shorted nodes, terminating resistors.
- Encourage:
  - Use of wiring diagrams.
  - Checking power, ground, and signal at the module before calling a module bad.

VEHICLE CONTEXT (use this without restating every time):
- Year: ${vehicle.year || "unknown"}
- Make: ${vehicle.make || "unknown"}
- Model: ${vehicle.model || "unknown"}
- Engine: ${vehicle.engine || "unknown"}

STYLE RULES:
- Never output a formal numbered report.
- No "1. Probable causes, 2. Step path" formats.
- Talk like a mentor standing at the fender, leaning on the core support.
- If their idea is good, sharpen it.
- If their idea is sloppy, tell them it's sloppy and show them how to fix it.
`;

    // --------------------------------------------------
    // 4. Build message array for gpt-o1
    // --------------------------------------------------
    const messages = [
      { role: "system", content: systemPrompt },
      ...memoryMessages,
      { role: "user", content: message },
    ];

    // --------------------------------------------------
    // 5. Call OpenAI — gpt-o1 reasoning mode
    // --------------------------------------------------
    const completion = await openai.chat.completions.create({
      model: "gpt-o1",
      messages,
      reasoning: { effort: "medium" }, // encourage deeper reasoning
    });

    const aiText = completion.choices?.[0]?.message?.content?.trim() || "";

    console.log("[/api/chat] OpenAI latency:", `${Date.now() - startedAt}ms`);
    console.log("[/api/chat] GRIT reply (first 160 chars):", aiText.slice(0, 160));

    // --------------------------------------------------
    // 6. Log into Supabase (conversation + messages)
    // --------------------------------------------------
    if (convId && aiText) {
      const { error: insertError } = await supabase.from("messages").insert([
        {
          conversation_id: convId,
          sender: "user",
          text: message,
        },
        {
          conversation_id: convId,
          sender: "ai",
          text: aiText,
        },
      ]);

      if (insertError) {
        console.error("[/api/chat] Message insert error:", insertError);
      }
    }

    // --------------------------------------------------
    // 7. Return response to frontend
    // --------------------------------------------------
    res.json({
      conversationId: convId,
      response: aiText || "GRIT had trouble generating a response. Try again.",
    });
  } catch (err) {
    console.error("[/api/chat] Fatal error:", err);
    res.status(500).json({ error: "Chat error" });
  }
});

// =====================================================================
// /api/specs — Quick Spec Lookup (simple, low-temp model)
// =====================================================================
app.post("/api/specs", async (req, res) => {
  try {
    const { query } = req.body || {};

    if (!query || !query.trim()) {
      return res.status(400).json({ error: "No query provided." });
    }

    const systemPrompt = `
You are AutoBrain's fast specification lookup engine.
Your job is to answer direct questions about torque specs, capacities,
tightening sequences, and basic spec data.

RULES:
- Return ONLY the values the user is asking for.
- Be concise (1–3 short sentences).
- If you are not confident or data is vague, say "Not enough data" and explain what is missing.
    `;

    const completion = await openai.chat.completions.create({
      model: "gpt-4.1",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: query },
      ],
      temperature: 0.2,
    });

    const result = completion.choices?.[0]?.message?.content?.trim() || "";

    res.json({ result });
  } catch (err) {
    console.error("[/api/specs] Fatal error:", err);
    res.status(500).json({ error: "Specs lookup error" });
  }
});

// =====================================================================
//  Start Server
// =====================================================================
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`AutoBrain backend listening on port ${PORT}`);
});
