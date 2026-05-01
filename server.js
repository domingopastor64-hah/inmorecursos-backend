const express = require("express");
const fetch = require("node-fetch");
const cors = require("cors");

const app = express(); // ✅ PRIMERO SE CREA

app.use(cors());

const PORT = process.env.PORT || 3000;


// ✅ DESPUÉS LAS RUTAS

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

  } catch (e) {
    res.status(500).json({ error: "error euribor" });
  }
});

app.get("/api/entorno", async (req, res) => {
  const { lat, lon } = req.query;

  if (!lat || !lon) {
    return res.status(400).json({ error: "faltan coordenadas" });
  }

  try {
    const url = `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat}&longitude=${lon}&hourly=pm2_5,pm10,nitrogen_dioxide,ozone&timezone=auto`;

    const response = await fetch(url);
    const data = await response.json();

    res.json({
      pm25: data?.hourly?.pm2_5?.slice(-1)[0] || null
    });

  } catch (e) {
    res.status(500).json({ error: "error entorno" });
  }
});

app.get("/api/renta", async (req, res) => {
  try {
    const response = await fetch("https://servicios.ine.es/wstempus/js/ES/DATOS_TABLA/30896");
    const data = await response.json();

    res.json({
      renta: data?.Data?.[0]?.Valor || null
    });

  } catch (e) {
    res.status(500).json({ error: "error renta" });
  }
});


// ✅ SIEMPRE AL FINAL

app.listen(PORT, () => {
  console.log("Servidor funcionando");
});
