const express = require("express");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());

// TEST
app.get("/", (req, res) => {
  res.json({ ok: true, mensaje: "Servidor funcionando" });
});

app.get("/test-ruta", (req, res) => {
  res.json({ ok: true, mensaje: "RUTA OK" });
});

// EURIBOR (mock inicial)
app.get("/api/euribor", (req, res) => {
  res.json({
    ok: true,
    valor: 3.65,
    fecha: new Date().toISOString()
  });
});

// ENTORNO (real Open-Meteo)
app.get("/api/entorno", async (req, res) => {
  try {
    const { lat, lon } = req.query;

    if (!lat || !lon) {
      return res.status(400).json({ error: "Faltan lat/lon" });
    }

    const url = `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat}&longitude=${lon}&current=pm10,pm2_5,nitrogen_dioxide,ozone,european_aqi,uv_index`;

    const response = await fetch(url);
    const data = await response.json();

    res.json({
      ok: true,
      datos: data.current
    });

  } catch (e) {
    res.status(500).json({ error: "Error entorno" });
  }
});

// RENTA (mock inicial)
app.get("/api/renta", (req, res) => {
  res.json({
    ok: true,
    renta_media: 18000
  });
});

// 404
app.use((req, res) => {
  res.status(404).json({ error: "Ruta no encontrada" });
});

app.listen(PORT, () => {
  console.log("Servidor funcionando en puerto " + PORT);
});
