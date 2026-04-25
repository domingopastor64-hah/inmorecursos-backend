import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const GEOAPIFY_KEY = process.env.GEOAPIFY_KEY;
const AEMET_KEY = process.env.AEMET_KEY;
const OPENROUTESERVICE_KEY = process.env.OPENROUTESERVICE_KEY;

app.get("/", (req, res) => {
  res.send("Backend InmoRecursos funcionando correctamente");
});

app.get("/debug-keys", (req, res) => {
  res.json({
    geoapify: Boolean(GEOAPIFY_KEY),
    aemet: Boolean(AEMET_KEY),
    openrouteservice: Boolean(OPENROUTESERVICE_KEY)
  });
});

app.get("/entorno", async (req, res) => {
  try {
    const direccion = req.query.direccion;

    if (!direccion) {
      return res.json({ ok: false, error: "Debe indicar una dirección" });
    }

    const geoUrl =
      `https://api.geoapify.com/v1/geocode/search` +
      `?text=${encodeURIComponent(direccion)}` +
      `&filter=countrycode:es` +
      `&bias=countrycode:es` +
      `&limit=1` +
      `&apiKey=${encodeURIComponent(GEOAPIFY_KEY)}`;

    const geoRes = await fetch(geoUrl);
    const geoData = await geoRes.json();

    if (!geoData.features || geoData.features.length === 0) {
      return res.json({ ok: false, error: "No se ha podido localizar la dirección" });
    }

    const lon = geoData.features[0].geometry.coordinates[0];
    const lat = geoData.features[0].geometry.coordinates[1];
    const direccionReal = geoData.features[0].properties.formatted;

    const airUrl =
      `https://air-quality-api.open-meteo.com/v1/air-quality` +
      `?latitude=${lat}` +
      `&longitude=${lon}` +
      `&current=pm2_5,pm10,european_aqi,nitrogen_dioxide,ozone` +
      `&timezone=auto`;

    const airRes = await fetch(airUrl);
    const airData = await airRes.json();

    const placesUrl =
      `https://api.geoapify.com/v2/places` +
      `?categories=healthcare.pharmacy,education.school,commercial.supermarket,catering.restaurant,leisure.park,public_transport` +
      `&filter=${encodeURIComponent(`circle:${lon},${lat},1000`)}` +
      `&limit=30` +
      `&apiKey=${encodeURIComponent(GEOAPIFY_KEY)}`;

    const placesRes = await fetch(placesUrl);
    const placesData = await placesRes.json();

    const servicios = (placesData.features || []).map((p) => ({
      nombre: p.properties.name || "Sin nombre",
      direccion: p.properties.formatted || p.properties.address_line1 || "Dirección no disponible",
      categorias: p.properties.categories || []
    }));

    res.json({
      ok: true,
      direccion_solicitada: direccion,
      direccion_localizada: direccionReal,
      coordenadas: { lat, lon },
      aire: {
        pm2_5: airData.current?.pm2_5 ?? null,
        pm10: airData.current?.pm10 ?? null,
        aqi_europeo: airData.current?.european_aqi ?? null,
        no2: airData.current?.nitrogen_dioxide ?? null,
        ozono: airData.current?.ozone ?? null
      },
      servicios
    });

  } catch (error) {
    res.json({
      ok: false,
      error: "Error interno del servidor",
      detalle: error.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`Servidor funcionando en puerto ${PORT}`);
});
