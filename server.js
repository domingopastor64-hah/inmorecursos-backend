import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const GEOAPIFY_KEY = process.env.GEOAPIFY_KEY || "";

// 🔵 Test
app.get("/", (req, res) => {
  res.send("Backend InmoRecursos funcionando correctamente");
});

// 🔵 fetch seguro
async function getJson(nombre, url) {
  const response = await fetch(url);
  const text = await response.text();

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${nombre} no devuelve JSON válido`);
  }
}

// 🔵 Geocode España
async function geocode(direccion) {
  const url =
    `https://api.geoapify.com/v1/geocode/search` +
    `?text=${encodeURIComponent(direccion)}` +
    `&filter=countrycode:es` +
    `&bias=countrycode:es` +
    `&limit=1` +
    `&apiKey=${GEOAPIFY_KEY}`;

  const data = await getJson("Geoapify", url);

  const f = data.features?.[0];
  if (!f) throw new Error("Dirección no encontrada");

  return {
    lat: Number(f.properties.lat),
    lon: Number(f.properties.lon),
    display_name: f.properties.formatted
  };
}

// 🔵 SCORING
function calcularScoring(aire, servicios) {

  let scoreAire = 10;

  if (aire.pm2_5 > 25) scoreAire = 3;
  else if (aire.pm2_5 > 15) scoreAire = 6;

  let scoreServicios = Math.min(
    10,
    (servicios.supermercados +
     servicios.farmacias +
     servicios.colegios +
     servicios.hospitales) / 2
  );

  let scoreUV = aire.uv > 7 ? 5 : 8;

  const scoreFinal = (
    scoreAire * 0.4 +
    scoreServicios * 0.4 +
    scoreUV * 0.2
  );

  let color = "verde";
  if (scoreFinal < 5) color = "rojo";
  else if (scoreFinal < 7) color = "naranja";

  return {
    score: Number(scoreFinal.toFixed(1)),
    color,
    lectura:
      color === "verde"
        ? "Entorno favorable para vivir"
        : color === "naranja"
        ? "Entorno aceptable con matices"
        : "Entorno con condicionantes"
  };
}

// 🔵 ENDPOINT
app.post("/analizar-entorno", async (req, res) => {
  try {
    const { direccion, radio = 1000 } = req.body;

    const geo = await geocode(direccion);
    const { lat, lon } = geo;

    // Aire
    const airData = await getJson(
      "Aire",
      `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat}&longitude=${lon}&current=pm2_5,pm10,european_aqi&timezone=auto`
    );

    const aire = {
      pm2_5: airData.current.pm2_5,
      pm10: airData.current.pm10,
      aqi: airData.current.european_aqi
    };

    // UV
    const uvData = await getJson(
      "UV",
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=uv_index&timezone=auto`
    );

    aire.uv = uvData.current.uv_index;

    // Servicios
    const servData = await getJson(
      "Servicios",
      `https://api.geoapify.com/v2/places?categories=commercial.supermarket,healthcare.pharmacy,education.school,healthcare.hospital&filter=circle:${lon},${lat},${radio}&limit=20&apiKey=${GEOAPIFY_KEY}`
    );

    let resumen = {
      supermercados: 0,
      farmacias: 0,
      colegios: 0,
      hospitales: 0
    };

    const servicios = servData.features.map(f => {
      const cat = f.properties.categories;

      if (cat.includes("commercial.supermarket")) resumen.supermercados++;
      if (cat.includes("healthcare.pharmacy")) resumen.farmacias++;
      if (cat.includes("education.school")) resumen.colegios++;
      if (cat.includes("healthcare.hospital")) resumen.hospitales++;

      return {
        nombre: f.properties.name || "Servicio"
      };
    });

    // 🔥 SCORING
    const scoring = calcularScoring(aire, resumen);

    res.json({
      ok: true,
      direccion: geo.display_name,
      aire,
      servicios_resumen: resumen,
      scoring
    });

  } catch (e) {
    res.status(500).json({
      ok: false,
      error: e.message
    });
  }
});

app.listen(PORT, () => console.log("Servidor activo"));
