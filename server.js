app.get("/test-ruta", (req, res) => {
  res.json({ mensaje: "RUTA OK" });
});
import express from "express";
import cors from "cors";

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());

app.get("/", (req, res) => {
  res.send("FUNCIONA");
});

app.get("/health", (req, res) => {
  res.send("OK");
});

app.get("/api/test", (req, res) => {
  res.json({ mensaje: "Backend funcionando correctamente" });
});

app.use((req, res) => {
  res.status(404).send("NO_EXISTE_RUTA");
});

app.listen(PORT, () => {
  console.log("Servidor activo");
});
