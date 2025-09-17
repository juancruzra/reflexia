// api/visual.js — Genera insight + fábula y guarda en Vercel Postgres
import OpenAI from "openai";
import { sql } from "@vercel/postgres";
import { randomUUID } from "crypto";

const MODEL = process.env.MODEL || "gpt-4o-mini";

function buildSystemPrompt() {
  return `
Eres un coach reflexivo en español rioplatense. Habla de manera cálida, concreta y empática, nunca como oráculo ni terapeuta.

El usuario te da:
- Una pregunta o inquietud personal (texto libre).
- Tres cartas visuales que eligió (solo los nombres sirven como disparador, no los repitas literalmente).
- Notas breves que escribió sobre lo que sintió o pensó al ver las cartas.

Tu tarea es devolver SOLO JSON con dos campos:

{
  "insight": "...",
  "miniStory": "..."
}

### Reglas para "insight"
- Escribe 2–3 párrafos (7–10 líneas en total).
- Usa segunda persona (“vos”).
- Reformula brevemente la pregunta del usuario.
- Refleja tensiones, recursos internos y posibilidades de acción.
- Sé práctico y cercano, como un coach: ofrecé invitaciones o preguntas, no mandatos.
- Cerrá con una pregunta poderosa o reflexión abierta.

### Reglas para "miniStory"
- Escribe una fábula o cuento de 180–350 palabras.
- Debe tener inicio, desarrollo y desenlace claros.
- Usa personajes simples (viajero, jardinera, farero, ave, niño, artesana).
- Crea una escena concreta y visual (bosque, mar, montaña, ciudad, taller).
- El aprendizaje debe emerger del relato, no de explicaciones forzadas.
- Está estrictamente prohibido que uses las cartas y sus símbolos de forma literal en la fábula. La fábula es para ver el caso desde otra mirada.
- Cerrá SIEMPRE con esta línea final en mayúsculas:
  "MORALEJA: <frase breve, amable y accionable>"

Devolvé SOLO JSON válido con claves "insight" y "miniStory". Comillas dobles en todo. Sin texto extra fuera del JSON.
`.trim();
}

function extractJSON(resObj) {
  // Responses API: intentar json nativo
  try {
    const out = resObj.output || [];
    for (const block of out) {
      for (const item of (block.content || [])) {
        if (item.type === "json" && item.json) return item.json;
      }
    }
  } catch {}
  // Fallback: texto
  const txt = (resObj.output_text || "").trim();
  if (!txt) throw new Error("Respuesta vacía de IA");
  const fence = txt.match(/```json\s*([\s\S]*?)```/i);
  const raw = fence ? fence[1] : txt;
  try { return JSON.parse(raw); } catch {}
  // Reparación mínima
  const fixed = raw
    .replace(/([{,]\s*)([A-Za-z0-9_]+)\s*:/g, '$1"$2":')
    .replace(/'/g, '"');
  return JSON.parse(fixed);
}

function getAnonId(req, res) {
  // leer o setear cookie anon_id
  const cookie = req.headers.cookie || "";
  const m = cookie.match(/anon_id=([a-f0-9-]+)/i);
  if (m) return m[1];
  const id = randomUUID();
  res.setHeader("Set-Cookie", `anon_id=${id}; Path=/; Max-Age=31536000; SameSite=Lax; Secure`);
  return id;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { question = "", cards = [], notes = [] } = req.body || {};
    if (!question || !Array.isArray(cards) || cards.length !== 3)
      return res.status(400).json({ error: "Payload inválido" });

    const anonId = getAnonId(req, res);
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const user = `
Pregunta: ${JSON.stringify(question)}
Cartas elegidas (nombres):
${cards.map((c, i) => `${i + 1}) ${c.name}`).join("\n")}
Notas del usuario:
${notes.map(n => `- ${n.note}`).join("\n")}
`.trim();

    // 1) IA
    const schema = {
      type: "object",
      properties: { insight: { type: "string" }, miniStory: { type: "string" } },
      required: ["insight", "miniStory"],
      additionalProperties: false
    };

    const ai = await client.responses.create({
  model: MODEL,
  instructions: buildSystemPrompt(),
  input: user,
  modalities: ["text"],
  text: {
    format: "json_schema",
    json_schema: {
      name: "ReflexiaV2",
      schema,
      strict: true
    }
  }
});

    const out = extractJSON(ai);
    const insight = (out.insight || "").trim();
    const miniStory = (out.miniStory || "").trim();
    if (!insight || !miniStory) throw new Error("IA devolvió vacío");

    // 2) Guardar en DB (transacción simple)
    const { rows } = await sql`
      insert into sessions (id, anon_id, question, insight, mini_story)
      values (${randomUUID()}, ${anonId}::uuid, ${question}, ${insight}, ${miniStory})
      returning id
    `;
    const sessionId = rows[0].id;

    // cartas
    for (let i = 0; i < cards.length; i++) {
      const c = cards[i];
      await sql`
        insert into session_cards (id, session_id, name, image_path, position)
        values (${randomUUID()}, ${sessionId}, ${c.name}, ${c.image_path || null}, ${i + 1})
      `;
    }
    // notas
    for (const n of notes) {
      if ((n.note || "").trim()) {
        await sql`
          insert into session_notes (id, session_id, card_name, note)
          values (${randomUUID()}, ${sessionId}, ${n.name || n.card_name || ""}, ${n.note})
        `;
      }
    }

    // 3) Responder al front
    return res.status(200).json({ insight, miniStory, sessionId });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e?.message || "AI/DB error" });
  }
}
