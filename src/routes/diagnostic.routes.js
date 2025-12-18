import express from "express";
import { getOpenAI } from "../services/openai.service.js";
import {
  mergeVehicleContexts,
  inferEngineStringFromYMM
} from "../utils/vehicle.util.js";

const router = express.Router();

// ------------------------------------------------------
// POST /diagnostic-tree
// ------------------------------------------------------
router.post("/", async (req, res) => {
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

    const openai = getOpenAI();
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
        error: "Invalid JSON from model",
        raw: ai.choices[0].message.content
      });
    }

    res.json({ vehicle: mergedVehicle, tree: json });
  } catch (err) {
    console.error("Diagnostic tree error:", err);
    res.status(500).json({ error: "Diagnostic tree error" });
  }
});

export default router;
