// index.js — AutoBrain GRIT Backend (Hybrid 4.1 + o1)

import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";

dotenv.config();

// ---------------------------------------------------------------------
// Express setup
// ---------------------------------------------------------------------
const app = express();
app.use(cors());
app.use(express.json());

// ---------------------------------------------------------------------
// Supabase Client
// ---------------------------------------------------------------------
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ---------------------------------------------------------------------
// OpenAI Client
// ---------------------------------------------------------------------
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ---------------------------------------------------------------------
// Utility: simple vehicle extraction from free-text
// ---------------------------------------------------------------------
const KNOWN_MAKES = [
  "acura","audi","bmw","buick","cadillac","chevrolet","chevy","chrysler",
  "dodge","ram","fiat","ford","gmc","honda","hyundai","infiniti","jeep",
  "kia","lexus","lincoln","mazda","mercedes","mercedes-benz","mini",
  "mitsubishi","nissan","porsche","subaru","tesla","toyota","volkswagen","vw","volvo"
];

// a few model→make hints so "2013 tahoe" doesn't feel dumb
const MODEL_TO_MAKE = {
  tahoe: "chevrolet",
  suburban: "chevrolet",
  silverado: "chevrolet",
  "f-150": "ford",
  "f150": "ford",
  "f-250": "ford",
  "f250": "ford",
  civic: "honda",
  accord: "honda",
  camry: "toyota",
  corolla: "toyota",
  "1500": "ram",
  "2500": "ram",
};

function extractVehicleFromText(text = "") {
  const lower = text.toLowerCase();

  // year
  const yearMatch = lower.match(/\b(19|20)\d{2}\b/);
  const year = yearMatch ? yearMatch[0] : "";

  // make
  let make = "";
  for (const mk of KNOWN_MAKES) {
    if (lower.includes(mk)) {
      make = mk;
      break;
    }
  }

  // model: word immediately after make, or stand-alone model hints
  let model = "";
  if (make) {
    const parts = lower.split(/\s+/);
    for (let i = 0; i < parts.length; i++) {
      if (parts[i] === make && parts[i + 1]) {
        model = parts[i + 1].replace(/[^a-z0-9\-]/gi, "");
        break;
      }
    }
  } else {
    // try model→make lookup
    for (const [mdl, mk] of Object.entries(MODEL_TO_MAKE)) {
      if (lower.includes(mdl)) {
        model = mdl;
        make = mk;
        break;
      }
    }
  }

  if (!year && !make && !model) return {};

  // normalize make capitalization
  const normMake = make
    ? make
        .split("-")
        .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
        .join(" ")
    : "";

  const normModel = model
    ? model
        .split("-")
        .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
        .join(" ")
    : "";

  return {
    year: year || "",
    make: normMake || "",
    model: normModel || "",
  };
}

// ---------------------------------------------------------------------
// Utility: deep diagnostic trigger detection
// ---------------------------------------------------------------------
function needsDeepDiagnostic(text = "") {
  const t = text.toLowerCase();
  const triggers = [
    "misfire",
    "p030",
    "p03",
    "random misfire",
    "multiple misfire",
    "fuel trim",
    "stft",
    "ltft",
    "short term fuel trim",
    "long term fuel trim",
    "running rich",
    "running lean",
    "o2",
    "oxygen sensor",
    "afr",
    "wideband",
    "bank 1",
    "bank 2",
    "no start",
    "no-start",
    "won't start",
    "wont start",
    "cranks no start",
    "dies while driving",
    "stalls",
    "stalling",
    "hard start",
  ];
  return triggers.some((w) => t.includes(w));
}

// ---------------------------------------------------------------------
// Utility: extract text from Responses API (for gpt-o1)
// ---------------------------------------------------------------------
function extractTextFromResponses(resp) {
  try {
    if (!resp || !resp.output || !Array.isArray(resp.output)) return null;
    const first = resp.output[0];
    if (!first || !first.content) return null;

    return first.content
      .map((block) => (block.type === "output_text" ? block.text : block.text || ""))
      .join("")
      .trim();
  } catch (e) {
    console.error("Error extracting text from Responses API:", e);
    return null;
  }
}

// ---------------------------------------------------------------------
// Health Check
// ---------------------------------------------------------------------
app.get("/", (req, res) => {
  res.json({ status: "ok", message: "AutoBrain backend running" });
});

