import express from "express";
import { runGrit } from "../services/grit.service.js";

const router = express.Router();

router.post("/", async (req, res) => {
  const result = await runGrit(req.body);
  res.json(result);
});

export default router;
