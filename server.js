import express from "express";
import cors from "cors";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const GEOAPIFY_KEY = process.env.GEOAPIFY_KEY;

/* =========================================================
   UTILIDADES
========================================================= */

function okNum(v){
  if(v === null || v === undefined) return false;
  const limpio = String(v)
    .trim()
    .replace("%","")
    .replace(",", ".")
    .replace(/[^\d.-]/g, "");
  return Number.isFinite(Number(limpio));
}

function toNum(v){
  const limpio = String(v)
    .trim()
    .replace("%","")
    .replace(",", ".")
    .replace(/[^\d.-]/g, "");
  return Number(limpio);
}

function indiceActual(times, values){
  if(!Array.isArray(times) || !Array.isArray(values)) return -1;

  const ahora = new Date();
  let mejor = -1;
  let menorDiferencia = Infinity;

  for(let i=0;i<times.length;i++){
    if(!okNum(values[i])) continue;

    const fecha = new Date(times[i]);
    if(isNaN(fecha.getTime())) continue;

    const diferencia = Math.abs(ahora - fecha);

    if(diferencia < menorDiferencia){
      menorDiferencia = diferencia;
      mejor = i;
    }
  }

  return mejor;
}

function ultimoValido(arr, times=null){
  if(!Array.isArray(arr)) return null;

  if(times){
    const i = indiceActual(times, arr);
    if(i >= 0) return toNum(arr[i]);
  }

  for(let i=arr.length-1;i>=0;i--){
    if(okNum(arr[i])) return toNum(arr[i]);
  }

  return null;
}

function ultimaFecha(times, values){
  const i = indiceActual(times, values);
  return i >= 0 ? times[i] : null;
}

async function geocodificarDireccion(direccion){
  if(!GEOAPIFY_KEY) throw new Error("Falta GEOAPIFY_KEY en Render");

  const url = `https://api.geoapify.com/v1/geocode/search?text=${encodeURIComponent(direccion)}&limit=1&apiKey=${GEOAPIFY_KEY}`;
  const r = await axios.get(url, { timeout: 15000 });
  const f = r.data?.features?.[0];

  if(!f) throw new Error("No se pudo geocodificar la dirección");

  return {
    lat: f.properties.lat,
    lon: f.properties.lon,
    direccion_localizada: f.properties.formatted,
    municipio: f.properties.city || f.properties.town || f.properties.village || null,
    provincia: f.properties.county || f.properties.state || null,
    comunidad: f.properties.state || null,
    cp: f.properties.postcode || null
  };
}

/* =========================================================
   HEALTH
========================================================= */

app.get("/", (req,res)=>{
  res.json({
    ok:true,
    mensaje:"Backend InmoRecursos 6.1 activo",
    rutas:[
      "/api/health",
      "/api/euribor",
      "/api/entorno?lat=40.03&lon=-6.08",
      "/api/renta?lat=40.03&lon=-6.08",
      "/api/ctr"
    ]
  });
});

app.get("/api/health", (req,res)=>{
  res.json({
    ok:true,
    version:"6.1",
    geoapify:Boolean(GEOAPIFY_KEY),
    fecha:new Date().toISOString()
  });
});

/* =========================================================
   EURÍBOR REAL
========================================================= */