// =====================================================================
// 🚗 RUTHLESS MENTOR CHAT — Conversational + Deep Reasoning Hybrid
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
    // 1. Merge vehicle from UI + extracted vehicle from text
    // --------------------------------------------------
    const extractedVehicle = extractVehicleFromText(message);
    const mergedVehicle = {
      year: vehicle.year || extractedVehicle.year || "",
      make: vehicle.make || extractedVehicle.make || "",
      model: vehicle.model || extractedVehicle.model || "",
      engine: vehicle.engine || vehicle.engine_code || "",
    };

    // --------------------------------------------------
    // 2. Create or continue a conversation
    // --------------------------------------------------
    let convId = conversationId;

    if (!convId) {
      const { data: conv, error: convError } = await supabase
        .from("conversations")
        .insert({
          technician_id: technicianId,
          // you can add more metadata columns here if your schema has them
        })
        .select()
        .single();

      if (convError) {
        console.error("Conversation creation error:", convError);
        return res.status(500).json({ error: "Failed to create conversation" });
      }

      convId = conv.id;
    }

    // --------------------------------------------------
    // 3. Memory — Fetch last 25 messages from Supabase
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
    // 4. GRIT System Prompt (general conversational mentor)
    // --------------------------------------------------
    const baseSystemPrompt = `
You are GRIT — AutoBrain's ASE Master Technician and ruthless diagnostic mentor.

OVERALL MISSION:
- Turn average techs into killers at diagnostics.
- You DO NOT pamper egos. You sharpen thinking.
- You aggressively attack weak reasoning, lazy shortcuts, and parts-cannon behavior.
- You constantly push them toward deep, disciplined, bulletproof diagnostics.

PERSONALITY:
- Direct. Blunt. No sugarcoating.
- Never insult the PERSON, but absolutely rip apart bad IDEAS.
- If their plan is trash, say so clearly and explain why.
- Sound like a veteran lead tech in a busy shop who has seen every mistake.

HOW YOU RESPOND:
- If their description is vague, push back hard:
  - "That's too vague. What are the actual symptoms?"
  - "You skipped half the story. Give me codes, fuel trims, conditions."
- Evaluate their thinking:
  - Call out assumptions.
  - Point out missing tests, missing data, and logical gaps.
  - Highlight risks: comebacks, wasted hours, fried modules, safety issues.
- Then propose a BETTER plan:
  - More data-driven.
  - Smarter test order.
  - Minimal guesswork.
  - Clear reasoning behind each step.

RULES:
- No numbered corporate report templates.
- No "1. Probable causes / 2. Step-by-step" style.
- Use short paragraphs and sharp shop-floor language.
- You're a chat-based mentor, not a formal printout.

VEHICLE CONTEXT (use this automatically when relevant):
Year: ${mergedVehicle.year || "unknown"}
Make: ${mergedVehicle.make || "unknown"}
Model: ${mergedVehicle.model || "unknown"}
Engine: ${mergedVehicle.engine || "unknown"}

Behavior:
- If their idea is solid, refine and sharpen it.
- If their idea is half-baked, tear into it and rebuild it properly.
- Aim for a diagnostic process that would not embarrass a top-level tech.
`;

    // --------------------------------------------------
    // 5. Deep diagnostic chain prompt (for o1)
    // --------------------------------------------------
    const deepSystemPrompt = `
You are GRIT, running in DEEP DIAGNOSTIC MODE.

Focus on rigorous, step-by-step reasoning for hard problems like:
- Misfires (single and random)
- Fuel trims, AFR, running rich/lean
- O2 / AFR sensor behavior and crosscounts
- No-start and intermittent stall issues
- Complex driveability and CAN-bus interactions

Your goals:
- Build a clear mental model of what's happening.
- Use fuel trims, misfire counters, O2 behavior, load, RPM, ECT, IAT, MAP/MAF, etc.
- Explicitly call out:
  - What data is missing.
  - What assumptions are risky.
  - What tests MUST be run before guessing.

Style:
- Still blunt, but more methodical.
- Think like you're writing on a whiteboard in the shop.
- You can outline diagnostic branches ("If X, then do Y") but keep it conversational,
  not like a corporate flowchart.

Vehicle Context:
Year: ${mergedVehicle.year || "unknown"}
Make: ${mergedVehicle.make || "unknown"}
Model: ${mergedVehicle.model || "unknown"}
Engine: ${mergedVehicle.engine || "unknown"}

Now, reason deeply about the user's latest message and the conversation context.
`;

    // --------------------------------------------------
    // 6. Decide whether this needs deep o1 reasoning
    // --------------------------------------------------
    const useDeep = needsDeepDiagnostic(message);

    let aiText = null;

    // --------------------------------------------------
    // 7A. Try GPT-o1 for deep diagnostic chains (Responses API)
    // --------------------------------------------------
    if (useDeep) {
      try {
        const resp = await openai.responses.create({
          model: "gpt-o1",
          input: [
            { role: "system", content: deepSystemPrompt },
            ...memoryMessages,
            { role: "user", content: message },
          ],
        });

        aiText = extractTextFromResponses(resp);
        console.log("Used gpt-o1 for deep diagnostic response");
      } catch (err) {
        console.error("gpt-o1 error, falling back to gpt-4.1:", err);
      }
    }

    // --------------------------------------------------
    // 7B. If not deep, or o1 failed, use GPT-4.1 Chat
    // --------------------------------------------------
    if (!aiText) {
      const completion = await openai.chat.completions.create({
        model: "gpt-4.1",
        messages: [
          { role: "system", content: baseSystemPrompt },
          ...memoryMessages,
          { role: "user", content: message },
        ],
        temperature: 0.45, // disciplined but not robotic
      });

      aiText = completion.choices[0].message.content.trim();
      console.log("Used gpt-4.1 for response");
    }

    // --------------------------------------------------
    // 8. Log both user + AI messages in Supabase
    // --------------------------------------------------
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
      console.error("Message insert error:", insertError);
    }

    // --------------------------------------------------
    // 9. Send response back to frontend
    //    Include normalizedVehicle so Webflow can auto-fill the panel
    // --------------------------------------------------
    res.json({
      conversationId: convId,
      response: aiText,
      normalizedVehicle: mergedVehicle,
      usedDeepModel: useDeep,
    });
  } catch (err) {
    console.error("Chat error:", err);
    res.status(500).json({ error: "Chat error" });
  }
});

// =====================================================================
// SPECS LOOKUP — lightweight, value-only answers
// =====================================================================
app.post("/api/specs", async (req, res) => {
  try {
    const { query } = req.body;

    const systemPrompt = `
You are AutoBrain's fast specification lookup engine.
Return ONLY the values the user is requesting (numbers, ranges, torque specs, gaps, etc.).
Do NOT give explanations unless they explicitly ask for them.
If you truly don't know, say "Not enough data".
    `;

    const completion = await openai.chat.completions.create({
      model: "gpt-4.1",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: query || "" },
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
