import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
app.use(cors());
app.use(express.json());

const GEOAPIFY_KEY = "PON_AQUI_TU_API_KEY";

app.post("/analizar-entorno", async (req, res) => {

  const direccion = req.body.direccion;

  const geo = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${direccion}`);
  const geoData = await geo.json();

  if (!geoData.length) return res.json({error:"Dirección no encontrada"});

  const lat = geoData[0].lat;
  const lon = geoData[0].lon;

  const air = await fetch(`https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat}&longitude=${lon}&current=pm2_5,pm10,european_aqi,uv_index`);
  const airData = await air.json();

  res.json({
    coordenadas:{lat,lon},
    aire:airData.current
  });

});

app.listen(3000,()=>console.log("Servidor listo"));
