import app from "./server.js";

import chatRoutes from "./routes/chat.routes.js";
import vinRoutes from "./routes/vin.routes.js";
import feedbackRoutes from "./routes/feedback.routes.js";
import diagnosticRoutes from "./routes/diagnostic.routes.js";

app.use("/chat", chatRoutes);
app.use("/decode-vin", vinRoutes);
app.use("/send-feedback", feedbackRoutes);
app.use("/diagnostic-tree", diagnosticRoutes);

app.get("/", (req, res) => {
  res.send("AutoBrain / GRIT backend running (Ruleset v2)");
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () =>
  console.log(`Server running on port ${PORT}`)
);
