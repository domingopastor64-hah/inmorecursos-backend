import express from "express";
import cors from "cors";

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.json({ ok: true, mensaje: "Servidor InmoRecursos funcionando" });
});

app.get("/test-ruta", (req, res) => {
  res.json({ ok: true, mensaje: "RUTA OK" });
});

app.get("/api/euribor", async (req, res) => {
  try {
    res.json({
      ok: true,
      fuente: "Banco de España",
      aviso: "Ruta funcionando. Pendiente de ajustar serie oficial definitiva del Euríbor.",
      consulta: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: "Error Euríbor", detalle: error.message });
  }
});

app.get("/api/entorno", async (req, res) => {
  const { lat, lon } = req.query;

  if (!lat || !lon) {
    return res.status(400).json({ ok: false, error: "Faltan lat y lon" });
  }

  try {
    const url =
      `https://air-quality-api.open-meteo.com/v1/air-quality` +
      `?latitude=${lat}&longitude=${lon}` +
      `&current=pm10,pm2_5,nitrogen_dioxide,ozone,european_aqi,uv_index` +
      `&timezone=auto`;

    const response = await fetch(url);
    const data = await response.json();

    res.json({
      ok: true,
      fuente: "Open-Meteo Air Quality",
      consulta: new Date().toISOString(),
      datos: data.current || null
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: "Error entorno", detalle: error.message });
  }
});

app.get("/api/renta", async (req, res) => {
  res.json({
    ok: true,
    fuente: "INE",
    aviso: "Ruta funcionando. Pendiente de conectar tabla INE exacta por territorio.",
    consulta: new Date().toISOString()
  });
});

app.use((req, res) => {
  res.status(404).json({
    ok: false,
    error: "Ruta no encontrada",
    ruta_recibida: req.originalUrl
  });
});

app.listen(PORT, () => {
  console.log(`Servidor InmoRecursos funcionando en puerto ${PORT}`);
});
