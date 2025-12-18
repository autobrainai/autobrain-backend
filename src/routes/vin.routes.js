import express from "express";
import { decodeVinWithCache } from "../services/vin.service.js";

const router = express.Router();

router.post("/", async (req, res) => {
  try {
    const vehicle = await decodeVinWithCache(req.body.vin);
    res.json({ vehicle });
  } catch (err) {
    console.error("VIN decode error:", err);
    res.status(500).json({ error: "VIN decode error" });
  }
});

export default router;
