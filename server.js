const express = require("express");
const fetch = require("node-fetch");
const app = express();
const PORT = process.env.PORT || 3000;

/* ================================
   🔐 VARIABLES DE ENTORNO (Render)
================================ */
const GEOAPIFY_KEY = process.env.GEOAPIFY_KEY;
const AEMET_KEY = process.env.AEMET_KEY;
const OPENROUTESERVICE_KEY = process.env.OPENROUTESERVICE_KEY;

/* ================================
   🌍 ENDPOINT PRINCIPAL
================================ */
app.get("/entorno", async (req, res) => {
  try {
    const direccion = req.query.direccion;

    if (!direccion) {
      return res.json({ ok: false, error: "Debe indicar una dirección" });
    }

    /* ================================
       📍 1. GEOLOCALIZACIÓN (Geoapify)
    ================================= */
    const geoUrl = `https://api.geoapify.com/v1/geocode/search?text=${encodeURIComponent(
      direccion + ", España"
    )}&limit=1&apiKey=${GEOAPIFY_KEY}`;

    const geoRes = await fetch(geoUrl);
    const geoData = await geoRes.json();

    if (!geoData.features || geoData.features.length === 0) {
      return res.json({ ok: false, error: "No se ha podido localizar la dirección" });
    }

    const coords = geoData.features[0].geometry.coordinates;
    const lon = coords[0];
    const lat = coords[1];
    const direccionReal = geoData.features[0].properties.formatted;

    /* ================================
       🌫️ 2. CALIDAD DEL AIRE (Open-Meteo)
    ================================= */
    let aire = {};
    try {
      const airUrl = `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat}&longitude=${lon}&hourly=pm2_5,pm10,nitrogen_dioxide,ozone&timezone=auto`;
      const airRes = await fetch(airUrl);
      const airData = await airRes.json();

      aire = {
        pm25: airData?.hourly?.pm2_5?.[0] ?? "no disponible",
        pm10: airData?.hourly?.pm10?.[0] ?? "no disponible",
        no2: airData?.hourly?.nitrogen_dioxide?.[0] ?? "no disponible",
        ozono: airData?.hourly?.ozone?.[0] ?? "no disponible",
      };
    } catch {
      aire = { error: "No disponible" };
    }

    /* ================================
       🏥 3. SERVICIOS (Geoapify Places)
    ================================= */
    let servicios = [];
    try {
      const placesUrl = `https://api.geoapify.com/v2/places?categories=healthcare.pharmacy,education.school,commercial.supermarket,catering.restaurant&filter=circle:${lon},${lat},1000&limit=20&apiKey=${GEOAPIFY_KEY}`;
      const placesRes = await fetch(placesUrl);
      const placesData = await placesRes.json();

      servicios = placesData.features.map((p) => ({
        nombre: p.properties.name || "Sin nombre",
        direccion: p.properties.address_line1 || "Dirección no disponible",
      }));
    } catch {
      servicios = [];
    }

    /* ================================
       ☀️ 4. AEMET (UV aproximado)
    ================================= */
    let uvi = "no disponible";
    try {
      const aemetUrl = `https://opendata.aemet.es/opendata/api/prediccion/especifica/uvi/0/?api_key=${AEMET_KEY}`;
      const aemetRes = await fetch(aemetUrl);
      const aemetJson = await aemetRes.json();

      if (aemetJson.datos) {
        const datosRes = await fetch(aemetJson.datos);
        const datos = await datosRes.json();
        uvi = datos[0]?.prediccion?.dia?.[0]?.indiceUVMax || "no disponible";
      }
    } catch {
      uvi = "no disponible";
    }

    /* ================================
       🚀 RESPUESTA FINAL
    ================================= */
    res.json({
      ok: true,
      direccion_solicitada: direccion,
      direccion_localizada: direccionReal,
      coordenadas: { lat, lon },
      aire,
      uvi,
      servicios,
    });

  } catch (error) {
    res.json({
      ok: false,
      error: "Error interno del servidor",
      detalle: error.message,
    });
  }
});

/* ================================
   🔍 DEBUG DE KEYS
================================ */
app.get("/debug-keys", (req, res) => {
  res.json({
    geoapify: Boolean(GEOAPIFY_KEY),
    aemet: Boolean(AEMET_KEY),
    openrouteservice: Boolean(OPENROUTESERVICE_KEY),
  });
});

/* ================================
   🟢 SERVIDOR
================================ */
app.listen(PORT, () => {
  console.log(`Servidor funcionando en puerto ${PORT}`);
});
