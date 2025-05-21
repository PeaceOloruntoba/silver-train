import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import paymentsRoutes from "./routes/payments.js";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

// Raw body required only for webhook
app.use("/miet-app", paymentsRoutes);
app.use("/api/miet-app/payments", paymentsRoutes);

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
