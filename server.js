import express from "express";
import fetch from "node-fetch";
import cors from "cors";

const app = express();
app.use(cors());

const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.json({ ok: true });
});

app.get("/test-ruta", (req, res) => {
  res.json({ mensaje: "RUTA OK" });
});

app.get("/api/euribor", async (req, res) => {
  try {
    const response = await fetch("https://api.bde.es/data/series/DPUISBFE1210D?limit=1");
    const data = await response.json();

    res.json({
      valor: data?.data?.[0]?.value || null,
      fecha: data?.data?.[0]?.time_period || null
    });

  } catch {
    res.status(500).json({ error: "error euribor" });
  }
});

app.listen(PORT, () => {
  console.log("Servidor funcionando");
});
