import express from "express";
import { resend } from "../services/resend.service.js";

const router = express.Router();

// ------------------------------------------------------
// POST /send-feedback
// ------------------------------------------------------
router.post("/", async (req, res) => {
  try {
    const { feedback } = req.body;

    if (!feedback || !feedback.trim()) {
      return res.status(400).json({ error: "Feedback required" });
    }

    await resend.emails.send({
      from: "AutoBrain Feedback <support@autobrain-ai.com>",
      to: ["support@autobrain-ai.com"],
      subject: "New AutoBrain GRIT Feedback",
      html: `
        <h2>Technician Feedback Submitted</h2>
        <p>${feedback.replace(/\n/g, "<br>")}</p>
      `
    });

    res.json({ status: "ok" });
  } catch (err) {
    console.error("Feedback email failed:", err);
    res.status(500).json({ error: "Email send failed" });
  }
});

export default router;