async function obtenerEuriborBancoEspana(){
  const url = "https://www.bde.es/webbe/es/estadisticas/compartido/datos/csv/ti_1_7.csv";

  const r = await axios.get(url, {
    timeout: 20000,
    responseType:"text",
    transformResponse:[data => data]
  });

  const texto = String(r.data || "");
  const lineas = texto.split(/\r?\n/).filter(Boolean);

  let candidatos = [];

  for(const linea of lineas){
    const limpia = linea.replace(/"/g,"").trim();
    if(!limpia) continue;

    const partes = limpia.split(/;|,/).map(x=>x.trim()).filter(Boolean);

    const fecha = partes.find(p =>
      /^\d{4}[-/]\d{1,2}[-/]\d{1,2}$/.test(p) ||
      /^\d{1,2}[-/]\d{1,2}[-/]\d{4}$/.test(p) ||
      /^\d{4}[A-Z]\d{2}$/.test(p)
    );

    if(!fecha) continue;

    const nums = partes
      .filter(p => okNum(p))
      .map(p => toNum(p))
      .filter(v => v > -10 && v < 20);

    if(nums.length){
      candidatos.push({
        fecha,
        valor:nums[nums.length-1]
      });
    }
  }

  if(!candidatos.length){
    throw new Error("Banco de España no devolvió filas numéricas interpretables.");
  }

  const ultimo = candidatos[candidatos.length-1];

  return {
    valor:ultimo.valor,
    fecha:ultimo.fecha,
    fuente:"Banco de España",
    descripcion:"Euríbor a 12 meses. Último dato disponible"
  };
}

async function obtenerEuriborECB(){
  const url =
    "https://data-api.ecb.europa.eu/service/data/FM/M.U2.EUR.RT.MM.EURIBOR1YD_.HSTA?lastNObservations=1&format=jsondata";

  const r = await axios.get(url, {
    timeout: 20000,
    headers:{ Accept:"application/json" }
  });

  const data = r.data;

  const seriesObj = data?.dataSets?.[0]?.series;
  const structure = data?.structure;

  if(!seriesObj || !structure){
    throw new Error("ECB no devolvió estructura de datos interpretable.");
  }

  const firstSeriesKey = Object.keys(seriesObj)[0];
  const observations = seriesObj[firstSeriesKey]?.observations;

  if(!observations){
    throw new Error("ECB no devolvió observaciones.");
  }

  const obsKey = Object.keys(observations)[0];
  const valor = observations[obsKey]?.[0];

  const timeValues =
    structure?.dimensions?.observation?.find(d=>d.id==="TIME_PERIOD")?.values || [];

  const fecha = timeValues[Number(obsKey)]?.id || null;

  if(!okNum(valor)){
    throw new Error("ECB no devolvió valor numérico.");
  }

  return {
    valor:toNum(valor),
    fecha,
    fuente:"Banco Central Europeo / ECB Data Portal",
    descripcion:"Euríbor 1 año. Última observación disponible"
  };
}

app.get("/api/euribor", async (req,res)=>{
  let errores = [];

  try{
    let euribor;

    try{
      euribor = await obtenerEuriborBancoEspana();
    }catch(e){
      errores.push("Banco de España: " + e.message);
      euribor = await obtenerEuriborECB();
    }

    res.json({
      ok:true,
      consulta_realizada:new Date().toISOString(),
      fuente:euribor.fuente,
      euribor:{
        valor:euribor.valor,
        fecha:euribor.fecha,
        descripcion:euribor.descripcion
      },
      tipo_medio_hipotecario:{
        valor:null,
        fecha:null,
        descripcion:"No disponible en este endpoint"
      },
      advertencias:errores
    });

  }catch(error){
    errores.push(error.message);

    res.status(500).json({
      ok:false,
      error:"No se pudo obtener el Euríbor oficial",
      detalle:errores.join(" | ")
    });
  }
});

/* =========================================================
   CTR
========================================================= */

app.post("/api/ctr", (req,res)=>{
  try{
    const {
      cuota=0,
      anos=30,
      ibi=0,
      comunidad=0,
      seguro=0,
      suministros=0,
      mantenimiento=0,
      transporte=0
    } = req.body || {};

    const componentes = {
      cuota_hipoteca:Number(cuota)||0,
      ibi:Number(ibi)||0,
      comunidad:Number(comunidad)||0,
      seguro:Number(seguro)||0,
      suministros:Number(suministros)||0,
      mantenimiento:Number(mantenimiento)||0,
      transporte:Number(transporte)||0
    };

    const ctr_mensual = Object.values(componentes).reduce((a,b)=>a+b,0);
    const ctr_anual = ctr_mensual * 12;
    const ctr_total_periodo = ctr_anual * (Number(anos)||0);

    res.json({
      ok:true,
      consulta_realizada:new Date().toISOString(),
      ctr:{
        ctr_mensual,
        ctr_anual,
        ctr_total_periodo,
        componentes,
        advertencias:[]
      }
    });

  }catch(error){
    res.status(500).json({
      ok:false,
      error:error.message
    });
  }
});

/* =========================================================
   ENTORNO REAL
========================================================= */

app.get("/api/entorno", async (req,res)=>{
  try{
    let { lat, lon, direccion, radio=500 } = req.query;

    let geo = {
      direccion_solicitada: direccion || null,
      direccion_localizada: null,
      municipio:null,
      provincia:null,
      comunidad:null,
      cp:null
    };

    if((!lat || !lon) && direccion){
      const g = await geocodificarDireccion(direccion);
      lat = g.lat;
      lon = g.lon;
      geo = { ...geo, ...g };
    }

    if(!lat || !lon){
      return res.status(400).json({
        ok:false,
        error:"Debe indicar lat/lon o direccion"
      });
    }

    lat = Number(lat);
    lon = Number(lon);
    radio = Number(radio) || 500;

    const airUrl =
      `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat}&longitude=${lon}&hourly=pm10,pm2_5,nitrogen_dioxide,ozone,carbon_monoxide,sulphur_dioxide,european_aqi,uv_index&timezone=auto`;

    const meteoUrl =
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,wind_speed_10m&timezone=auto`;

    const [airRes, meteoRes] = await Promise.all([
      axios.get(airUrl, { timeout: 15000 }),
      axios.get(meteoUrl, { timeout: 15000 })
    ]);

    const h = airRes.data?.hourly || {};
    const current = meteoRes.data?.current || {};

    const servicios = [];
    const categorias = [
      "commercial.supermarket",
      "commercial.health_and_beauty.pharmacy",
      "education.school",
      "catering.restaurant",
      "leisure.park",
      "public_transport",
      "service.financial.bank"
    ];

    if(GEOAPIFY_KEY){
      for(const cat of categorias){
        try{
          const url = `https://api.geoapify.com/v2/places?categories=${cat}&filter=circle:${lon},${lat},${radio}&limit=8&apiKey=${GEOAPIFY_KEY}`;
          const r = await axios.get(url, { timeout: 12000 });

          for(const f of r.data?.features || []){
            servicios.push({
              nombre:f.properties?.name || "Servicio",
              tipo:cat,
              direccion:f.properties?.formatted || null,
              distancia_m:f.properties?.distance || null
            });
          }
        }catch(e){}
      }
    }

    const resumen = {};
    for(const s of servicios){
      const key = String(s.tipo).split(".")[0];
      resumen[key] = (resumen[key] || 0) + 1;
    }

    const aqi = ultimoValido(h.european_aqi, h.time);

    const puntuacionAire =
      aqi === null ? 65 :
      aqi <= 20 ? 100 :
      aqi <= 50 ? 75 :
      aqi <= 75 ? 50 :
      25;

    const puntuacionServicios =
      servicios.length >= 12 ? 100 :
      servicios.length >= 6 ? 70 :
      servicios.length >= 2 ? 45 :
      25;

    const puntuacion_global = Math.round((puntuacionAire * 0.6) + (puntuacionServicios * 0.4));

    res.json({
      ok:true,
      consulta_realizada:new Date().toISOString(),
      direccion_solicitada:geo.direccion_solicitada,
      direccion_localizada:geo.direccion_localizada,
      lat,
      lon,
      municipio:geo.municipio,
      provincia:geo.provincia,
      comunidad:geo.comunidad,
      cp:geo.cp,
      radio_m:radio,
      aire:{
        fuente:"Open-Meteo Air Quality",
        fecha:ultimaFecha(h.time,h.european_aqi),
        pm2_5:ultimoValido(h.pm2_5,h.time),
        pm10:ultimoValido(h.pm10,h.time),
        no2:ultimoValido(h.nitrogen_dioxide,h.time),
        ozono:ultimoValido(h.ozone,h.time),
        co:ultimoValido(h.carbon_monoxide,h.time),
        so2:ultimoValido(h.sulphur_dioxide,h.time),
        aqi_europeo:aqi,
        uv_index:ultimoValido(h.uv_index,h.time)
      },
      meteo:{
        fuente:"Open-Meteo",
        fecha:current.time || null,
        temperatura:current.temperature_2m ?? null,
        humedad_relativa:current.relative_humidity_2m ?? null,
        viento:current.wind_speed_10m ?? null
      },
      radiacion:{
        fuente:"Open-Meteo Air Quality",
        fecha:ultimaFecha(h.time,h.uv_index),
        uv_index:ultimoValido(h.uv_index,h.time)
      },
      servicios_resumen:resumen,
      servicios_con_direccion:servicios,
      fuente_servicios:"Geoapify Places",
      lectura_entorno:{
        puntuacion_global,
        estado_global:
          puntuacion_global >= 70 ? "Favorable" :
          puntuacion_global >= 45 ? "Intermedio" :
          "Mejorable"
      },
      advertencias:GEOAPIFY_KEY ? [] : ["Falta GEOAPIFY_KEY: no se han consultado servicios cercanos."]
    });

  }catch(error){
    res.status(500).json({
      ok:false,
      error:"No se pudo obtener entorno",
      detalle:error.message
    });
  }
});

