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

async function getJson(url) {
  const response = await fetch(url);
  const text = await response.text();

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Respuesta no JSON. HTTP ${response.status}. ${text.slice(0, 120)}`);
  }
}

function distanciaMetros(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = x => x * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) ** 2;

  return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

function clasificarServicio(categorias = []) {
  const cats = categorias.join("|");

  if (cats.includes("healthcare.pharmacy")) return "Farmacia";
  if (cats.includes("education.school")) return "Colegio";
  if (cats.includes("education.university")) return "Universidad";
  if (cats.includes("commercial.supermarket")) return "Supermercado";
  if (cats.includes("healthcare.hospital")) return "Hospital";
  if (cats.includes("healthcare.clinic_or_praxis")) return "Clínica";
  if (cats.includes("catering.restaurant")) return "Restaurante";
  if (cats.includes("leisure.park")) return "Parque";
  if (cats.includes("public_transport")) return "Transporte público";

  return "Servicio";
}

function limpiarDireccion(p = {}) {
  return (
    p.formatted ||
    p.address_line2 ||
    p.address_line1 ||
    [
      p.street,
      p.housenumber,
      p.postcode,
      p.city,
      p.county,
      p.state
    ].filter(Boolean).join(", ") ||
    null
  );
}

function scoreEntorno(aire, serviciosResumen) {
  let scoreAire = 10;

  if (aire.pm2_5 !== null && aire.pm2_5 > 25) scoreAire -= 3;
  else if (aire.pm2_5 !== null && aire.pm2_5 > 15) scoreAire -= 1.5;

  if (aire.pm10 !== null && aire.pm10 > 50) scoreAire -= 2;
  else if (aire.pm10 !== null && aire.pm10 > 25) scoreAire -= 1;

  if (aire.no2 !== null && aire.no2 > 40) scoreAire -= 1.5;
  if (aire.ozono !== null && aire.ozono > 120) scoreAire -= 1.5;

  scoreAire = Math.max(0, scoreAire);

  const totalServicios =
    serviciosResumen.farmacias +
    serviciosResumen.colegios +
    serviciosResumen.supermercados +
    serviciosResumen.hospitales +
    serviciosResumen.clinicas +
    serviciosResumen.parques +
    serviciosResumen.transporte +
    serviciosResumen.restaurantes;

  const scoreServicios = Math.min(10, totalServicios * 0.9);

  const final = (scoreAire * 0.55) + (scoreServicios * 0.45);

  let color = "verde";
  let lectura = "Entorno favorable con los datos disponibles.";

  if (final < 5) {
    color = "rojo";
    lectura = "Entorno con condicionantes relevantes.";
  } else if (final < 7) {
    color = "naranja";
    lectura = "Entorno aceptable, pero con matices.";
  }

  return {
    score: Number(final.toFixed(1)),
    color,
    lectura
  };
}

app.get("/entorno", async (req, res) => {
  try {
    const direccion = req.query.direccion;
    const radio = Number(req.query.radio || 1000);

    if (!direccion) {
      return res.json({ ok: false, error: "Debe indicar una dirección." });
    }

    const geoUrl =
      `https://api.geoapify.com/v1/geocode/search` +
      `?text=${encodeURIComponent(direccion)}` +
      `&filter=countrycode:es` +
      `&bias=countrycode:es` +
      `&limit=1` +
      `&apiKey=${encodeURIComponent(GEOAPIFY_KEY)}`;

    const geoData = await getJson(geoUrl);

    if (!geoData.features || !geoData.features.length) {
      return res.json({ ok: false, error: "No se ha podido localizar la dirección en España." });
    }

    const geo = geoData.features[0];
    const lon = geo.geometry.coordinates[0];
    const lat = geo.geometry.coordinates[1];

    const direccionLocalizada = geo.properties.formatted || direccion;

    const airUrl =
      `https://air-quality-api.open-meteo.com/v1/air-quality` +
      `?latitude=${lat}` +
      `&longitude=${lon}` +
      `&current=pm2_5,pm10,european_aqi,nitrogen_dioxide,ozone,carbon_monoxide,sulphur_dioxide` +
      `&timezone=auto`;

    const airData = await getJson(airUrl);

    const meteoUrl =
      `https://api.open-meteo.com/v1/forecast` +
      `?latitude=${lat}` +
      `&longitude=${lon}` +
      `&current=uv_index,uv_index_clear_sky,temperature_2m,relative_humidity_2m,wind_speed_10m` +
      `&timezone=auto`;

    const meteoData = await getJson(meteoUrl);

    const cAir = airData.current || {};
    const cMeteo = meteoData.current || {};

    const aire = {
      pm2_5: cAir.pm2_5 ?? null,
      pm10: cAir.pm10 ?? null,
      aqi_europeo: cAir.european_aqi ?? null,
      no2: cAir.nitrogen_dioxide ?? null,
      ozono: cAir.ozone ?? null,
      co: cAir.carbon_monoxide ?? null,
      so2: cAir.sulphur_dioxide ?? null
    };

    const radiacion = {
      uv_index: cMeteo.uv_index ?? null,
      uv_index_cielo_despejado: cMeteo.uv_index_clear_sky ?? null
    };

    const meteo = {
      temperatura: cMeteo.temperature_2m ?? null,
      humedad_relativa: cMeteo.relative_humidity_2m ?? null,
      viento: cMeteo.wind_speed_10m ?? null
    };

    const categories = [
      "healthcare.pharmacy",
      "education.school",
      "education.university",
      "commercial.supermarket",
      "healthcare.hospital",
      "healthcare.clinic_or_praxis",
      "catering.restaurant",
      "leisure.park",
      "public_transport"
    ].join(",");

    const placesUrl =
      `https://api.geoapify.com/v2/places` +
      `?categories=${encodeURIComponent(categories)}` +
      `&filter=${encodeURIComponent(`circle:${lon},${lat},${radio}`)}` +
      `&bias=${encodeURIComponent(`proximity:${lon},${lat}`)}` +
      `&limit=60` +
      `&apiKey=${encodeURIComponent(GEOAPIFY_KEY)}`;

    const placesData = await getJson(placesUrl);

    const serviciosResumen = {
      farmacias: 0,
      colegios: 0,
      universidades: 0,
      supermercados: 0,
      hospitales: 0,
      clinicas: 0,
      restaurantes: 0,
      parques: 0,
      transporte: 0
    };

    const servicios = (placesData.features || []).map((p) => {
      const props = p.properties || {};
      const categorias = props.categories || [];
      const tipo = clasificarServicio(categorias);
      const direccionServicio = limpiarDireccion(props);

      if (tipo === "Farmacia") serviciosResumen.farmacias++;
      if (tipo === "Colegio") serviciosResumen.colegios++;
      if (tipo === "Universidad") serviciosResumen.universidades++;
      if (tipo === "Supermercado") serviciosResumen.supermercados++;
      if (tipo === "Hospital") serviciosResumen.hospitales++;
      if (tipo === "Clínica") serviciosResumen.clinicas++;
      if (tipo === "Restaurante") serviciosResumen.restaurantes++;
      if (tipo === "Parque") serviciosResumen.parques++;
      if (tipo === "Transporte público") serviciosResumen.transporte++;

      const serviceLon = p.geometry?.coordinates?.[0];
      const serviceLat = p.geometry?.coordinates?.[1];

      return {
        nombre: props.name || tipo,
        tipo,
        direccion: direccionServicio || "Dirección no disponible",
        tiene_direccion: Boolean(direccionServicio),
        distancia_m: serviceLat && serviceLon ? distanciaMetros(lat, lon, serviceLat, serviceLon) : null,
        categorias
      };
    }).sort((a, b) => {
      if (a.distancia_m === null) return 1;
      if (b.distancia_m === null) return -1;
      return a.distancia_m - b.distancia_m;
    });

    const serviciosConDireccion = servicios.filter(s => s.tiene_direccion);
    const serviciosSinDireccion = servicios.filter(s => !s.tiene_direccion);

    const scoring = scoreEntorno(aire, serviciosResumen);

    res.json({
      ok: true,
      fuente: {
        geocodificacion: "Geoapify",
        servicios: "Geoapify Places / OpenStreetMap",
        aire: "Open-Meteo Air Quality",
        uv_meteo: "Open-Meteo Forecast"
      },
      direccion_solicitada: direccion,
      direccion_localizada: direccionLocalizada,
      coordenadas: { lat, lon },
      radio_m: radio,
      aire,
      radiacion,
      meteo,
      servicios_resumen: serviciosResumen,
      servicios,
      servicios_con_direccion: serviciosConDireccion,
      servicios_sin_direccion: serviciosSinDireccion.length,
      scoring
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
