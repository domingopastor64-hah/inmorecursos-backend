/* =========================================================
   SERVER.JS · PUNTOS DE CONTROL INMORECURSOS
   Backend REAL y estable
   ========================================================= */

import express from "express";
import cors from "cors";
import axios from "axios";
import dotenv from "dotenv";
import xml2js from "xml2js";

dotenv.config();

const app = express();

app.use(cors({
  origin: "*"
}));

app.use(express.json());

const PORT = process.env.PORT || 3000;

/* =========================================================
   HELPERS
   ========================================================= */

function ok(res, data){
  res.json({
    ok:true,
    fuente:data.fuente || null,
    actualizado:data.actualizado || null,
    data
  });
}

function fail(res, fuente, error){
  res.json({
    ok:false,
    fuente,
    error:error?.message || "No disponible"
  });
}

function number(v){
  const n = Number(v);
  return isNaN(n) ? null : n;
}

/* =========================================================
   HEALTH
   ========================================================= */

app.get("/", (_,res)=>{
  res.json({
    proyecto:"InmoRecursos · Puntos de Control",
    estado:"activo",
    endpoints:[
      "/api/openmeteo",
      "/api/catastro",
      "/api/ine-renta",
      "/api/euribor",
      "/api/ipv"
    ]
  });
});

/* =========================================================
   OPEN METEO
   SIN CLAVE · DATOS REALES
   ========================================================= */

app.get("/api/openmeteo", async (req,res)=>{

  try{

    const lat = req.query.lat;
    const lon = req.query.lon;

    if(!lat || !lon){
      return fail(res,"OPEN-METEO",new Error("Faltan coordenadas"));
    }

    const url = `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat}&longitude=${lon}&hourly=pm10,pm2_5,nitrogen_dioxide,ozone,uv_index&timezone=auto`;

    const response = await axios.get(url,{
      timeout:15000
    });

    const h = response.data.hourly;

    const last = h.time.length - 1;

    ok(res,{
      fuente:"Open-Meteo",
      actualizado:h.time[last],
      aire:{
        pm10:number(h.pm10[last]),
        pm25:number(h.pm2_5[last]),
        no2:number(h.nitrogen_dioxide[last]),
        o3:number(h.ozone[last]),
        uvi:number(h.uv_index[last])
      }
    });

  }catch(error){

    fail(res,"OPEN-METEO",error);

  }

});

/* =========================================================
   CATASTRO
   SERVICIO OFICIAL XML
   ========================================================= */

app.get("/api/catastro", async (req,res)=>{

  try{

    const rc = req.query.rc;

    if(!rc){
      return fail(res,"CATASTRO",new Error("Falta referencia catastral"));
    }

    const url =
      `https://ovc.catastro.meh.es/ovcservweb/OVCSWLocalizacionRC/OVCCallejero.asmx/Consulta_DNPRC?RefCat=${rc}`;

    const response = await axios.get(url,{
      timeout:20000
    });

    const parser = new xml2js.Parser({
      explicitArray:false
    });

    const parsed = await parser.parseStringPromise(response.data);

    const consulta =
      parsed?.consulta_dnprc_result ||
      parsed;

    ok(res,{
      fuente:"Dirección General del Catastro",
      actualizado:new Date().toISOString(),
      raw:consulta
    });

  }catch(error){

    fail(res,"CATASTRO",error);

  }

});

/* =========================================================
   INE · RENTA
   TABLA 30896
   ========================================================= */

app.get("/api/ine-renta", async (req,res)=>{

  try{

    const municipio = req.query.municipio;

    if(!municipio){
      return fail(res,"INE",new Error("Falta municipio"));
    }

    const url =
      "https://servicios.ine.es/wstempus/js/es/DATOS_TABLA/30896?tip=AM";

    const response = await axios.get(url,{
      timeout:20000
    });

    const valores = response.data?.Data || [];

    const encontrados = valores.filter(v =>
      JSON.stringify(v).toLowerCase()
      .includes(municipio.toLowerCase())
    );

    if(!encontrados.length){

      return fail(res,"INE",new Error("Municipio no encontrado"));

    }

    ok(res,{
      fuente:"INE",
      actualizado:new Date().toISOString(),
      resultados:encontrados.slice(0,10)
    });

  }catch(error){

    fail(res,"INE",error);

  }

});

/* =========================================================
   EURIBOR · BANCO DE ESPAÑA
   ========================================================= */

app.get("/api/euribor", async (_,res)=>{

  try{

    const serie =
      "https://api.bde.es/clientebanca/api/v1/series/tiempo/EURIBOR12M/datos";

    const response = await axios.get(serie,{
      timeout:20000,
      headers:{
        Accept:"application/json"
      }
    });

    ok(res,{
      fuente:"Banco de España",
      actualizado:new Date().toISOString(),
      euribor:response.data
    });

  }catch(error){

    fail(res,"BANCO DE ESPAÑA",error);

  }

});

/* =========================================================
   IPV · INE
   ÍNDICE PRECIOS VIVIENDA
   ========================================================= */

app.get("/api/ipv", async (_,res)=>{

  try{

    const csv =
      "https://www.ine.es/jaxiT3/files/t/es/csv_bdsc/2186.csv";

    const response = await axios.get(csv,{
      timeout:20000
    });

    ok(res,{
      fuente:"INE",
      actualizado:new Date().toISOString(),
      csv:response.data
    });

  }catch(error){

    fail(res,"INE IPV",error);

  }

});

/* =========================================================
   ERRORES
   ========================================================= */

app.use((err,req,res,next)=>{

  console.error(err);

  res.status(500).json({
    ok:false,
    error:"Error interno servidor"
  });

});

/* =========================================================
   START
   ========================================================= */

app.listen(PORT,()=>{

  console.log(`
=================================================
 INMORECURSOS · PUNTOS DE CONTROL
 Backend operativo
 Puerto: ${PORT}
=================================================
`);

});
