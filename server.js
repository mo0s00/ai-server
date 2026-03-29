const express = require("express");
const fetch = require("node-fetch");

const app = express();
app.use(express.json());

const OPENAI_KEY = process.env.OPENAI_KEY;

app.post("/comment", async (req, res) => {
  try {
    const { prompt } = req.body;

    if (!prompt) {
      return res.status(400).json({ error: "prompt required" });
    }

    if (!OPENAI_KEY) {
      return res.status(500).json({ error: "OPENAI_KEY missing" });
    }

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${OPENAI_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: "댓글 작성" },
          { role: "user", content: prompt },
        ],
        max_tokens: 200,
      }),
    });

    // 🔥 상태 로그
    console.log("FETCH STATUS:", response.status);

    const text = await response.text();
    console.log("RAW:", text);

    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      return res.status(500).json({ error: "JSON parse error", raw: text });
    }

    if (data.error) {
      return res.status(500).json({ error: data.error.message });
    }

    const content =
      data?.choices?.[0]?.message?.content || "응답 없음";

    res.json({ text: content });

  } catch (e) {
    console.error("SERVER ERROR:", e);
    res.status(500).json({ error: "server error", detail: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("server running on " + PORT);
});