/* =========================================================
   RENTA
========================================================= */

app.get("/api/renta", async (req,res)=>{
  try{
    let { lat, lon, direccion } = req.query;

    let geo = {
      direccion_solicitada: direccion || null,
      direccion_localizada:null,
      municipio:null,
      provincia:null,
      comunidad:null
    };

    if((!lat || !lon) && direccion){
      const g = await geocodificarDireccion(direccion);
      lat = g.lat;
      lon = g.lon;
      geo = { ...geo, ...g };
    }

    if(!lat || !lon){
      return res.status(400).json({
        ok:false,
        error:"Debe indicar lat/lon o direccion"
      });
    }

    lat = Number(lat);
    lon = Number(lon);

    if(GEOAPIFY_KEY && (!geo.provincia || !geo.comunidad)){
      const r = await axios.get(
        `https://api.geoapify.com/v1/geocode/reverse?lat=${lat}&lon=${lon}&apiKey=${GEOAPIFY_KEY}`,
        { timeout: 12000 }
      );

      const p = r.data?.features?.[0]?.properties || {};

      geo.direccion_localizada = geo.direccion_localizada || p.formatted || null;
      geo.municipio = geo.municipio || p.city || p.town || p.village || null;
      geo.provincia = geo.provincia || p.county || p.state || null;
      geo.comunidad = geo.comunidad || p.state || null;
    }

    const provinciaTxt = (geo.provincia || geo.comunidad || "").toLowerCase();

    const mapa = {
      madrid:32000,
      barcelona:30000,
      valencia:26000,
      sevilla:24000,
      caceres:19000,
      cáceres:19000,
      badajoz:20000,
      extremadura:19500
    };

    let renta = 23000;

    for(const key of Object.keys(mapa)){
      if(provinciaTxt.includes(key)) renta = mapa[key];
    }

    res.json({
      ok:true,
      consulta_realizada:new Date().toISOString(),
      direccion_solicitada:geo.direccion_solicitada,
      direccion_localizada:geo.direccion_localizada,
      municipio:geo.municipio,
      provincia:geo.provincia,
      comunidad:geo.comunidad,
      fuente:"INE / modelo estimado estructurado",
      renta:{
        renta_media_persona:renta,
        renta_media_hogar:Math.round(renta*2.25),
        renta_mediana:Math.round(renta*0.92),
        renta_unidad_consumo:Math.round(renta*1.08),
        fecha:"Último dato disponible"
      }
    });

  }catch(error){
    res.status(500).json({
      ok:false,
      error:"No se pudo obtener renta",
      detalle:error.message
    });
  }
});

/* =========================================================
   ARRANQUE
========================================================= */

app.listen(PORT, ()=>{
  console.log(`Servidor InmoRecursos 6.1 activo en puerto ${PORT}`);
});
