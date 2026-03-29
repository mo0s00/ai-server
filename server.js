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

    const data = await response.json();

    // 🔥 디버그 출력
    console.log("OPENAI RAW:", JSON.stringify(data));

    // 🔥 안전 처리
    if (data.error) {
      return res.status(500).json({ error: data.error.message });
    }

    if (!data.choices || !data.choices[0]) {
      return res.status(500).json({ error: "no choices", data });
    }

    res.json({
      text: data.choices[0].message.content || "응답 없음",
    });

  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "server error", detail: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("server running on " + PORT);
});