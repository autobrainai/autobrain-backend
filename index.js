import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// -----------------------------
// Supabase Client
// -----------------------------
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// -----------------------------
// OpenAI Client
// -----------------------------
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// -----------------------------
// Health Check
// -----------------------------
app.get("/", (req, res) => {
  res.json({ status: "ok", message: "AutoBrain backend running" });
});

// =====================================================================
// 🚗 RUTHLESS MENTOR CHAT — Conversational, Harsh, Bulletproof Diagnostics
// =====================================================================
app.post("/api/chat", async (req, res) => {
  try {
    const {
      conversationId = null,
      technicianId = "demo-tech",
      vehicle = {},
      message = "",
    } = req.body || {};

    if (!message) {
      return res.status(400).json({ error: "No message provided." });
    }

    // --------------------------------------------------
    // 1. Create or continue a conversation
    // --------------------------------------------------
    let convId = conversationId;

    if (!convId) {
      const { data: conv, error: convError } = await supabase
        .from("conversations")
        .insert({ technician_id: technicianId })
        .select()
        .single();

      if (convError) {
        console.error("Conversation creation error:", convError);
        return res.status(500).json({ error: "Failed to create conversation" });
      }

      convId = conv.id;
    }

    // --------------------------------------------------
    // 2. Memory — Fetch last 25 messages for context
    // --------------------------------------------------
    const { data: history, error: historyError } = await supabase
      .from("messages")
      .select("*")
      .eq("conversation_id", convId)
      .order("created_at", { ascending: true })
      .limit(25);

    if (historyError) {
      console.error("History fetch error:", historyError);
    }

    const memoryMessages =
      history?.map((m) => ({
        role: m.sender === "ai" ? "assistant" : "user",
        content: m.text,
      })) || [];

    // --------------------------------------------------
    // 3. SYSTEM PROMPT — Ruthless, shop-floor mentor
    // --------------------------------------------------
    const systemPrompt = `
You are AutoBrain AI — an ASE Master Technician and **ruthless diagnostic mentor**.

OVERALL MISSION:
- Your job is to turn average techs into killers at diagnostics.
- You DO NOT pamper egos. You sharpen thinking.
- You aggressively attack weak reasoning, lazy shortcuts, and parts-cannon behavior.
- You constantly push them toward deep, disciplined, bulletproof diagnostics.

PERSONALITY:
- Direct. Blunt. No sugarcoating.
- You never insult the *person*, but you absolutely rip apart bad IDEAS.
- If their plan is trash, you say so clearly and explain why.
- You sound like a veteran lead tech in a busy shop who has seen every mistake.

HOW YOU RESPOND:
- First, make sure you understand exactly what they're trying to do.
  - If their description is vague, you push back hard:
    - "That's too vague. What are the actual symptoms?"
    - "You skipped half the story. Give me codes, fuel trims, conditions."
- Then you evaluate their thinking:
  - Call out assumptions.
  - Point out missing tests, missing data, and logical gaps.
  - Highlight risks: comebacks, wasted hours, fried modules, safety issues.
- You propose a BETTER plan:
  - More data-driven.
  - Smarter test order.
  - Minimal guesswork.
  - Clear reasoning behind each step.

YOU ARE ALLOWED (AND ENCOURAGED) TO SAY THINGS LIKE:
- "That approach is weak because..."
- "You're guessing. Here's the proof."
- "If you do it that way, here's exactly how it will bite you."
- "This is closer, but it's still not bulletproof. You're missing X and Y."
- "Slow down. You're skipping the fundamentals."

FORMAT:
- No numbered report templates.
- No corporate-style formatting.
- Use short paragraphs and direct language.
- Think shop talk, not PowerPoint.

DIAGNOSTIC KNOWLEDGE:
You have deep real-world experience with:
- OBD-II, fuel trims, AFR, misfire logic.
- No-starts, intermittent stalls, driveability nightmares.
- Electrial and CAN-bus issues, shorts, opens, high resistance.
- HPFP, GDI systems, turbo/supercharger issues.
- Manufacturer-specific weak points and common patterns.

VEHICLE CONTEXT (use this automatically):
Year: ${vehicle.year || "unknown"}
Make: ${vehicle.make || "unknown"}
Model: ${vehicle.model || "unknown"}
Engine: ${vehicle.engine || "unknown"}

Behavior rule:
- If their idea is solid, you refine it and make it sharper.
- If their idea is half-baked, you tear into it and rebuild it properly.
- Your priority is always: **a diagnostic process that would not embarrass a top-level tech.**
`;

    // --------------------------------------------------
    // 4. Build OpenAI request (with memory + latest message)
    // --------------------------------------------------
    const messages = [
      { role: "system", content: systemPrompt },
      ...memoryMessages,
      { role: "user", content: message },
    ];

    // --------------------------------------------------
    // 5. Call OpenAI — high-reasoning model
    //    (GPT-5 is the current best reasoning model, successor to older o1-style models)
// --------------------------------------------------
    const completion = await openai.chat.completions.create({
      model: "gpt-5", // high reasoning mode
      messages,
      temperature: 0.45, // a bit lower = more disciplined, less fluffy
    });

    const aiText = completion.choices[0].message.content.trim();

    // --------------------------------------------------
    // 6. Save messages in Supabase
    // --------------------------------------------------
    const { error: insertError } = await supabase.from("messages").insert([
      { conversation_id: convId, sender: "user", text: message },
      { conversation_id: convId, sender: "ai", text: aiText },
    ]);

    if (insertError) {
      console.error("Message insert error:", insertError);
    }

    // --------------------------------------------------
    // 7. Return response
    // --------------------------------------------------
    res.json({
      conversationId: convId,
      response: aiText,
    });
  } catch (err) {
    console.error("Chat error:", err);
    res.status(500).json({ error: "Chat error" });
  }
});

// =====================================================================
// SPECS LOOKUP (kept simple, solid model)
// =====================================================================
app.post("/api/specs", async (req, res) => {
  try {
    const { query } = req.body;

    const systemPrompt = `
You are AutoBrain's fast specification lookup engine.
Return ONLY the values the user is requesting.
If unsure, say "Not enough data".
    `;

    const completion = await openai.chat.completions.create({
      model: "gpt-4.1",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: query },
      ],
      temperature: 0.2,
    });

    res.json({ result: completion.choices[0].message.content.trim() });
  } catch (err) {
    console.error("Specs error:", err);
    res.status(500).json({ error: "Specs lookup error" });
  }
});

// =====================================================================
// START SERVER
// =====================================================================
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`AutoBrain backend listening on port ${PORT}`);
});
